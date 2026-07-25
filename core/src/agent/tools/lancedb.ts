// Traces: BASED-LANCE-VECTOR-SEARCH, BASED-LANCE-FTS, BASED-LANCE-HYBRID, BASED-LANCE-AGENT-SURFACE,
//         BASED-LANCE-AGENT-SQL
// The LanceDB-specific agent tools. The toolset still deliberately differs from SQL Server's:
// search (vector / full-text / hybrid) is the primary surface, all backed by the adapter's unified
// search() pipeline. Local connections additionally get run_query — read-only DuckDB SQL over the
// attached Lance tables (BASED-LANCE-SQL) — gated at execute time on capabilities.sql so cloud
// sessions get a graceful error. There is still no run_mutation (capabilities.write is false).
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { SearchRows } from "../../db/types";
import { resolveEmbeddingProfile, resolveRerankerProfile } from "../../db/searchProfileResolve";
import { describeLanceSchema } from "../../db/lanceDescribe";
import { collectQuery, AGENT_ROW_CAP } from "../runSql";
import { isReadOnly } from "../../db/classify";
import { auditRead, type ToolDeps } from "./shared";

/** Rows returned to the model per search — small, to protect the model's context window. */
const TOOL_PREVIEW_ROWS = 50;

/** System-prompt fragment injected for LanceDB sessions. */
export const LANCE_PERSONA = `You are connected to a LanceDB vector database.
- Tables hold rows with regular columns plus one or more vector (embedding) columns; call get_schema to see which columns are vectors and their dimension.
- Tables have no primary key and are search/append-oriented; you cannot update or delete rows.
- To find rows by meaning, use vector_search. To find rows by keyword, use text_search (needs a full-text index on a text column). To combine both with reranking, use hybrid_search. These search tools are the primary way to find relevant rows.
- vector_search and hybrid_search embed your text query automatically using the session's default embedding profile (pass embeddingProfileId to pick a specific one), or a raw vector you supply. If no embedding profile is configured and no vector is given, the tool errors — fall back to text_search or tell the user to set up an embedding profile.
- Any of the three tools can take a rerankerProfileId to narrow noisy candidate pools through an external reranker — only use one if the user has configured one; ask rather than assuming. vector_search/hybrid_search additionally expose the Lance tuning knobs (nprobes, ef, refineFactor, postfilter, bypassVectorIndex, distance range) — load the lance-search skill before reaching for them.
- read_rows pages through a table (offset/limit) when you need more than sample_rows' peek; script_object describes a table's schema (columns, vector dims/metric, pyarrow snippet); export_data writes a table or local-SQL result to a CSV/XLSX file and returns the path.
- Local (file-based) connections also support read-only SQL via run_query: DuckDB dialect (LIMIT not TOP, double-quoted identifiers) over the attached Lance tables — use it for aggregates, JOINs, and filters that search can't express. In base-folder connections qualify tables as folder.main.table. LanceDB Cloud connections have no SQL; run_query will error there.
- Put every SQL statement in its own \`\`\`sql fenced code block so the user can insert or run it with one click. Make the first line a single-line comment (\`-- ...\`) briefly stating what it does.
- Present results as a concise markdown table of the most relevant rows; summarize rather than dumping raw vectors.`;

function formatResult(res: SearchRows) {
  return {
    columns: res.columns.map((c) => c.name),
    rows: res.rows.slice(0, TOOL_PREVIEW_ROWS),
    rowCount: res.rows.length,
    truncated: res.rows.length > TOOL_PREVIEW_ROWS,
  };
}

// Options every search mode accepts, including the external-rerank knobs (the adapter already
// honors rerankerOptions/rerankTextColumn; these flat fields map onto them in each execute).
const searchOptionFields = {
  sampleSize: z.number().int().optional().describe("Candidate pool size before rerank/filter (default 50)"),
  where: z.string().optional().describe("A LanceDB filter predicate (not SQL DML), e.g. \"year > 2020\""),
  embeddingProfileId: z.string().optional().describe("Named embedding profile to use if a text query needs embedding"),
  rerankerProfileId: z.string().optional().describe("Named reranker profile to narrow results"),
  rerankTopN: z.number().int().optional().describe("Reranker top_n: how many candidates the rerank endpoint scores/returns"),
  rerankTemperature: z.number().optional().describe("Reranker temperature, passed through if the endpoint accepts it"),
  rerankTextColumn: z.string().optional().describe("Column supplying document text for the reranker (default: first non-vector text column)"),
  floor: z.number().optional().describe("Drop results scoring worse than this absolute threshold"),
  delta: z.number().optional().describe("Drop results whose score trails the #1 result by more than this"),
};

