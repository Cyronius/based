// Traces: BASED-LANCE-VECTOR-SEARCH, BASED-LANCE-FTS, BASED-LANCE-HYBRID, BASED-LANCE-AGENT-SURFACE
// The LanceDB-specific agent tools. These deliberately do NOT match the SQL Server toolset: there is
// no run_query/run_mutation (LanceDB has no SQL surface), and instead the AI gets vector / full-text /
// hybrid search. All are read-only and bound to the live session adapter.
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { SearchRows } from "../../db/types";
import { auditRead, type ToolDeps } from "./shared";

/** Rows returned to the model per search — small, to protect the model's context window. */
const TOOL_PREVIEW_ROWS = 50;

/** System-prompt fragment injected for LanceDB sessions. */
export const LANCE_PERSONA = `You are connected to a LanceDB vector database. There is no SQL here — you cannot write SELECT/INSERT/UPDATE/DELETE.
- Tables hold rows with regular columns plus one or more vector (embedding) columns; call get_schema to see which columns are vectors and their dimension.
- Tables have no primary key and are search/append-oriented; you cannot update or delete rows by key.
- To find rows by meaning, use vector_search. To find rows by keyword, use text_search (needs a full-text index on a text column). To combine both with reranking, use hybrid_search.
- vector_search and hybrid_search take a text query only if the table has a registered embedding function; otherwise supply a raw query vector. Not every table supports every search — if one fails, try text_search or report what the table supports.
- Present results as a concise markdown table of the most relevant rows; summarize rather than dumping raw vectors.`;

function formatResult(res: SearchRows) {
  return {
    columns: res.columns.map((c) => c.name),
    rows: res.rows.slice(0, TOOL_PREVIEW_ROWS),
    rowCount: res.rows.length,
    truncated: res.rows.length > TOOL_PREVIEW_ROWS,
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

  const vectorSearch = createTool({
    id: "vector_search",
    description:
      "Semantic (nearest-neighbour) search over a LanceDB table's vector column. Provide `query` text only if the table has a registered embedding function; otherwise provide a raw `vector`. Returns the most similar rows with a distance column.",
    inputSchema: z.object({
      table: z.string(),
      query: z.string().optional().describe("Text query (embedded natively if the table supports it)"),
      vector: z.array(z.number()).optional().describe("Raw query embedding vector"),
      k: z.number().int().optional().describe("Number of results (default 10)"),
      columns: z.array(z.string()).optional().describe("Restrict to these columns"),
      where: z.string().optional().describe("A LanceDB filter predicate (not SQL DML), e.g. \"year > 2020\""),
    }),
    execute: async ({ table, query, vector, k, columns, where }) => {
      const adapter = deps.getAdapter();
      if (!adapter.vectorSearch) return { error: "This connection does not support vector search." };
      const t0 = performance.now();
      try {
        const res = await adapter.vectorSearch({ table, query, vector, k, columns, where });
        auditRead(deps, `vector_search(${table}, k=${k ?? 10})`, "ok", Math.round(performance.now() - t0), null);
        return formatResult(res);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        auditRead(deps, `vector_search(${table}, k=${k ?? 10})`, "error", Math.round(performance.now() - t0), msg);
        return {
          error: msg,
          hint: "If you passed text and the table has no embedding function, supply a raw `vector`, or use text_search.",
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
    }),
    execute: async ({ table, query, k, columns }) => {
      const adapter = deps.getAdapter();
      if (!adapter.textSearch) return { error: "This connection does not support full-text search." };
      const t0 = performance.now();
      try {
        const res = await adapter.textSearch({ table, query, k, columns });
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
      "Hybrid search: runs vector + full-text search and reranks (reciprocal rank fusion). Provide `query` text (and a `vector` if the table has no embedding function). Requires both a vector column and a full-text index.",
    inputSchema: z.object({
      table: z.string(),
      query: z.string().describe("Text query for both the semantic and keyword sides"),
      vector: z.array(z.number()).optional().describe("Raw query embedding (needed if no embedding function)"),
      k: z.number().int().optional().describe("Number of results (default 10)"),
      columns: z.array(z.string()).optional(),
    }),
    execute: async ({ table, query, vector, k, columns }) => {
      const adapter = deps.getAdapter();
      if (!adapter.hybridSearch) return { error: "This connection does not support hybrid search." };
      const t0 = performance.now();
      try {
        const res = await adapter.hybridSearch({ table, query, vector, k, columns });
        auditRead(deps, `hybrid_search(${table}, k=${k ?? 10})`, "ok", Math.round(performance.now() - t0), null);
        return formatResult(res);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        auditRead(deps, `hybrid_search(${table}, k=${k ?? 10})`, "error", Math.round(performance.now() - t0), msg);
        return { error: msg, hint: "Hybrid search needs both a vector column and a full-text index on the table." };
      }
    },
  });

  return { sample_rows: sampleRows, vector_search: vectorSearch, text_search: textSearch, hybrid_search: hybridSearch };
}
