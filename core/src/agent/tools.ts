// Traces: BASED-AGENT-SCHEMA-CTX, BASED-AGENT-SAMPLE, BASED-AGENT-RUNQUERY, BASED-AGENT-AUDIT
// The agent's server tools, bound to the live session adapter. Read-only by construction: there is
// no tool here that runs DML/DDL — mutations go through the approval-gated endpoint (see server.ts).
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { MssqlAdapter } from "../db/mssqlAdapter";
import { isReadOnly } from "../db/classify";
import { collectQuery, AGENT_ROW_CAP } from "./runSql";
import type { AuditStore } from "./audit";

/** Rows returned to the model per result set — kept small to protect the model's context window
 *  (the full capped set still streams to the UI when the user runs SQL themselves). */
const TOOL_PREVIEW_ROWS = 50;

export interface ToolDeps {
  /** Returns the current session adapter, or throws if no connection is active. */
  getAdapter: () => MssqlAdapter;
  connectionId: () => string;
  database: () => string;
  audit: AuditStore;
}

const IDENT = /^[A-Za-z0-9_ ]+$/;

function auditRead(deps: ToolDeps, sql: string, status: "ok" | "error", durationMs: number, error: string | null): void {
  deps.audit.add({
    connectionId: deps.connectionId(),
    database: deps.database(),
    kind: "read",
    sql,
    approved: false,
    startedAt: new Date().toISOString(),
    durationMs,
    status,
    error,
  });
}

export function buildAgentTools(deps: ToolDeps) {
  const getSchema = createTool({
    id: "get_schema",
    description:
      "Inspect the database schema. With no argument, returns all user objects (tables, views, procedures, functions) with their schema names. With a table name, returns that table's columns (name, type, nullability, primary/foreign key). Returns schema only — never row data.",
    inputSchema: z.object({
      table: z.string().optional().describe("Table or view name to get columns for; omit to list all objects"),
      schema: z.string().optional().describe("Schema of the table (defaults to dbo)"),
    }),
    execute: async ({ table, schema }) => {
      const adapter = deps.getAdapter();
      if (!table) {
        const objects = await adapter.listObjects();
        return { objects };
      }
      const columns = await adapter.getTableColumns(schema ?? "dbo", table);
      return { schema: schema ?? "dbo", table, columns };
    },
  });

  const sampleRows = createTool({
    id: "sample_rows",
    description:
      "Return a small sample of rows from a table or view (the only tool that returns row data). Use when you need to see example values. Rows are capped.",
    inputSchema: z.object({
      table: z.string().describe("Table or view name"),
      schema: z.string().optional().describe("Schema (defaults to dbo)"),
      limit: z.number().int().optional().describe("Max rows (1-100, default 20)"),
    }),
    execute: async ({ table, schema, limit }) => {
      const schemaName = schema ?? "dbo";
      if (!IDENT.test(table) || !IDENT.test(schemaName)) {
        return { error: "Invalid identifier — schema/table may contain only letters, digits, spaces, and underscores." };
      }
      const n = Math.max(1, Math.min(100, Math.floor(limit ?? 20)));
      const sql = `SELECT TOP (${n}) * FROM [${schemaName}].[${table}]`;
      const result = await collectQuery(deps.getAdapter(), sql);
      auditRead(deps, sql, result.status === "ok" ? "ok" : "error", result.durationMs, result.errors[0] ?? null);
      const rs = result.resultSets[0];
      if (!rs) return { error: result.errors[0] ?? "No rows returned", rows: [] };
      return { columns: rs.columns.map((c) => c.name), rows: rs.rows.slice(0, n), rowCount: rs.rowCount };
    },
  });

  const runQuery = createTool({
    id: "run_query",
    description:
      "Execute a read-only SQL query (SELECT or a WITH/CTE that selects) and return the results. Mutating statements (INSERT/UPDATE/DELETE/DDL/EXEC) are rejected — to change data, propose the SQL to the user with the run_mutation tool for approval.",
    inputSchema: z.object({
      sql: z.string().describe("A single read-only SELECT / CTE statement"),
    }),
    execute: async ({ sql }) => {
      if (!isReadOnly(sql)) {
        return {
          refused: true,
          reason: "run_query only executes read-only SELECT/CTE statements. Use run_mutation to request approval for anything that writes.",
        };
      }
      const result = await collectQuery(deps.getAdapter(), sql, { rowCap: AGENT_ROW_CAP });
      auditRead(deps, sql, result.status === "ok" ? "ok" : "error", result.durationMs, result.errors[0] ?? null);
      if (result.status === "error") return { error: result.errors.join("; ") || "Query failed" };
      return {
        resultSets: result.resultSets.map((rs) => ({
          columns: rs.columns.map((c) => c.name),
          rows: rs.rows.slice(0, TOOL_PREVIEW_ROWS),
          rowCount: rs.rowCount,
          truncated: rs.truncated || rs.rowCount > TOOL_PREVIEW_ROWS,
          previewedRows: Math.min(rs.rows.length, TOOL_PREVIEW_ROWS),
        })),
        messages: result.messages,
        durationMs: result.durationMs,
      };
    },
  });

  return { get_schema: getSchema, sample_rows: sampleRows, run_query: runQuery };
}