// Traces: BASED-LANCE-SEARCH-KNOBS — vector-query tuning, valid only where a vector query exists
// (vector_search / hybrid_search). text_search deliberately omits these at the schema level.
const vectorKnobFields = {
  distanceType: z
    .enum(["l2", "cosine", "dot"])
    .optional()
    .describe("Distance metric. With an ANN index the index's own metric governs — mismatches give surprising scores"),
  nprobes: z.number().int().optional().describe("IVF partitions to probe — raise for recall, lower for speed"),
  refineFactor: z.number().int().optional().describe("Re-rank this×k candidates with exact vectors (recall fixup)"),
  ef: z.number().int().optional().describe("HNSW candidate-list size (the HNSW equivalent of nprobes)"),
  postfilter: z.boolean().optional().describe("Apply `where` AFTER the ANN search instead of prefiltering"),
  bypassVectorIndex: z.boolean().optional().describe("Skip the ANN index: exact ground-truth search (slow but precise)"),
  distanceRangeLower: z.number().optional().describe("Keep only results with distance ≥ this (engine-side bound)"),
  distanceRangeUpper: z.number().optional().describe("Keep only results with distance ≤ this (engine-side bound)"),
};

type SearchOptionArgs = {
  sampleSize?: number;
  where?: string;
  embeddingProfileId?: string;
  rerankerProfileId?: string;
  rerankTopN?: number;
  rerankTemperature?: number;
  rerankTextColumn?: string;
  floor?: number;
  delta?: number;
};

type VectorKnobArgs = {
  distanceType?: "l2" | "cosine" | "dot";
  nprobes?: number;
  refineFactor?: number;
  ef?: number;
  postfilter?: boolean;
  bypassVectorIndex?: boolean;
  distanceRangeLower?: number;
  distanceRangeUpper?: number;
};

/** Map the flat tool args onto the adapter's LanceSearchParams option shapes. */
function searchOptions(args: SearchOptionArgs & Partial<VectorKnobArgs>) {
  const { sampleSize, where, rerankTopN, rerankTemperature, rerankTextColumn, floor, delta } = args;
  return {
    sampleSize,
    where,
    rerankerOptions:
      rerankTopN != null || rerankTemperature != null ? { topN: rerankTopN, temperature: rerankTemperature } : undefined,
    rerankTextColumn,
    floor,
    delta,
    distanceType: args.distanceType,
    nprobes: args.nprobes,
    refineFactor: args.refineFactor,
    ef: args.ef,
    postfilter: args.postfilter,
    bypassVectorIndex: args.bypassVectorIndex,
    distanceRangeLower: args.distanceRangeLower,
    distanceRangeUpper: args.distanceRangeUpper,
  };
}

