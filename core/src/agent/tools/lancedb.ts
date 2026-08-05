// Traces: BASED-LANCE-VECTOR-SEARCH, BASED-LANCE-FTS, BASED-LANCE-HYBRID, BASED-LANCE-AGENT-SURFACE,
//         BASED-LANCE-AGENT-SQL, BASED-LANCE-VECTOR-COLUMN, BASED-SEARCH-PARAM-NAMES
// The LanceDB-only agent tools: vector / full-text / hybrid search, all backed by the adapter's
// unified search() pipeline, plus profile discovery. Everything else a LanceDB session can do
// (read_table, count_rows, take_rows, describe_table, get_indexes, run_query where it exists) is
// capability-shaped and lives in shared.ts under the same names SQL Server uses.
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { EngineCapabilities, SearchRows } from "../../db/types";
import { resolveEmbeddingProfile, resolveRerankerProfile } from "../../db/searchProfileResolve";
import { auditRead, SEARCH_PIPELINE_ORDER, TOOL_PREVIEW_ROWS, WHERE_GRAMMAR, type ToolDeps } from "./shared";
import { boundRows } from "../toolPayload";

// Traces: BASED-AGENT-INSTRUCTIONS — the persona splits in two, and the split is the whole point:
//
//   lanceBriefing(caps)  — FACTS about this connection. Generated, never user-editable. Which tools
//                          exist, what the connection can and cannot do, how to qualify a table.
//   LANCE_PERSONA        — VOICE and policy. User-editable, and deliberately variant-NEUTRAL: every
//                          line must be true on local, base-folder and cloud alike.
//
// Facts aren't opinion, so they can't be forked into a fixed string that then goes stale against the
// connection. Before the split, editing one line of tone meant pinning the whole thing — including
// "run_query runs DuckDB SQL", which is false on Cloud.

/** The generated capability briefing for a LanceDB session. Every line is unconditionally true for
 *  THIS connection — no "on local connections…" the model has to decide whether it is on. */
export function lanceBriefing(caps: EngineCapabilities): string {
  const lines = [
    "You are connected to a LanceDB vector database.",
    "- Tables hold rows with regular columns plus one or more vector (embedding) columns; call describe_table to see which columns are vectors, their dimension, and their index metric.",
    "- Tables have no primary key and are search/append-oriented. This connection is read-only: you cannot insert, update, or delete rows, and there is no tool to propose it. Say so plainly rather than offering a fix you can't apply.",
    "- To find rows by meaning, use vector_search. To find rows by keyword, use text_search (needs a full-text index — get_indexes tells you whether one exists). To combine both with reranking, use hybrid_search.",
    "- To find rows by an exact condition rather than by relevance, use read_table with a `where` predicate — it returns rows in table order. Do not run a throwaway search just to filter. Use count_rows before paging so you know the scale, and take_rows to fetch specific ids (e.g. the ids a search just returned).",
    "- vector_search and hybrid_search embed your text query automatically using the embedding profile this connection is configured with (pass embeddingProfileId to override it), or a raw vector you supply. If the connection has no embedding profile and no vector is given, the tool errors — call list_search_profiles to see what exists, and either name one or fall back to text_search.",
    "- list_search_profiles reports the configured embedding and reranker profiles with their ids, models, and embedding dimensions, and flags which the connection defaults to. Call it before claiming nothing is configured, and to get an id — never invent one.",
    "- vector_search/hybrid_search expose the Lance tuning knobs under `tuning` — call get_indexes first, since nprobes only does something on an IVF index and ef only on HNSW.",
    "- export_data writes a table" + (caps.sql ? " or SQL result" : "") + " to a CSV/XLSX file and returns the path.",
    "- save_file writes a document YOU authored (a standalone HTML report, a markdown write-up, plain notes) to the user's Downloads folder and returns the path. Reach for it instead of pasting a long document into chat.",
  ];
  if (caps.sql) {
    lines.push(
      caps.variant === "lancedb-basefolder"
        ? "- This is a base-folder connection: run_query runs read-only DuckDB SQL over the attached Lance tables, and every table must be qualified as `folder.main.table`. The base folders are: " +
            (caps.containers ?? []).join(", ") +
            ". When a bare table name is ambiguous, pass `folder` to the other tools."
        : "- run_query runs read-only DuckDB SQL over this connection's Lance tables — use it for aggregates, JOINs, and anything a `where` predicate can't express.",
      "- DuckDB SQL and LanceDB `where` predicates are two different grammars this one connection exposes at once. Don't carry phrasing between them.",
      "- Put every SQL statement in its own ```sql fenced code block so the user can insert or run it with one click. Make the first line a single-line comment (`-- ...`) briefly stating what it does.",
    );
  } else {
    // Naming the missing tool ("there is no run_query") is itself a suggestion — a model that reads
    // a tool name will eventually reach for it. State the limit in terms of what IS available.
    lines.push(
      "- This connection has no SQL and no server-side aggregation: answer counting questions with count_rows (call it once per group to build a breakdown), and narrow rows with read_table's `where`.",
    );
  }
  return lines.join("\n");
}

