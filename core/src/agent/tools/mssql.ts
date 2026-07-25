// Traces: BASED-AGENT-SAMPLE, BASED-AGENT-RUNQUERY, BASED-LANCE-AGENT-SURFACE, BASED-SCRIPT-OBJECT
// The SQL-Server-specific agent tools + persona fragment. These assume T-SQL (SELECT TOP, bracket
// identifiers, the isReadOnly classifier) and only apply to MssqlAdapter sessions.
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { isReadOnly } from "../../db/classify";
import { scriptObject, type ScriptAction } from "../../db/scripter";
import { collectQuery, AGENT_ROW_CAP } from "../runSql";
import { auditRead, type ToolDeps } from "./shared";

/** Rows returned to the model per result set — kept small to protect the model's context window
 *  (the full capped set still streams to the UI when the user runs SQL themselves). */
const TOOL_PREVIEW_ROWS = 50;

const IDENT = /^[A-Za-z0-9_ ]+$/;

/** System-prompt fragment injected for SQL Server sessions. */
export const MSSQL_PERSONA = `You are connected to a Microsoft SQL Server database. You help the user understand it and write correct T-SQL.
- run_query executes read-only SELECT/CTE statements and returns results. Use it to answer questions with real data.
- sample_rows returns a small sample of rows from a table or view when you need to see example values; read_rows pages through a table in a stable order (with optional orderBy/filters) when you need more than a peek.
- script_object generates DDL text: CREATE TABLE (with PK/defaults/checks/FKs/indexes) for tables, the CREATE body for views/procedures/functions, plus drop/drop-create/alter/select/insert variants. It never executes — to actually run DDL, propose it through run_mutation like any other change.
- export_data writes a query result or a whole table to a CSV/XLSX file in the user's Downloads folder and returns the path.
- import_csv proposes loading a CSV file into a table: the user sees a preview/mapping card and the import only runs on their approval — like run_mutation, you never import directly.
- You cannot write to the database directly. To INSERT/UPDATE/DELETE or run DDL, propose the exact SQL to the user for approval — never smuggle a mutation through run_query; it will be refused.
- Prefer SQL Server (T-SQL) syntax: TOP instead of LIMIT, square-bracket identifiers when needed, schema-qualified names (dbo.Table).
- Put every SQL statement in its own \`\`\`sql fenced code block so the user can insert or run it with one click. Make the first line of each block a single-line comment (\`-- ...\`) briefly stating what the statement does — the UI shows it as the block's label.`;

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

  // Traces: BASED-SCRIPT-OBJECT — DDL scripting through the existing pure scripter. Returns text
  // only; executing DDL stays on the run_mutation approval gate.
  const scriptObjectTool = createTool({
    id: "script_object",
    description:
      "Generate the T-SQL script for a database object: CREATE TABLE for tables (columns, PK, defaults, checks, FKs, indexes), the CREATE body for views/procedures/functions. Actions: create (default), drop, drop-create, alter (modules only), select, insert (templates). Returns SQL text — it never executes anything; to run DDL, propose it via run_mutation.",
    inputSchema: z.object({
      name: z.string().describe("Object name (table, view, procedure, or function)"),
      schema: z.string().optional().describe("Schema (defaults to dbo)"),
      action: z
        .enum(["create", "drop", "drop-create", "alter", "select", "insert"])
        .optional()
        .describe("What to script (default create)"),
    }),
    execute: async ({ name, schema, action }) => {
      const adapter = deps.getAdapter();
      const schemaName = schema ?? "dbo";
      const act = (action ?? "create") as ScriptAction;
      const op = `script_object(${schemaName}.${name}, ${act})`;
      const t0 = performance.now();
      try {
        const objects = await adapter.listObjects();
        const obj = objects.find((o) => o.schema === schemaName && o.name === name);
        if (!obj) {
          const validNames = objects.map((o) => `${o.schema}.${o.name}`).slice(0, 200);
          return { error: `Unknown object ${schemaName}.${name}`, validNames };
        }
        let sql: string;
        if (obj.type === "table") {
          if (!adapter.getTableDetails) return { error: "This engine does not support table scripting." };
          const details = await adapter.getTableDetails(schemaName, name);
          sql = scriptObject({ kind: "table", details }, act);
        } else {
          const definition = await adapter.getObjectDefinition?.(schemaName, name);
          if (definition == null) return { error: `No definition found for ${schemaName}.${name}` };
          const type = obj.type === "view" ? "view" : obj.type === "procedure" ? "procedure" : "function";
          sql = scriptObject({ kind: "module", type, schema: schemaName, name, definition }, act);
        }
        auditRead(deps, op, "ok", Math.round(performance.now() - t0), null);
        return { schema: schemaName, name, type: obj.type, action: act, sql };
      } catch (err) {
        // Scripter invalid-combo errors (e.g. alter on a table) come back as tool errors, not throws.
        const msg = err instanceof Error ? err.message : String(err);
        auditRead(deps, op, "error", Math.round(performance.now() - t0), msg);
        return { error: msg };
      }
    },
  });

  return { sample_rows: sampleRows, run_query: runQuery, script_object: scriptObjectTool };
}
