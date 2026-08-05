// Traces: BASED-AGENT-SCHEMA-CTX, BASED-AGENT-AUDIT, BASED-SKILL-LOAD, BASED-LANCE-AGENT-SURFACE,
//         BASED-AGENT-READ-ROWS, BASED-AGENT-EXPORT, BASED-AGENT-CAPABILITY-DISCOVERY,
//         BASED-AGENT-SURFACE-VARIANT, BASED-INDEX-INTROSPECT, BASED-LANCE-SCAN, BASED-SCRIPT-OBJECT,
//         BASED-AGENT-DELEGATE
//
// The capability-driven core toolset. Every tool here has ONE name across every engine and variant;
// what changes is its description and its parameter list, both generated from EngineCapabilities.
// That matters twice over: a stable name keeps a chat thread coherent when the user switches
// connections mid-conversation, and a generated description can be *unconditionally true* — the
// agent never has to evaluate prose like "on SQL Server you may also…" against a variant it has no
// way to see.
//
// Engine-specific tools (vector/keyword/hybrid search) live alongside in lancedb.ts. Personas live
// with their engine. agentSurfaceFor (../surface.ts) assembles the whole thing.
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { DatabaseAdapter, EngineCapabilities, TableFilter, TableSort } from "../../db/types";
import type { EngineAgentProse } from "../../engines/descriptor";
import { WHERE_GRAMMAR } from "./whereGrammar";
import type { AuditSink } from "../audit";
import type { EmbeddingProfileStore } from "../../storage/embeddingProfiles";
import type { RerankerProfileStore } from "../../storage/rerankerProfiles";
import { catalog as skillCatalog, get as getSkill } from "../skills";
import { isReadOnly } from "../../db/classify";
import { describeLanceSchema } from "../../db/lanceDescribe";
import type { ScriptAction } from "../../db/scripter";
import { scriptWithAdapter } from "../../db/scriptDispatch";
import { collectQuery, AGENT_ROW_CAP } from "../runSql";
import { boundRows, payloadBudget } from "../toolPayload";
import { exportData, sanitizeExportFileName, EXPORT_ROW_CAP } from "../../export/exportData";
import {
  MAX_SAVE_FILE_BYTES,
  SAVE_FILE_EXTENSIONS,
  resolveDownloadDir,
  sanitizeSaveFileName,
  writeTextFileUnique,
} from "../../files/saveFile";
import { defaultTranscriptFileName, transcriptMarkdown } from "../transcript";
import { openWithDefaultApp } from "../../dialogs";
import { delegateTool, type SubagentRunner } from "./delegate";
import type { Message } from "@ag-ui/core";

export interface ToolDeps {
  /** Returns the current session adapter, or throws if no connection is active. */
  getAdapter: () => DatabaseAdapter;
  connectionId: () => string;
  database: () => string;
  audit: AuditSink;
  /** Traces: BASED-AGENT-DELEGATE — present only for a run that is allowed to fan work out to
   *  subagents. Injected rather than built here because the runner needs the agent builder, and
   *  tools/ sits downstream of it. Its absence on a child's deps is what stops recursion: no dep,
   *  no `delegate` tool, nothing to enforce at call time. */
  runSubagent?: SubagentRunner;
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
  /** Where export_data, save_file, and save_chat_transcript write their files. Defaults to the
   *  user's Downloads folder (falling back to the temp dir); tests inject a scratch dir so runs
   *  never touch the real Downloads. */
  exportDir?: () => string;
  /** Display name of the connected connection, for get_connection_info. */
  connectionName?: () => string;
  /** Traces: BASED-AGENT-TRANSCRIPT — the running thread's id, and a reader for its stored
   *  messages. Present only on a top-level run's deps: a subagent shares the parent's thread id but
   *  has no business writing the user's transcript, and its absence here is what keeps
   *  save_chat_transcript off the child's surface (same mechanism as runSubagent/delegate). */
  threadId?: () => string | undefined;
  recallThread?: (threadId: string, resourceId: string) => Promise<Message[]>;
}

/** Rows returned to the model per result set — kept small to protect the model's context window
 *  (the full capped set still streams to the UI when the user runs SQL themselves). */
export const TOOL_PREVIEW_ROWS = 50;

/** Hard cap on one read_table page. */
export const AGENT_PAGE_CAP = 200;

/** The one description of how a search actually executes, repeated verbatim by every search tool
 *  so the agent can't learn a different order from whichever description it read last. */