/** The editable half of a LanceDB session's prompt: how to behave, not what exists. Nothing here
 *  may name a tool or capability that varies by variant — a user who forks this must not inherit a
 *  claim that is false on their connection. */
export const LANCE_PERSONA = `How to work here:
- Reranking is opt-in: pass rerankerProfileId when the user asks to tighten or narrow noisy results. It is never applied automatically, even when the connection names a reranker, because it can cost one model call per candidate row.
- Before reaching for the search tuning knobs, load the lance-search skill.
- When a search needs an embedding profile the connection doesn't have, tell the user to set the connection's embedding profile in connection settings rather than asking them for one every time.
- Present results as a concise markdown table of the most relevant rows; summarize rather than dumping raw vectors.`;

function formatResult(res: SearchRows) {
  // Traces: BASED-AGENT-TOOL-PAYLOAD-CAP — the row cap alone doesn't bound this: search hits are
  // usually document chunks, which is exactly the wide-text case that overruns a context window.
  const bounded = boundRows(res.rows.slice(0, TOOL_PREVIEW_ROWS));
  return {
    columns: res.columns.map((c) => c.name),
    rows: bounded.rows,
    rowCount: res.rows.length,
    truncated: res.rows.length > TOOL_PREVIEW_ROWS || bounded.truncated,
    ...(bounded.note ? { note: bounded.note } : {}),
  };
}

/** The base-folder qualifier, exposed only where folders exist (BASED-AGENT-SURFACE-VARIANT). */
function folderField(caps: EngineCapabilities): z.ZodRawShape {
  if (caps.variant !== "lancedb-basefolder") return {};
  const names = (caps.containers ?? []).join(", ");
  return {
    folder: z
      .string()
      .optional()
      .describe(`Base folder holding the table${names ? ` — one of: ${names}` : ""}. Required only when the same table name exists in more than one folder.`),
  };
}

// Options every search mode accepts. Traces: BASED-SEARCH-PARAM-NAMES — `candidatePool` was
// `sampleSize` (it reads as row sampling but is a candidate over-fetch pool), and
// `minScore`/`maxScoreGapFromTop` were `floor`/`delta` (for `_distance`, lower is better, so a
// parameter called "floor" that functions as a ceiling gets used backwards).
const searchOptionFields = {
  candidatePool: z
    .number()
    .int()
    .optional()
    .describe("How many candidates to over-fetch before reranking and thresholding (default 50). Not a row sample — raise it when a selective `where` or a reranker is starving the result set."),
  where: z.string().optional().describe(`Filter predicate applied before the search, e.g. "year > 2020". ${WHERE_GRAMMAR} Same grammar as read_table's \`where\`.`),
  embeddingProfileId: z.string().optional().describe("Named embedding profile to use if a text query needs embedding"),
  rerankerProfileId: z.string().optional().describe("Named reranker profile to narrow results"),
  rerankTopN: z.number().int().optional().describe("How many candidates the rerank endpoint scores/returns — never more than candidatePool"),
  rerankTemperature: z.number().optional().describe("Reranker temperature, passed through if the endpoint accepts it"),
  rerankTextColumn: z.string().optional().describe("Column supplying document text for the reranker (default: first non-vector text column)"),
  minScore: z
    .number()
    .optional()
    .describe("Drop results scoring worse than this. Direction-aware: for `_distance` (lower is better) it acts as an upper bound, for relevance/rerank scores as a lower bound."),
  maxScoreGapFromTop: z.number().optional().describe("Drop results whose score trails the #1 result by more than this"),
};

