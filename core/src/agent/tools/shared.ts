// Traces: BASED-AGENT-SCHEMA-CTX, BASED-AGENT-AUDIT, BASED-SKILL-LOAD, BASED-LANCE-AGENT-SURFACE,
//         BASED-AGENT-READ-ROWS, BASED-AGENT-EXPORT
// Engine-neutral agent tools + shared deps/helpers. Every engine's toolset includes these; the
// engine-specific tools (SQL vs vector search) live alongside in mssql.ts / lancedb.ts and are
// assembled per engine by agentSurfaceFor (see ../surface.ts).
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { DatabaseAdapter, TableFilter, TableSort } from "../../db/types";
import type { AuditStore } from "../audit";
import type { EmbeddingProfileStore } from "../../storage/embeddingProfiles";
import type { RerankerProfileStore } from "../../storage/rerankerProfiles";
import { catalog as skillCatalog, get as getSkill } from "../skills";
import { isReadOnly } from "../../db/classify";
import { exportData, sanitizeExportFileName, EXPORT_ROW_CAP } from "../../export/exportData";
import { openWithDefaultApp } from "../../dialogs";

export interface ToolDeps {
  /** Returns the current session adapter, or throws if no connection is active. */
  getAdapter: () => DatabaseAdapter;
  connectionId: () => string;
  database: () => string;
  audit: AuditStore;
  /** Present when the search tools need to resolve an embeddingProfileId/rerankerProfileId
   *  (BASED-LANCE-EMBED-PROFILES, BASED-LANCE-RERANK-PROFILES) — undefined in test/tool contexts
   *  that never pass a profile id. */
  embeddingProfiles?: EmbeddingProfileStore;
  rerankerProfiles?: RerankerProfileStore;
  getEmbeddingKey?: (id: string) => string | null;
  getRerankerKey?: (id: string) => string | null;
  /** Traces: BASED-LANCE-CONN-DEFAULT-PROFILES — the connected connection's default search profiles.
   *  Getters, not values: they re-read the connection on every call so editing it takes effect
   *  without reconnecting, and a mid-session connection switch never carries the old default over. */
  defaultEmbeddingProfileId?: () => string | null;
  defaultRerankerProfileId?: () => string | null;
  /** Where export_data writes its files. Defaults to the user's Downloads folder (falling back to
   *  the temp dir); tests inject a scratch dir so runs never touch the real Downloads. */
  exportDir?: () => string;
}

/** Record the read in the audit log. `op` is the SQL text for SQL engines, or a structured
 *  description (e.g. `vector_search(docs, k=10)`) for engines with no SQL surface. */
export function auditRead(
  deps: ToolDeps,
  op: string,
  status: "ok" | "error",
  durationMs: number,
  error: string | null,
): void {
  deps.audit.add({
    connectionId: deps.connectionId(),
    database: deps.database(),
    kind: "read",
    sql: op,
    approved: false,
    startedAt: new Date().toISOString(),
    durationMs,
    status,
    error,
  });
}

/** Tools every engine exposes: schema inspection and skill loading. `engine` drives the default
 *  schema name — "dbo" is a T-SQL convention, NOT a property of having SQL (local LanceDB has SQL
 *  via DuckDB but its "schemas" are base-folder names, where "dbo" would be a wrong guess). */
