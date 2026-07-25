// Traces: BASED-LANCE-AGENT-SURFACE
// A LanceDB-only skill (engines: ["lancedb"]) — advertised solely in LanceDB sessions. It teaches the
// agent to pick the right search tool and to phrase good semantic queries.
import type { Skill } from "./types";

export const lanceSearch: Skill = {
  name: "lance-search",
  description:
    "How to search a LanceDB vector database well — choosing between vector, full-text, and hybrid search, phrasing semantic queries, and reading distance/relevance scores.",
  engines: ["lancedb"],
  body: `# Skill: lance-search

Searching by meaning or keywords uses three dedicated tools; pick by intent. (Local connections also
have read-only DuckDB SQL via run_query for aggregates/JOINs/filters — but for relevance-ranked
retrieval, the search tools below are the right instrument.)

## Choosing a search
- **vector_search** — "find rows *like* / *about* / *similar to* X" (meaning-based). Pass \`query\` text
  and it's embedded automatically via the session's embedding profile (pass \`embeddingProfileId\` to pick
  a specific one), or pass a raw \`vector\` directly. Returns a \`_distance\` column (smaller = closer).
- **text_search** — "find rows *containing* / *mentioning* these words" (exact keywords, names, codes).
  Requires a full-text index on the searched text column.
- **hybrid_search** — when you want both semantic relevance and keyword precision (e.g. a concept plus a
  specific term). Fuses vector + full-text internally with reciprocal rank fusion; returns a
  \`_relevance_score\`.

All three tools also accept \`sampleSize\` (candidate pool before filtering), \`floor\`/\`delta\` (score
thresholds), and a \`rerankerProfileId\` — when given, an external reranker rescoring narrows the
candidate pool down to \`k\` by \`_rerank_score\` instead of the native distance/relevance order.
Reranking is tunable with \`rerankTopN\` (how many candidates the endpoint scores), \`rerankTemperature\`,
and \`rerankTextColumn\` — set \`rerankTextColumn\` to the column holding the real document text; the
default is a first-text-column heuristic that can pick a title-ish field and starve the reranker.

## Tuning knobs (vector_search / hybrid_search only)
These map straight onto the Lance vector query; on an unindexed column the search is already exact and
they are harmless no-ops (except the distance range, which always bounds).
- **Recall too low / expected row missing** — raise \`nprobes\` (IVF indexes: more partitions probed) or
  \`ef\` (HNSW indexes: wider candidate list). Then add \`refineFactor\` (e.g. 5–10) to re-rank a larger
  candidate pool with exact vectors.
- **Ground truth check** — \`bypassVectorIndex: true\` skips the ANN index entirely (slow, exact). Use it
  to judge whether the index is costing recall ("is the index lying to me?"), not for routine queries.
- **\`where\` + few results** — the default prefilter can starve the ANN search when the predicate is
  selective. Try \`postfilter: true\` (filter after the search) with a larger \`sampleSize\`.
- **Score bounds** — \`distanceRangeLower\`/\`distanceRangeUpper\` bound \`_distance\` engine-side;
  \`floor\`/\`delta\` are based-side filters on whatever the final score column is. Prefer floor/delta when
  a reranker is in play (they apply to \`_rerank_score\`).
- **\`distanceType\`** — l2 | cosine | dot for the query. Caveat: when the column has an ANN index, the
  index's own metric governs the search; get_schema shows an indexed vector column's metric, so match
  it (or bypassVectorIndex to compare metrics exactly).

## Before searching
1. Call get_schema on the table to see which column is the vector (and its dimension) and which text
   columns exist. Never guess column names.
2. Use \`sample_rows\` if you need to see the shape of real values.

## Phrasing & reading results
- For vector_search, write the \`query\` as the *meaning* you want, not keywords — a short natural phrase
  embeds better than a boolean expression.
- Narrow with \`where\` (a LanceDB filter predicate like \`year > 2020\`, not SQL) and \`columns\` to keep
  results small.
- Rank by \`_distance\` (ascending) for vector search, \`_relevance_score\` (descending) for hybrid, or
  \`_rerank_score\` (descending) when a reranker profile was used.
- If vector_search or hybrid_search fails because no embedding profile is configured and no raw vector was
  given, say so and fall back to text_search, or ask the user to configure an embedding profile. If a
  search fails because the table lacks a full-text index, say so and fall back to a search the table
  supports.

Present the top rows as a compact markdown table; never dump raw embedding vectors.`,
};