// Traces: BASED-LANCE-SEARCH-KNOBS — vector-query tuning, valid only where a vector query exists
// (vector_search / hybrid_search). text_search deliberately omits these at the schema level.
// Nested under one `tuning` object rather than flattened: the schema-compat layer marks every
// property required with an `anyOf: [..., null]`, and a model under that pressure fills plausible
// values instead of nulls — so a flat 22-parameter surface produces spurious nprobes on tables with
// no index. One optional object is one decision, not eight.
const tuningObject = z
  .object({
    distanceType: z
      .enum(["l2", "cosine", "dot"])
      .optional()
      .describe("Distance metric. With an ANN index the index's own metric governs — mismatches give surprising scores"),
    nprobes: z.number().int().optional().describe("IVF partitions to probe — raise for recall, lower for speed. No effect unless get_indexes reports an IVF index"),
    refineFactor: z.number().int().optional().describe("Re-rank this×k candidates with exact vectors (recall fixup)"),
    ef: z.number().int().optional().describe("HNSW candidate-list size (the HNSW equivalent of nprobes). No effect unless get_indexes reports an HNSW index"),
    postfilter: z
      .boolean()
      .optional()
      .describe("Apply `where` AFTER the ANN search instead of prefiltering, so fewer than k rows may come back even when many rows match. Prefer prefiltering unless you have a reason not to"),
    bypassVectorIndex: z.boolean().optional().describe("Skip the ANN index: exact ground-truth search (slow but precise)"),
    distanceRangeLower: z.number().optional().describe("Engine-side bound: keep only results with distance ≥ this. The pushdown variant of minScore"),
    distanceRangeUpper: z.number().optional().describe("Engine-side bound: keep only results with distance ≤ this. The pushdown variant of minScore"),
  })
  .optional()
  .describe("Lance vector-index tuning. Omit it unless a search is actually misbehaving — call get_indexes first to see which knobs apply");

type SearchArgs = {
  table: string;
  folder?: string;
  query?: string;
  vector?: number[];
  vectorColumn?: string;
  k?: number;
  columns?: string[];
  candidatePool?: number;
  where?: string;
  embeddingProfileId?: string;
  rerankerProfileId?: string;
  rerankTopN?: number;
  rerankTemperature?: number;
  rerankTextColumn?: string;
  minScore?: number;
  maxScoreGapFromTop?: number;
  tuning?: {
    distanceType?: "l2" | "cosine" | "dot";
    nprobes?: number;
    refineFactor?: number;
    ef?: number;
    postfilter?: boolean;
    bypassVectorIndex?: boolean;
    distanceRangeLower?: number;
    distanceRangeUpper?: number;
  };
};

/** Map the flat tool args (+ the nested tuning object) onto the adapter's LanceSearchParams shape. */
function searchOptions(args: SearchArgs) {
  return {
    schema: args.folder,
    candidatePool: args.candidatePool,
    where: args.where,
    vectorColumn: args.vectorColumn,
    rerankerOptions:
      args.rerankTopN != null || args.rerankTemperature != null
        ? { topN: args.rerankTopN, temperature: args.rerankTemperature }
        : undefined,
    rerankTextColumn: args.rerankTextColumn,
    minScore: args.minScore,
    maxScoreGapFromTop: args.maxScoreGapFromTop,
    ...(args.tuning ?? {}),
  };
}