export function sharedTools(deps: ToolDeps, engine: "mssql" | "lancedb" = "mssql") {
  const getSchema = createTool({
    id: "get_schema",
    description:
      "Inspect the database schema. With no argument, returns all user objects with their schema names. With a table name, returns that table's columns (name, type, nullability, and any key/vector metadata). Returns schema only — never row data.",
    inputSchema: z.object({
      table: z.string().optional().describe("Table or view name to get columns for; omit to list all objects"),
      schema: z.string().optional().describe("Schema of the table (defaults to dbo on SQL engines)"),
    }),
    execute: async ({ table, schema }) => {
      const adapter = deps.getAdapter();
      if (!table) {
        const objects = await adapter.listObjects();
        return { objects };
      }
      const resolvedSchema = schema ?? (engine === "mssql" ? "dbo" : "");
      const columns = await adapter.getTableColumns(resolvedSchema, table);
      return { schema: resolvedSchema, table, columns };
    },
  });

  // Traces: BASED-SKILL-LOAD — progressive disclosure: the prompt advertises the catalog (name+desc);
  // the agent pulls a full skill body only when it needs it. An unknown name returns the valid list.
  const loadSkill = createTool({
    id: "load_skill",
    description:
      "Load the full instructions for one of the skills listed in your system prompt's skill catalog. Call this before acting on a skill (e.g. before drawing a diagram). Returns the skill's body text.",
    inputSchema: z.object({
      name: z.string().describe("The skill name from the catalog (e.g. \"diagrams\")"),
    }),
    execute: async ({ name }) => {
      const skill = getSkill(name);
      if (!skill) {
        return { error: `Unknown skill "${name}"`, validNames: skillCatalog().map((s) => s.name) };
      }
      return { name: skill.name, body: skill.body };
    },
  });

  // Traces: BASED-AGENT-READ-ROWS — systematic paging so the agent never pulls a whole table at
  // once. sample_rows stays as the quick-peek affordance; this is the ordered, resumable walk.
  const AGENT_PAGE_CAP = 200;
  const readRows = createTool({
    id: "read_rows",
    description:
      "Read one page of a table's rows in a stable order. Call repeatedly with an increasing offset to page through a table instead of pulling it all at once; hasMore tells you whether another page may exist. On SQL Server you may also pass orderBy and filters (validated server-side). For a quick unordered peek at example values, sample_rows is simpler.",
    inputSchema: z.object({
      table: z.string().describe("Table or view name"),
      schema: z.string().optional().describe("Schema (defaults to dbo on SQL engines)"),
      offset: z.number().int().optional().describe("Row offset to start from (default 0)"),
      limit: z.number().int().optional().describe("Rows per page (1-200, default 100)"),
      orderBy: z
        .array(z.object({ column: z.string(), dir: z.enum(["asc", "desc"]) }))
        .optional()
        .describe("Sort columns (engines with server-side ordered browse only, e.g. SQL Server)"),
      filters: z
        .array(
          z.object({
            column: z.string(),
            op: z.enum(["eq", "ne", "gt", "ge", "lt", "le", "like", "is-null", "not-null"]),
            value: z.union([z.string(), z.number()]).optional(),
          }),
        )
        .optional()
        .describe("Row filters (engines with server-side ordered browse only)"),
    }),
    execute: async ({ table, schema, offset, limit, orderBy, filters }) => {
      const adapter = deps.getAdapter();
      const resolvedSchema = schema ?? (engine === "mssql" ? "dbo" : "");
      const n = Math.max(1, Math.min(AGENT_PAGE_CAP, Math.floor(limit ?? 100)));
      const off = Math.max(0, Math.floor(offset ?? 0));
      if ((orderBy?.length || filters?.length) && !adapter.capabilities.orderedBrowse) {
        return { error: "orderBy/filters need an engine with server-side ordered browse (SQL Server). Omit them here." };
      }
      const op = `read_rows(${resolvedSchema ? `${resolvedSchema}.` : ""}${table}, offset=${off}, limit=${n})`;
      const t0 = performance.now();
      try {
        const page = await adapter.readTablePage(resolvedSchema, table, {
          offset: off,
          limit: n,
          orderBy: orderBy as TableSort[] | undefined,
          filters: filters as TableFilter[] | undefined,
        });
        auditRead(deps, op, "ok", Math.round(performance.now() - t0), null);
        return {
          columns: page.columns.map((c) => c.name),
          rows: page.rows,
          orderBy: page.orderBy,
          offset: off,
          returned: page.rows.length,
          // Heuristic — TablePage carries no total; an exactly-full final page costs one empty read.
          hasMore: page.rows.length === n,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        auditRead(deps, op, "error", Math.round(performance.now() - t0), msg);
        return { error: msg };
      }
    },
  });

  // Traces: BASED-AGENT-EXPORT — write a query result or whole table to a CSV/XLSX file. Writes
  // server-side to Downloads (no dialog can pop mid-run) and returns the path.
  const exportTool = createTool({
    id: "export_data",
    description:
      "Export data to a CSV or XLSX file on the user's machine and return the file path. Provide exactly one of `sql` (a read-only SELECT) or `table` (exports the whole table, capped at 100k rows). The file is written to the user's Downloads folder; set openAfter to open it immediately.",
    inputSchema: z.object({
      format: z.enum(["csv", "xlsx"]).describe("Output file format"),
      sql: z.string().optional().describe("A read-only SELECT to export (exactly one of sql/table)"),
      table: z.string().optional().describe("Table to export in full (exactly one of sql/table)"),
      schema: z.string().optional().describe("Schema of `table` (defaults to dbo on SQL engines)"),
      fileName: z.string().optional().describe("File name only — no directories; extension added if missing"),
      openAfter: z.boolean().optional().describe("Open the file with the OS default app after writing"),
    }),
    execute: async ({ format, sql, table, schema, fileName, openAfter }) => {
      const adapter = deps.getAdapter();
      if ((sql == null) === (table == null)) {
        return { error: "Provide exactly one of `sql` or `table`." };
      }
      if (sql != null && !isReadOnly(sql)) {
        return { refused: true, reason: "export_data only exports read-only SELECT results; nothing was run." };
      }
      const source = sql != null ? ({ kind: "sql", sql } as const) : ({ kind: "table", schema: schema ?? (engine === "mssql" ? "dbo" : ""), table: table! } as const);
      let name: string;
      try {
        const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
        name = sanitizeExportFileName(fileName ?? `based-export-${table ?? "query"}-${stamp}`, format);
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
      const downloads = join(homedir(), "Downloads");
      const targetDir = deps.exportDir?.() ?? (existsSync(downloads) ? downloads : tmpdir());
      const targetPath = join(targetDir, name);
      const op = `export_data(${format}, ${sql != null ? "sql" : `${source.kind === "table" ? `${source.schema ? `${source.schema}.` : ""}${source.table}` : ""}`} → ${targetPath})`;
      const t0 = performance.now();
      try {
        const result = await exportData(adapter, source, format, targetPath, { rowCap: EXPORT_ROW_CAP });
        auditRead(deps, op, "ok", Math.round(performance.now() - t0), null);
        if (openAfter) openWithDefaultApp(result.path);
        return { path: result.path, rowCount: result.rowCount, truncated: result.truncated, columns: result.columns };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        auditRead(deps, op, "error", Math.round(performance.now() - t0), msg);
        return { error: msg };
      }
    },
  });

  return { get_schema: getSchema, load_skill: loadSkill, read_rows: readRows, export_data: exportTool };
}