export const SEARCH_PIPELINE_ORDER =
  "Pipeline order: probe (nprobes/ef) → prefilter (where, unless postfilter) → candidatePool → rerank (rerankTopN) → threshold (minScore/maxScoreGapFromTop) → k. k is clamped to candidatePool, and rerankTopN never scores more than candidatePool candidates.";

export { WHERE_GRAMMAR };

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

/** Spread a shape into an input schema only when the capability is present. Typed as ZodRawShape so
 *  the conditional doesn't leak `| undefined` into every property. */
function when(condition: boolean, shape: z.ZodRawShape): z.ZodRawShape {
  return condition ? shape : {};
}

/** An omitted optional string, as the model actually sends it. The tool schema reaches the model as
 *  `anyOf: [string, null]`, so a model that means "no value" fills `null` or `""` rather than leaving
 *  the property out. Mastra strips `null` before execute; `""` is a valid string and arrives intact,
 *  so every consumer of an optional string has to collapse it here or hand a blank to the engine. */
function blankToUndefined(v: string | undefined): string | undefined {
  return v?.trim() || undefined;
}

/** The namespace parameter, which is several concepts wearing one slot across engines: a SQL
 *  schema, a LanceDB base folder, a warehouse dataset. The engine descriptor names it (or returns
 *  null, on the variants that have no namespace at all), so this stays one code path. */
function namespaceFields(caps: EngineCapabilities, prose: EngineAgentProse): z.ZodRawShape {
  const param = prose.namespaceParam(caps);
  if (!param) return {};
  return { [param.key]: z.string().optional().describe(param.description) };
}

/** Resolve the namespace argument to the adapter's `schema` positional. Falls back to the engine's
 *  default namespace ("dbo", "PUBLIC", or "" where there is none). */
function namespaceOf(
  caps: EngineCapabilities,
  prose: EngineAgentProse,
  args: Record<string, unknown>,
): string {
  const param = prose.namespaceParam(caps);
  if (!param) return "";
  const value = args[param.key];
  return typeof value === "string" && value.trim() ? value : prose.namespaceDefault;
}

/** How a tool names the table's namespace in an audit line / error message. */
function qualify(ns: string, table: string): string {
  return ns ? `${ns}.${table}` : table;
}

// ---------------------------------------------------------------------------------------------
// Tool builders. Each takes the live capabilities and returns a tool whose schema and prose
// describe only what THIS connection can do.
// ---------------------------------------------------------------------------------------------

function listObjectsTool(deps: ToolDeps, caps: EngineCapabilities, prose: EngineAgentProse) {
  const what = prose.objectsSummary(caps);
  return createTool({
    id: "list_objects",
    description: `List everything in this database: ${what}. Returns names only — call describe_table for a table's columns, and never invent a name that isn't in this list.`,
    inputSchema: z.object({}),
    execute: async () => ({ objects: await deps.getAdapter().listObjects() }),
  });
}

