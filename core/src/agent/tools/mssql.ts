// Traces: BASED-AGENT-SAMPLE, BASED-AGENT-RUNQUERY, BASED-LANCE-AGENT-SURFACE
// The SQL-Server-specific agent tools + persona fragment. These assume T-SQL (SELECT TOP, bracket
// identifiers, the isReadOnly classifier) and only apply to MssqlAdapter sessions.
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { isReadOnly } from "../../db/classify";
import { collectQuery, AGENT_ROW_CAP } from "../runSql";
import { auditRead, type ToolDeps } from "./shared";

/** Rows returned to the model per result set — kept small to protect the model's context window
 *  (the full capped set still streams to the UI when the user runs SQL themselves). */
const TOOL_PREVIEW_ROWS = 50;

const IDENT = /^[A-Za-z0-9_ ]+$/;

/** System-prompt fragment injected for SQL Server sessions. */
export const MSSQL_PERSONA = `You are connected to a Microsoft SQL Server database. You help the user understand it and write correct T-SQL.
- run_query executes read-only SELECT/CTE statements and returns results. Use it to answer questions with real data.
- sample_rows returns a small sample of rows from a table or view when you need to see example values.
- You cannot write to the database directly. To INSERT/UPDATE/DELETE or run DDL, propose the exact SQL to the user for approval — never smuggle a mutation through run_query; it will be refused.
- Prefer SQL Server (T-SQL) syntax: TOP instead of LIMIT, square-bracket identifiers when needed, schema-qualified names (dbo.Table).
- Put every SQL statement in a \`\`\`sql fenced code block so the user can insert or run it with one click.`;

/** SQL-Server-specific tools bound to the live session adapter. */
export function mssqlTools(deps: ToolDeps) {
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

  return { sample_rows: sampleRows, run_query: runQuery };
}