/** LanceDB-specific tools bound to the live session adapter. */
export function lanceTools(deps: ToolDeps) {
  const sampleRows = createTool({
    id: "sample_rows",
    description:
      "Return a small sample of rows from a LanceDB table (the only tool that returns raw rows). Vector cells are summarized, not dumped in full. Use to see example values.",
    inputSchema: z.object({
      table: z.string().describe("Table name"),
      limit: z.number().int().optional().describe("Max rows (1-100, default 20)"),
    }),
    execute: async ({ table, limit }) => {
      const n = Math.max(1, Math.min(100, Math.floor(limit ?? 20)));
      const t0 = performance.now();
      try {
        const page = await deps.getAdapter().readTablePage("", table, { offset: 0, limit: n });
        auditRead(deps, `sample_rows(${table}, n=${n})`, "ok", Math.round(performance.now() - t0), null);
        return { columns: page.columns.map((c) => c.name), rows: page.rows, rowCount: page.rows.length };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        auditRead(deps, `sample_rows(${table}, n=${n})`, "error", Math.round(performance.now() - t0), msg);
        return { error: msg };
      }
    },
  });

  function resolveProfiles(embeddingProfileId?: string, rerankerProfileId?: string) {
    const embeddingProfile =
      deps.embeddingProfiles && deps.getEmbeddingKey
        ? resolveEmbeddingProfile(deps.embeddingProfiles, deps.getEmbeddingKey, embeddingProfileId)
        : undefined;
    const rerankerProfile =
      deps.rerankerProfiles && deps.getRerankerKey
        ? resolveRerankerProfile(deps.rerankerProfiles, deps.getRerankerKey, rerankerProfileId)
        : undefined;
    return { embeddingProfile, rerankerProfile };
  }

  const vectorSearch = createTool({
    id: "vector_search",
    description:
      "Semantic (nearest-neighbour) search over a LanceDB table's vector column. Provide `query` text (embedded via an embedding profile) or a raw `vector`. Returns the most similar rows with a distance column.",
    inputSchema: z.object({
      table: z.string(),
      query: z.string().optional().describe("Text query, embedded via embeddingProfileId (or the default profile)"),
      vector: z.array(z.number()).optional().describe("Raw query embedding vector"),
      k: z.number().int().optional().describe("Number of results (default 10)"),
      columns: z.array(z.string()).optional().describe("Restrict to these columns"),
      ...searchOptionFields,
      ...vectorKnobFields,
    }),
    execute: async (args) => {
      const { table, query, vector, k, columns, embeddingProfileId, rerankerProfileId } = args;
      const adapter = deps.getAdapter();
      if (!adapter.search) return { error: "This connection does not support vector search." };
      const t0 = performance.now();
      try {
        const { embeddingProfile, rerankerProfile } = resolveProfiles(embeddingProfileId, rerankerProfileId);
        const res = await adapter.search({
          table,
          mode: "vector",
          query,
          vector,
          keepSize: k,
          columns,
          embeddingProfile,
          rerankerProfile,
          ...searchOptions(args),
        });
        auditRead(deps, `vector_search(${table}, k=${k ?? 10})`, "ok", Math.round(performance.now() - t0), null);
        return formatResult(res);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        auditRead(deps, `vector_search(${table}, k=${k ?? 10})`, "error", Math.round(performance.now() - t0), msg);
        return {
          error: msg,
          hint: "If you passed text with no embedding profile configured, supply a raw `vector`, or use text_search.",
        };
      }
    },
  });

  const textSearch = createTool({
    id: "text_search",
    description:
      "Full-text (keyword) search over a LanceDB table. Requires a full-text index on a text column. Returns the best-matching rows.",
    inputSchema: z.object({
      table: z.string(),
      query: z.string().describe("Keyword / phrase query"),
      k: z.number().int().optional().describe("Number of results (default 10)"),
      columns: z.array(z.string()).optional(),
      // No vectorKnobFields here: FTS has no vector query to tune (BASED-LANCE-SEARCH-KNOBS).
      ...searchOptionFields,
    }),
    execute: async (args) => {
      const { table, query, k, columns, embeddingProfileId, rerankerProfileId } = args;
      const adapter = deps.getAdapter();
      if (!adapter.search) return { error: "This connection does not support full-text search." };
      const t0 = performance.now();
      try {
        const { rerankerProfile } = resolveProfiles(embeddingProfileId, rerankerProfileId);
        const res = await adapter.search({
          table,
          mode: "text",
          query,
          keepSize: k,
          columns,
          rerankerProfile,
          ...searchOptions(args),
        });
        auditRead(deps, `text_search(${table}, k=${k ?? 10})`, "ok", Math.round(performance.now() - t0), null);
        return formatResult(res);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        auditRead(deps, `text_search(${table}, k=${k ?? 10})`, "error", Math.round(performance.now() - t0), msg);
        return { error: msg, hint: "The table may lack a full-text index on the searched column." };
      }
    },
  });

  const hybridSearch = createTool({
    id: "hybrid_search",
    description:
      "Hybrid search: runs vector + full-text search and fuses them (reciprocal rank fusion). Provide `query` text (embedded via an embedding profile, or supply a raw `vector`). Requires both a vector column and a full-text index.",
    inputSchema: z.object({
      table: z.string(),
      query: z.string().describe("Text query for both the semantic and keyword sides"),
      vector: z.array(z.number()).optional().describe("Raw query embedding (used if no embedding profile is configured)"),
      k: z.number().int().optional().describe("Number of results (default 10)"),
      columns: z.array(z.string()).optional(),
      ...searchOptionFields,
      ...vectorKnobFields,
    }),
    execute: async (args) => {
      const { table, query, vector, k, columns, embeddingProfileId, rerankerProfileId } = args;
      const adapter = deps.getAdapter();
      if (!adapter.search) return { error: "This connection does not support hybrid search." };
      const t0 = performance.now();
      try {
        const { embeddingProfile, rerankerProfile } = resolveProfiles(embeddingProfileId, rerankerProfileId);
        const res = await adapter.search({
          table,
          mode: "hybrid",
          query,
          vector,
          keepSize: k,
          columns,
          embeddingProfile,
          rerankerProfile,
          ...searchOptions(args),
        });
        auditRead(deps, `hybrid_search(${table}, k=${k ?? 10})`, "ok", Math.round(performance.now() - t0), null);
        return formatResult(res);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        auditRead(deps, `hybrid_search(${table}, k=${k ?? 10})`, "error", Math.round(performance.now() - t0), msg);
        return { error: msg, hint: "Hybrid search needs both a vector column and a full-text index on the table." };
      }
    },
  });

  // Traces: BASED-LANCE-AGENT-SQL — read-only DuckDB SQL over local Lance connections.
  const runQuery = createTool({
    id: "run_query",
    description:
      "Execute a read-only SQL query (DuckDB dialect) over the connection's Lance tables — aggregates, JOINs, GROUP BY, filters. Local connections only (LanceDB Cloud has no SQL). In base-folder connections qualify tables as folder.main.table. Mutating statements are rejected; this database is read-only.",
    inputSchema: z.object({
      sql: z.string().describe("A single read-only SELECT / CTE statement (DuckDB dialect)"),
    }),
    execute: async ({ sql }) => {
      const adapter = deps.getAdapter();
      if (!adapter.capabilities.sql) {
        return { error: "SQL is only available on local LanceDB connections — this session's engine has no SQL surface. Use the search tools instead." };
      }
      if (!isReadOnly(sql)) {
        return { refused: true, reason: "run_query only executes read-only SELECT/CTE statements; this database is read-only." };
      }
      const result = await collectQuery(adapter, sql, { rowCap: AGENT_ROW_CAP });
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

  // Traces: BASED-SCRIPT-OBJECT (LanceDB half) — Lance has no SQL DDL, so "scripting" a table means
  // a readable schema description + a pyarrow snippet for recreating a compatible table.
  const scriptObjectTool = createTool({
    id: "script_object",
    description:
      "Describe a LanceDB table's schema as text: every column with its type, vector columns with their dimension/element type/index metric, plus a pyarrow schema snippet for creating a compatible table. Returns text only — LanceDB connections are read-only.",
    inputSchema: z.object({
      table: z.string().describe("Table name"),
      schema: z.string().optional().describe("Base-folder name, when the connection is a base folder"),
    }),
    execute: async ({ table, schema }) => {
      const adapter = deps.getAdapter();
      const op = `script_object(${schema ? `${schema}.` : ""}${table})`;
      const t0 = performance.now();
      try {
        const columns = await adapter.getTableColumns(schema ?? "", table);
        const description = describeLanceSchema(table, columns);
        auditRead(deps, op, "ok", Math.round(performance.now() - t0), null);
        return { table, schema: schema ?? "", description };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        auditRead(deps, op, "error", Math.round(performance.now() - t0), msg);
        const objects = await adapter.listObjects().catch(() => []);
        return { error: msg, validNames: objects.map((o) => (o.schema ? `${o.schema}.${o.name}` : o.name)).slice(0, 200) };
      }
    },
  });

  return {
    sample_rows: sampleRows,
    run_query: runQuery,
    vector_search: vectorSearch,
    text_search: textSearch,
    hybrid_search: hybridSearch,
    script_object: scriptObjectTool,
  };
}