function describeTableTool(deps: ToolDeps, caps: EngineCapabilities, prose: EngineAgentProse) {
  // `script` is the capability that decides whether DDL formats exist at all; the engine's own
  // format list says which ones it can actually produce (Snowflake has no "alter" template).
  const isSql = caps.script;
  const formats = prose.describeFormats;
  const description = prose.describeDescription;
  return createTool({
    id: "describe_table",
    description,
    inputSchema: z.object({
      table: z.string().describe(prose.tableParam),
      ...namespaceFields(caps, prose),
      format: z
        .enum(formats as unknown as [string, ...string[]])
        .optional()
        .describe(`What to return (default "columns")`),
    }),
    execute: async (args: { table: string; schema?: string; folder?: string; format?: string }) => {
      const adapter = deps.getAdapter();
      const ns = namespaceOf(caps, prose, args);
      const format = (args.format as string) ?? "columns";
      const op = `describe_table(${qualify(ns, args.table)}, ${format})`;
      const t0 = performance.now();
      try {
        if (format === "columns") {
          const columns = await adapter.getTableColumns(ns, args.table);
          // SQL catalogs answer a wrong schema/name with zero rows, not an error — an empty column
          // list here almost always means the name didn't resolve, and reporting it as a real
          // answer leaves the agent nothing to self-correct from. Confirm existence before trusting it.
          if (columns.length === 0) {
            const objects = await adapter.listObjects().catch(() => []);
            if (!objects.some((o) => o.schema === ns && o.name === args.table)) {
              auditRead(deps, op, "error", Math.round(performance.now() - t0), "unknown object");
              return {
                error: `Unknown object ${qualify(ns, args.table)}`,
                validNames: objects.map((o) => qualify(o.schema, o.name)).slice(0, 200),
              };
            }
          }
          auditRead(deps, op, "ok", Math.round(performance.now() - t0), null);
          return { table: args.table, namespace: ns, columns };
        }
        if (!isSql) {
          // Lance has no SQL DDL — "scripting" a table is a readable description plus a pyarrow
          // snippet for recreating a compatible one (BASED-SCRIPT-OBJECT, LanceDB half).
          const columns = await adapter.getTableColumns(ns, args.table);
          auditRead(deps, op, "ok", Math.round(performance.now() - t0), null);
          return { table: args.table, namespace: ns, description: describeLanceSchema(args.table, columns) };
        }
        const objects = await adapter.listObjects();
        const obj = objects.find((o) => o.schema === ns && o.name === args.table);
        if (!obj) {
          return {
            error: `Unknown object ${qualify(ns, args.table)}`,
            validNames: objects.map((o) => `${o.schema}.${o.name}`).slice(0, 200),
          };
        }
        const action = (format === "ddl" ? "create" : format) as ScriptAction;
        let sql: string;
        if (obj.type === "table") {
          if (!adapter.getTableDetails) return { error: "This engine does not support table scripting." };
          sql = await scriptWithAdapter(
            adapter,
            { kind: "table", details: await adapter.getTableDetails(ns, args.table) },
            action,
          );
        } else {
          const definition = await adapter.getObjectDefinition?.(ns, args.table);
          if (definition == null) return { error: `No definition found for ${qualify(ns, args.table)}` };
          const type = obj.type === "view" ? "view" : obj.type === "procedure" ? "procedure" : "function";
          sql = await scriptWithAdapter(adapter, { kind: "module", type, schema: ns, name: args.table, definition }, action);
        }
        auditRead(deps, op, "ok", Math.round(performance.now() - t0), null);
        return { schema: ns, name: args.table, type: obj.type, format, sql };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        auditRead(deps, op, "error", Math.round(performance.now() - t0), msg);
        const objects = await adapter.listObjects().catch(() => []);
        return { error: msg, validNames: objects.map((o) => qualify(o.schema, o.name)).slice(0, 200) };
      }
    },
  });
}

// Traces: BASED-AGENT-READ-ROWS, BASED-LANCE-SCAN — one tool for "give me rows". It absorbed the old
// sample_rows (an unordered peek is just a small page with no filter), which is why neither tool can
// claim any more to be "the only one that returns raw rows".
type ReadTableArgs = {
  table: string;
  schema?: string;
  folder?: string;
  offset?: number;
  limit?: number;
  columns?: string[];
  orderBy?: TableSort[];
  filters?: TableFilter[];
  where?: string;
};