/** LanceDB-specific tools bound to the live session adapter. */
export function lanceTools(deps: ToolDeps, caps: EngineCapabilities) {
  // Traces: BASED-LANCE-CONN-DEFAULT-PROFILES — an omitted embeddingProfileId falls back to the
  // connection's profile, because embedding is required for the search to run at all and the model
  // has no way to know a uuid. The reranker deliberately gets NO fallback: on the openai api it
  // costs one chat completion per candidate (up to candidatePool per search), so it stays opt-in and
  // the agent must name it — list_search_profiles is how it learns the id.
  function resolveProfiles(embeddingProfileId?: string, rerankerProfileId?: string) {
    const embeddingProfile =
      deps.embeddingProfiles && deps.getEmbeddingKey
        ? resolveEmbeddingProfile(
            deps.embeddingProfiles,
            deps.getEmbeddingKey,
            embeddingProfileId,
            deps.defaultEmbeddingProfileId?.(),
          )
        : undefined;
    const rerankerProfile =
      deps.rerankerProfiles && deps.getRerankerKey
        ? resolveRerankerProfile(deps.rerankerProfiles, deps.getRerankerKey, rerankerProfileId)
        : undefined;
    return { embeddingProfile, rerankerProfile };
  }

  // Traces: BASED-LANCE-PROFILE-DISCOVERY — profile ids are uuids the model cannot guess and the
  // persona tells it to ask rather than assume a reranker exists; without this tool it can do
  // neither. Returns metadata only: no API keys, not even a hasKey flag the model could act on.
  const listSearchProfiles = createTool({
    id: "list_search_profiles",
    description:
      "List the user's configured embedding and reranker profiles (id, name, model, and — for embedding profiles that have been used at least once — the vector dimension they produce), marking which ones this connection uses by default. Call this to get a profile id before passing embeddingProfileId/rerankerProfileId, and to check a profile's dimension against the target column's before searching. The connection's embedding profile is already applied automatically to text queries; its reranker is not — pass the id to use it.",
    inputSchema: z.object({}),
    execute: async () => {
      const defaultEmbeddingId = deps.defaultEmbeddingProfileId?.() ?? null;
      const defaultRerankerId = deps.defaultRerankerProfileId?.() ?? null;
      return {
        embedding: (deps.embeddingProfiles?.list() ?? []).map((p) => ({
          id: p.id,
          name: p.name,
          model: p.model,
          // Traces: BASED-LANCE-EMBED-DIM — null until the profile has produced an embedding once.
          dimension: p.dimension ?? null,
          isConnectionDefault: p.id === defaultEmbeddingId,
        })),
        reranker: (deps.rerankerProfiles?.list() ?? []).map((p) => ({
          id: p.id,
          name: p.name,
          model: p.model,
          api: p.api ?? "rerank",
          isConnectionDefault: p.id === defaultRerankerId,
        })),
        note: "Match an embedding profile's dimension to the target table's vector column (describe_table shows it). A same-dimension mismatch between different models returns plausible garbage no check can catch.",
      };
    },
  });

  const vectorSearch = createTool({
    id: "vector_search",
    description: `Semantic (nearest-neighbour) search over a LanceDB table's vector column. Provide \`query\` text (embedded via an embedding profile) or a raw \`vector\`. Returns the most similar rows with a \`_distance\` column (smaller is closer). Pass \`vectorColumn\` when the table has more than one embedding. ${SEARCH_PIPELINE_ORDER}`,
    inputSchema: z.object({
      table: z.string(),
      ...folderField(caps),
      query: z.string().optional().describe("Text query, embedded via embeddingProfileId (or the default profile)"),
      vector: z.array(z.number()).optional().describe("Raw query embedding vector"),
      vectorColumn: z.string().optional().describe("Which vector column to search — required only when the table has more than one"),
      k: z.number().int().optional().describe("Number of results (default 10, clamped to candidatePool)"),
      columns: z.array(z.string()).optional().describe("Restrict to these columns"),
      ...searchOptionFields,
      tuning: tuningObject,
    }),
    execute: async (raw) => {
      const args = raw as SearchArgs;
      const adapter = deps.getAdapter();
      if (!adapter.search) return { error: "This connection does not support vector search." };
      const t0 = performance.now();
      try {
        const { embeddingProfile, rerankerProfile } = resolveProfiles(args.embeddingProfileId, args.rerankerProfileId);
        const res = await adapter.search({
          table: args.table,
          mode: "vector",
          query: args.query,
          vector: args.vector,
          keepSize: args.k,
          columns: args.columns,
          embeddingProfile,
          rerankerProfile,
          ...searchOptions(args),
        });
        auditRead(deps, `vector_search(${args.table}, k=${args.k ?? 10})`, "ok", Math.round(performance.now() - t0), null);
        return formatResult(res);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        auditRead(deps, `vector_search(${args.table}, k=${args.k ?? 10})`, "error", Math.round(performance.now() - t0), msg);
        return {
          error: msg,
          hint: "If the connection has no embedding profile, call list_search_profiles and pass an embeddingProfileId, supply a raw `vector`, or use text_search. If the table has several vector columns, name one with `vectorColumn`.",
        };
      }
    },
  });

  const textSearch = createTool({
    id: "text_search",
    description: `Full-text (keyword) search over a LanceDB table. Requires a full-text index on a text column — call get_indexes first to check one exists, because without it this tool cannot run at all. Returns the best-matching rows. ${SEARCH_PIPELINE_ORDER}`,
    inputSchema: z.object({
      table: z.string(),
      ...folderField(caps),
      query: z.string().describe("Keyword / phrase query"),
      k: z.number().int().optional().describe("Number of results (default 10, clamped to candidatePool)"),
      columns: z.array(z.string()).optional(),
      // No tuning object here: FTS has no vector query to tune (BASED-LANCE-SEARCH-KNOBS).
      ...searchOptionFields,
    }),
    execute: async (raw) => {
      const args = raw as SearchArgs;
      const adapter = deps.getAdapter();
      if (!adapter.search) return { error: "This connection does not support full-text search." };
      const t0 = performance.now();
      try {
        const { rerankerProfile } = resolveProfiles(args.embeddingProfileId, args.rerankerProfileId);
        const res = await adapter.search({
          table: args.table,
          mode: "text",
          query: args.query,
          keepSize: args.k,
          columns: args.columns,
          rerankerProfile,
          ...searchOptions(args),
        });
        auditRead(deps, `text_search(${args.table}, k=${args.k ?? 10})`, "ok", Math.round(performance.now() - t0), null);
        return formatResult(res);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        auditRead(deps, `text_search(${args.table}, k=${args.k ?? 10})`, "error", Math.round(performance.now() - t0), msg);
        return { error: msg, hint: "Call get_indexes — the table may lack a full-text index on the searched column." };
      }
    },
  });

  const hybridSearch = createTool({
    id: "hybrid_search",
    description: `Hybrid search: runs vector + full-text search and fuses them (reciprocal rank fusion), returning a \`_relevance_score\` (higher is better). Provide \`query\` text (embedded via an embedding profile, or supply a raw \`vector\`). Requires both a vector column and a full-text index — get_indexes tells you whether both exist. ${SEARCH_PIPELINE_ORDER}`,
    inputSchema: z.object({
      table: z.string(),
      ...folderField(caps),
      query: z.string().describe("Text query for both the semantic and keyword sides"),
      vector: z.array(z.number()).optional().describe("Raw query embedding (used if no embedding profile is configured)"),
      vectorColumn: z.string().optional().describe("Which vector column to search — required only when the table has more than one"),
      k: z.number().int().optional().describe("Number of results (default 10, clamped to candidatePool)"),
      columns: z.array(z.string()).optional(),
      ...searchOptionFields,
      tuning: tuningObject,
    }),
    execute: async (raw) => {
      const args = raw as SearchArgs;
      const adapter = deps.getAdapter();
      if (!adapter.search) return { error: "This connection does not support hybrid search." };
      const t0 = performance.now();
      try {
        const { embeddingProfile, rerankerProfile } = resolveProfiles(args.embeddingProfileId, args.rerankerProfileId);
        const res = await adapter.search({
          table: args.table,
          mode: "hybrid",
          query: args.query,
          vector: args.vector,
          keepSize: args.k,
          columns: args.columns,
          embeddingProfile,
          rerankerProfile,
          ...searchOptions(args),
        });
        auditRead(deps, `hybrid_search(${args.table}, k=${args.k ?? 10})`, "ok", Math.round(performance.now() - t0), null);
        return formatResult(res);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        auditRead(deps, `hybrid_search(${args.table}, k=${args.k ?? 10})`, "error", Math.round(performance.now() - t0), msg);
        return { error: msg, hint: "Hybrid search needs both a vector column and a full-text index on the table — call get_indexes." };
      }
    },
  });

  return {
    vector_search: vectorSearch,
    text_search: textSearch,
    hybrid_search: hybridSearch,
    list_search_profiles: listSearchProfiles,
  };
}