function readTableTool(deps: ToolDeps, caps: EngineCapabilities, prose: EngineAgentProse) {
  const description = caps.structuredFilters
    ? "Read a page of rows from a table or view. Pass `orderBy` for a stable page order and `filters` to narrow rows server-side (both validated server-side); page by increasing `offset`, and `hasMore` tells you whether another page may exist. Omit `orderBy` and `filters` for a quick unordered peek at example values."
    : (prose.readTable?.(caps) ??
      "Read a page of rows from a table. Page by increasing `offset`; `hasMore` tells you whether another page may exist.");

  return createTool({
    id: "read_table",
    description,
    inputSchema: z.object({
      table: z.string().describe(prose.tableParam),
      ...namespaceFields(caps, prose),
      offset: z.number().int().optional().describe("Row offset to start from (default 0)"),
      limit: z.number().int().optional().describe(`Rows per page (1-${AGENT_PAGE_CAP}, default 100)`),
      columns: z.array(z.string()).optional().describe("Restrict to these columns"),
      ...when(caps.structuredFilters, {
        orderBy: z
          .array(z.object({ column: z.string(), dir: z.enum(["asc", "desc"]) }))
          .optional()
          .describe("Sort columns, applied server-side"),
        filters: z
          .array(
            z.object({
              column: z.string(),
              op: z.enum(["eq", "ne", "gt", "ge", "lt", "le", "like", "is-null", "not-null"]),
              value: z.union([z.string(), z.number()]).optional(),
            }),
          )
          .optional()
          .describe("Row filters, applied server-side as parameterized predicates"),
      }),
      ...when(caps.wherePredicate, {
        where: z.string().optional().describe(`Filter predicate, e.g. "year > 2020". ${WHERE_GRAMMAR}`),
      }),
    }),
    execute: async (args: ReadTableArgs) => {
      const adapter = deps.getAdapter();
      const ns = namespaceOf(caps, prose, args);
      const n = Math.max(1, Math.min(AGENT_PAGE_CAP, Math.floor(args.limit ?? 100)));
      const off = Math.max(0, Math.floor(args.offset ?? 0));
      const where = blankToUndefined(args.where);
      const op = `read_table(${qualify(ns, args.table)}, offset=${off}, limit=${n}${where ? `, where=${where}` : ""})`;
      const t0 = performance.now();
      try {
        const page = await adapter.readTablePage(ns, args.table, {
          offset: off,
          limit: n,
          orderBy: args.orderBy as TableSort[] | undefined,
          filters: args.filters as TableFilter[] | undefined,
          where,
        });
        auditRead(deps, op, "ok", Math.round(performance.now() - t0), null);
        const keep = args.columns?.length ? page.columns.filter((c) => args.columns!.includes(c.name)) : page.columns;
        const keepIdx = keep.map((c) => page.columns.findIndex((p) => p.name === c.name));
        const bounded = boundRows(page.rows.map((row) => keepIdx.map((i) => row[i]!)));
        return {
          columns: keep.map((c) => c.name),
          rows: bounded.rows,
          orderBy: page.orderBy,
          offset: off,
          returned: bounded.returned,
          // Heuristic — TablePage carries no total; call count_rows when the scale matters. Read off
          // the page the ADAPTER returned, not the size-bounded one: dropping rows to fit the
          // payload budget must not be mistaken for reaching the end of the table.
          hasMore: page.rows.length === n,
          ...(bounded.note ? { truncated: true, note: bounded.note } : {}),
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        auditRead(deps, op, "error", Math.round(performance.now() - t0), msg);
        return { error: msg };
      }
    },
  });
}

// Traces: BASED-LANCE-SCAN — hasMore says nothing about scale, so without this the agent can't
// choose between paging and aggregating, or tell the user how big the answer actually is.
function countRowsTool(deps: ToolDeps, caps: EngineCapabilities, prose: EngineAgentProse) {
  const description = caps.structuredFilters
    ? "Count rows in a table or view, optionally narrowed by `filters`. Call before paging with read_table to know how much there is, and before proposing a DELETE or UPDATE to know the blast radius."
    : "Count rows in a Lance table, optionally narrowed by a `where` predicate (same syntax as read_table). Cheap — call it before paging so you know the total, and before telling the user how large a result is.";
  return createTool({
    id: "count_rows",
    description,
    inputSchema: z.object({
      table: z.string(),
      ...namespaceFields(caps, prose),
      ...when(caps.structuredFilters, {
        filters: z
          .array(
            z.object({
              column: z.string(),
              op: z.enum(["eq", "ne", "gt", "ge", "lt", "le", "like", "is-null", "not-null"]),
              value: z.union([z.string(), z.number()]).optional(),
            }),
          )
          .optional()
          .describe("Row filters, applied server-side"),
      }),
      ...when(caps.wherePredicate, { where: z.string().optional().describe(`Filter predicate. ${WHERE_GRAMMAR}`) }),
    }),
    execute: async (args: { table: string; schema?: string; folder?: string; where?: string; filters?: TableFilter[] }) => {
      const adapter = deps.getAdapter();
      const ns = namespaceOf(caps, prose, args);
      const where = blankToUndefined(args.where);
      const op = `count_rows(${qualify(ns, args.table)}${where ? `, where=${where}` : ""})`;
      const t0 = performance.now();
      try {
        const count = await adapter.countRows!(ns, args.table, {
          where,
          filters: args.filters as TableFilter[] | undefined,
        });
        auditRead(deps, op, "ok", Math.round(performance.now() - t0), null);
        return { table: args.table, count };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        auditRead(deps, op, "error", Math.round(performance.now() - t0), msg);
        return { error: msg };
      }
    },
  });
}

// Traces: BASED-LANCE-SCAN — the standard follow-up to a search that returned ids. Escaping the key
// literals here rather than making the agent write them into a `where` is the entire point.
function takeRowsTool(deps: ToolDeps, caps: EngineCapabilities, prose: EngineAgentProse) {
  return createTool({
    id: "take_rows",
    description:
      "Fetch specific rows by primary/id value — the follow-up to a search that returned ids, or to a user naming documents directly. Faster and more precise than a `where ... IN (...)` scan, and the key values are escaped for you.",
    inputSchema: z.object({
      table: z.string(),
      ...namespaceFields(caps, prose),
      keyColumn: z.string().describe("Column holding the ids"),
      keys: z.array(z.union([z.string(), z.number()])).describe("The id values to fetch"),
      columns: z.array(z.string()).optional().describe("Restrict to these columns"),
    }),
    execute: async (args: {
      table: string;
      schema?: string;
      folder?: string;
      keyColumn: string;
      keys: Array<string | number>;
      columns?: string[];
    }) => {
      const adapter = deps.getAdapter();
      const ns = namespaceOf(caps, prose, args);
      const op = `take_rows(${qualify(ns, args.table)}, ${args.keyColumn} in ${args.keys.length} keys)`;
      const t0 = performance.now();
      try {
        const page = await adapter.takeRows!(ns, args.table, {
          keyColumn: args.keyColumn,
          keys: args.keys,
          columns: args.columns,
        });
        auditRead(deps, op, "ok", Math.round(performance.now() - t0), null);
        const missing = args.keys.length - page.rows.length;
        const bounded = boundRows(page.rows);
        const notes = [
          ...(missing > 0 ? [`${missing} of the requested keys matched no row.`] : []),
          ...(bounded.note ? [bounded.note] : []),
        ];
        return {
          columns: page.columns.map((c) => c.name),
          rows: bounded.rows,
          returned: bounded.returned,
          ...(bounded.truncated ? { truncated: true } : {}),
          ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        auditRead(deps, op, "error", Math.round(performance.now() - t0), msg);
        return { error: msg };
      }
    },
  });
}

// Traces: BASED-INDEX-INTROSPECT — nprobes is an IVF knob and ef is an HNSW knob; without this the
// agent cannot know which one is even live, so it sets both and concludes the knob does nothing.
function getIndexesTool(deps: ToolDeps, caps: EngineCapabilities, prose: EngineAgentProse) {
  // Only built when caps.indexIntrospect, which is exactly when the engine defines this prose.
  const indexProse = prose.indexes!;
  return createTool({
    id: "get_indexes",
    description: indexProse.description,
    inputSchema: z.object({ table: z.string(), ...namespaceFields(caps, prose) }),
    execute: async (args: { table: string; schema?: string; folder?: string }) => {
      const adapter = deps.getAdapter();
      const ns = namespaceOf(caps, prose, args);
      const op = `get_indexes(${qualify(ns, args.table)})`;
      const t0 = performance.now();
      try {
        const indexes = await adapter.getIndexes!(ns, args.table);
        auditRead(deps, op, "ok", Math.round(performance.now() - t0), null);
        const unindexed = indexes.reduce((n, i) => n + (i.numUnindexedRows ?? 0), 0);
        return {
          table: args.table,
          indexes,
          ...(indexes.length === 0 ? { note: indexProse.emptyNote } : {}),
          ...(unindexed > 0 ? { warning: `${unindexed} row(s) are not yet covered by an index.` } : {}),
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        auditRead(deps, op, "error", Math.round(performance.now() - t0), msg);
        return { error: msg };
      }
    },
  });
}

// Traces: BASED-AGENT-CAPABILITY-DISCOVERY — the tool that tells the agent which column of the
// capability matrix it is standing in. Everything here was previously either unknowable or encoded
// as prose conditionals the agent had to guess the antecedent of.
function connectionInfoTool(deps: ToolDeps, caps: EngineCapabilities, prose: EngineAgentProse) {
  return createTool({
    id: "get_connection_info",
    description:
      "Report what this connection is and what it can do: engine, connection shape, whether it accepts writes or SQL, which filtering it supports, the folder namespace (if any), and the search profiles it defaults to. Call it when you are unsure whether an operation is possible here — the answer is cheap and exact, and it beats discovering a limit by hitting it.",
    inputSchema: z.object({}),
    execute: async () => {
      const embedding = deps.embeddingProfiles?.list() ?? [];
      const reranker = deps.rerankerProfiles?.list() ?? [];
      const defaultEmbeddingId = deps.defaultEmbeddingProfileId?.() ?? null;
      const defaultRerankerId = deps.defaultRerankerProfileId?.() ?? null;
      const defaultEmbedding = embedding.find((p) => p.id === defaultEmbeddingId);
      const defaultReranker = reranker.find((p) => p.id === defaultRerankerId);
      return {
        connection: { name: deps.connectionName?.() ?? null, database: deps.database() },
        engine: caps.engine,
        variant: caps.variant,
        readOnly: !caps.write,
        capabilities: {
          sql: caps.sql,
          search: caps.search,
          write: caps.write,
          filterBy: caps.structuredFilters ? "structured filters" : caps.wherePredicate ? "where predicate" : "none",
          orderedBrowse: caps.orderedBrowse,
          countRows: caps.countRows,
          takeByKey: caps.takeByKey,
          indexIntrospect: caps.indexIntrospect,
          scriptDdl: caps.script,
        },
        folders: caps.containers,
        ...(caps.variant === "lancedb-basefolder"
          ? { folderNote: "This is a base-folder connection: qualify tables as folder.main.table in run_query, and pass `folder` to the other tools when a table name is ambiguous." }
          : {}),
        limits: { rowsPerPage: AGENT_PAGE_CAP, queryRowCap: AGENT_ROW_CAP, exportRowCap: EXPORT_ROW_CAP },
        ...(caps.search
          ? {
              searchProfiles: {
                embedding: defaultEmbedding
                  ? { id: defaultEmbedding.id, name: defaultEmbedding.name, model: defaultEmbedding.model, dimension: defaultEmbedding.dimension ?? null }
                  : null,
                reranker: defaultReranker
                  ? { id: defaultReranker.id, name: defaultReranker.name, model: defaultReranker.model }
                  : null,
                note: "The embedding profile is applied automatically to text queries; the reranker is never applied unless you pass its id.",
              },
              pipeline: SEARCH_PIPELINE_ORDER,
            }
          : {}),
      };
    },
  });
}

function runQueryTool(deps: ToolDeps, caps: EngineCapabilities, prose: EngineAgentProse) {
  const { description, sqlParam } = prose.runQuery(caps);
  return createTool({
    id: "run_query",
    description,
    inputSchema: z.object({ sql: z.string().describe(sqlParam) }),
    execute: async ({ sql }) => {
      const adapter = deps.getAdapter();
      if (!isReadOnly(sql)) {
        return {
          refused: true,
          reason: caps.write
            ? "run_query only executes read-only SELECT/CTE statements. Use run_mutation to request approval for anything that writes."
            : "run_query only executes read-only SELECT/CTE statements; this database is read-only.",
        };
      }
      const result = await collectQuery(adapter, sql, { rowCap: AGENT_ROW_CAP });
      auditRead(deps, sql, result.status === "ok" ? "ok" : "error", result.durationMs, result.errors[0] ?? null);
      if (result.status === "error") return { error: result.errors.join("; ") || "Query failed" };
      // One budget across every result set: a batch returning five of them must not be allowed to
      // spend the cap five times (BASED-AGENT-TOOL-PAYLOAD-CAP).
      const budget = payloadBudget();
      return {
        resultSets: result.resultSets.map((rs) => {
          const bounded = boundRows(rs.rows.slice(0, TOOL_PREVIEW_ROWS), { budget });
          return {
            columns: rs.columns.map((c) => c.name),
            rows: bounded.rows,
            rowCount: rs.rowCount,
            truncated: rs.truncated || rs.rowCount > TOOL_PREVIEW_ROWS || bounded.truncated,
            previewedRows: bounded.returned,
            ...(bounded.note ? { note: bounded.note } : {}),
          };
        }),
        messages: result.messages,
        durationMs: result.durationMs,
      };
    },
  });
}

// Traces: BASED-SKILL-LOAD — progressive disclosure: the prompt advertises the catalog (name+desc);
// the agent pulls a full skill body only when it needs it. An unknown name returns the valid list.
function loadSkillTool() {
  return createTool({
    id: "load_skill",
    description:
      "Load the full instructions for one of the skills listed in your system prompt's skill catalog. Call this before acting on a skill (e.g. before drawing a diagram). Returns the skill's body text.",
    inputSchema: z.object({ name: z.string().describe('The skill name from the catalog (e.g. "diagrams")') }),
    execute: async ({ name }) => {
      const skill = getSkill(name);
      if (!skill) return { error: `Unknown skill "${name}"`, validNames: skillCatalog().map((s) => s.name) };
      return { name: skill.name, body: skill.body };
    },
  });
}

// Traces: BASED-AGENT-EXPORT — write a query result or whole table to a CSV/XLSX file. Writes
// server-side to Downloads (no dialog can pop mid-run) and returns the path.
function exportDataTool(deps: ToolDeps, caps: EngineCapabilities, prose: EngineAgentProse) {
  const sources = caps.sql ? "`sql` (a read-only SELECT) or `table` (exports the whole table" : "`table` (exports the whole table";
  return createTool({
    id: "export_data",
    description: `Export data to a CSV or XLSX file on the user's machine and return the file path. Provide ${caps.sql ? "exactly one of " : ""}${sources}, capped at ${EXPORT_ROW_CAP.toLocaleString("en-US")} rows). The file is written to the user's Downloads folder; set openAfter to open it immediately.`,
    inputSchema: z.object({
      format: z.enum(["csv", "xlsx"]).describe("Output file format"),
      ...when(caps.sql, { sql: z.string().optional().describe("A read-only SELECT to export (exactly one of sql/table)") }),
      table: z.string().optional().describe(caps.sql ? "Table to export in full (exactly one of sql/table)" : "Table to export in full"),
      ...namespaceFields(caps, prose),
      fileName: z.string().optional().describe("File name only — no directories; extension added if missing"),
      openAfter: z.boolean().optional().describe("Open the file with the OS default app after writing"),
    }),
    execute: async (raw) => {
      const adapter = deps.getAdapter();
      const args = raw as {
        format: "csv" | "xlsx";
        sql?: string;
        table?: string;
        schema?: string;
        folder?: string;
        fileName?: string;
        openAfter?: boolean;
      };
      const { format, fileName, openAfter } = args;
      const sql = blankToUndefined(args.sql);
      const table = blankToUndefined(args.table);
      if ((sql == null) === (table == null)) {
        return { error: caps.sql ? "Provide exactly one of `sql` or `table`." : "Provide `table`." };
      }
      if (sql != null && !isReadOnly(sql)) {
        return { refused: true, reason: "export_data only exports read-only SELECT results; nothing was run." };
      }
      const ns = namespaceOf(caps, prose, args);
      const source = sql != null ? ({ kind: "sql", sql } as const) : ({ kind: "table", schema: ns, table: table! } as const);
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
      const op = `export_data(${format}, ${sql != null ? "sql" : qualify(ns, table!)} → ${targetPath})`;
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
}

// Traces: BASED-AGENT-SAVE-FILE — deliver a document the agent authored (a standalone HTML report,
// a .sql script, a markdown write-up) as a real file instead of a wall of text the user has to
// hand-select out of the chat rail. Writes to Downloads for the same reason export_data does: a
// PowerShell save dialog cannot pop in the middle of a streaming run.
function saveFileTool(deps: ToolDeps) {
  return createTool({
    id: "save_file",
    description: `Save text you have written to a file on the user's machine and return the path — use this instead of pasting a long document into chat. Good for standalone HTML pages/reports, .sql scripts, markdown write-ups, and plain notes. Allowed file types: ${SAVE_FILE_EXTENSIONS.join(", ")} (nothing executable). The file goes to the user's Downloads folder and is never overwritten — an existing name gets a "-2" suffix. Max ${Math.round(MAX_SAVE_FILE_BYTES / 1_000_000)} MB. Set openAfter to open it immediately. To save the conversation itself, use save_chat_transcript instead — don't retype it here.`,
    inputSchema: z.object({
      content: z.string().describe("The full file contents, exactly as it should be written"),
      fileName: z
        .string()
        .describe(`File name only — no directories; the extension picks the type (one of: ${SAVE_FILE_EXTENSIONS.join(", ")})`),
      openAfter: z.boolean().optional().describe("Open the file with the OS default app after writing"),
    }),
    execute: async (raw) => {
      const { content, fileName, openAfter } = raw as { content: string; fileName: string; openAfter?: boolean };
      if (typeof content !== "string" || content.length === 0) return { error: "content must not be empty." };
      const bytes = Buffer.byteLength(content, "utf8");
      if (bytes > MAX_SAVE_FILE_BYTES) {
        return { error: `content is ${Math.round(bytes / 1000)} KB — over the ${Math.round(MAX_SAVE_FILE_BYTES / 1_000_000)} MB save_file limit.` };
      }
      let name: string;
      try {
        name = sanitizeSaveFileName(fileName);
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
      const targetDir = resolveDownloadDir(deps.exportDir?.());
      const t0 = performance.now();
      try {
        const written = await writeTextFileUnique(targetDir, name, content);
        auditRead(deps, `save_file(${written.path})`, "ok", Math.round(performance.now() - t0), null);
        if (openAfter) openWithDefaultApp(written.path);
        return { path: written.path, bytes: written.bytes, fileName: written.path.split(/[\\/]/).pop() };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        auditRead(deps, `save_file(${join(targetDir, name)})`, "error", Math.round(performance.now() - t0), msg);
        return { error: msg };
      }
    },
  });
}

// Traces: BASED-AGENT-TRANSCRIPT — save the conversation itself. The messages come from agent
// memory, never from the model: re-emitting a whole thread through tool-call arguments would cost
// as many tokens as the thread and would paraphrase rather than reproduce it.
function saveTranscriptTool(deps: ToolDeps) {
  return createTool({
    id: "save_chat_transcript",
    description:
      "Save this whole conversation as a markdown file on the user's machine and return the path. Reads the thread directly — do NOT retype the conversation, and do not call save_file for this. The file goes to the user's Downloads folder. Note that it covers the conversation up to the user's current message; your reply to it is not in the file yet.",
    inputSchema: z.object({
      fileName: z.string().optional().describe("File name only — no directories; .md is added if missing"),
      title: z.string().optional().describe("Heading for the document (defaults to a generic title)"),
      openAfter: z.boolean().optional().describe("Open the file with the OS default app after writing"),
    }),
    execute: async (raw) => {
      const { fileName, title, openAfter } = raw as { fileName?: string; title?: string; openAfter?: boolean };
      const threadId = deps.threadId?.();
      if (!threadId || !deps.recallThread) return { error: "No chat thread is available to save." };
      let name: string;
      try {
        name = sanitizeSaveFileName(fileName ?? defaultTranscriptFileName(), "md");
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
      const targetDir = resolveDownloadDir(deps.exportDir?.());
      const t0 = performance.now();
      try {
        const messages = await deps.recallThread(threadId, deps.connectionId());
        const markdown = transcriptMarkdown(messages, { title });
        const written = await writeTextFileUnique(targetDir, name, markdown);
        auditRead(deps, `save_chat_transcript(${written.path})`, "ok", Math.round(performance.now() - t0), null);
        if (openAfter) openWithDefaultApp(written.path);
        return {
          path: written.path,
          bytes: written.bytes,
          messageCount: messages.length,
          note: "Covers the conversation through the user's latest message; your current reply is not included.",
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        auditRead(deps, `save_chat_transcript(${join(targetDir, name)})`, "error", Math.round(performance.now() - t0), msg);
        return { error: msg };
      }
    },
  });
}

/** The capability-driven core toolset: present on every engine, shaped by what this connection can
 *  actually do. Tools whose capability is absent are OMITTED, never offered-then-refused — a tool
 *  the model can see is a tool it will eventually propose to the user. */
export function sharedTools(deps: ToolDeps, caps: EngineCapabilities, prose: EngineAgentProse) {
  return {
    get_connection_info: connectionInfoTool(deps, caps, prose),
    list_objects: listObjectsTool(deps, caps, prose),
    describe_table: describeTableTool(deps, caps, prose),
    read_table: readTableTool(deps, caps, prose),
    load_skill: loadSkillTool(),
    export_data: exportDataTool(deps, caps, prose),
    save_file: saveFileTool(deps),
    ...(caps.sql ? { run_query: runQueryTool(deps, caps, prose) } : {}),
    ...(caps.countRows ? { count_rows: countRowsTool(deps, caps, prose) } : {}),
    ...(caps.takeByKey ? { take_rows: takeRowsTool(deps, caps, prose) } : {}),
    ...(caps.indexIntrospect ? { get_indexes: getIndexesTool(deps, caps, prose) } : {}),
    // Gated on a dep rather than a capability: delegation is a property of the RUN, not the
    // connection. A child run gets deps without it and so has no `delegate` tool to call.
    ...(deps.runSubagent ? { delegate: delegateTool(deps) } : {}),
    // Same mechanism, same reason: a transcript belongs to the RUN's thread, and a subagent's deps
    // carry no reader — so the tool is absent from a child's surface rather than present-and-empty.
    ...(deps.recallThread ? { save_chat_transcript: saveTranscriptTool(deps) } : {}),
  };
}
