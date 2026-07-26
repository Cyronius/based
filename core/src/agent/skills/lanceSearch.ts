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

Searching by meaning or keywords uses three dedicated tools; pick by intent.

**Search is for relevance ranking, not for filtering.** If the user's question is an exact condition
("rows where source = 'discord'"), use \`read_table\` with a \`where\` predicate — it returns rows in
table order. Never run a throwaway search just to attach a filter to it: you'd get ANN-ordered
results, not the rows. Use \`count_rows\` to size the answer, and \`take_rows\` to fetch specific ids.

## Choosing a search
- **vector_search** — "find rows *like* / *about* / *similar to* X" (meaning-based). Pass \`query\` text
  and it's embedded automatically via the session's embedding profile (pass \`embeddingProfileId\` to pick
  a specific one), or pass a raw \`vector\` directly. Returns a \`_distance\` column (smaller = closer).
  On a table with more than one embedding column, name one with \`vectorColumn\`.
- **text_search** — "find rows *containing* / *mentioning* these words" (exact keywords, names, codes).
  Requires a full-text index on the searched text column.
- **hybrid_search** — when you want both semantic relevance and keyword precision (e.g. a concept plus a
  specific term). Fuses vector + full-text internally with reciprocal rank fusion; returns a
  \`_relevance_score\`.

## The pipeline, once
\`probe (nprobes/ef) → prefilter (where, unless postfilter) → candidatePool → rerank (rerankTopN) →
threshold (minScore/maxScoreGapFromTop) → k\`

\`candidatePool\` is the over-fetch pool, *not* a row sample: everything downstream selects from it, so
\`k\` is clamped to it and \`rerankTopN\` never scores more than it. Raise it when a selective \`where\` or
a reranker is starving the result set.

\`minScore\` and \`maxScoreGapFromTop\` are direction-aware based-side thresholds on whatever the final
score column is. "min" always means "keep the better ones": against \`_distance\` (lower is better)
\`minScore\` enforces an upper bound; against \`_relevance_score\`/\`_rerank_score\` a lower one.

A \`rerankerProfileId\` swaps the ordering to \`_rerank_score\`. Tune it with \`rerankTopN\`,
\`rerankTemperature\`, and \`rerankTextColumn\` — set \`rerankTextColumn\` to the column holding the real
document text; the default is a first-text-column heuristic that can pick a title-ish field and
starve the reranker.

## Tuning knobs (vector_search / hybrid_search only, nested under \`tuning\`)
**Call \`get_indexes\` before you touch any of these.** \`nprobes\` does nothing without an IVF index and
\`ef\` does nothing without an HNSW one — set the wrong one and you'll conclude the knob is broken. On
an unindexed column the search is already exact and they are all harmless no-ops (except the distance
range, which always bounds). A large \`numUnindexedRows\` is the usual reason a search got slow or
missed a row that was recently added.
- **Recall too low / expected row missing** — raise \`nprobes\` (IVF: more partitions probed) or \`ef\`
  (HNSW: wider candidate list). Then add \`refineFactor\` (e.g. 5–10) to re-rank a larger candidate pool
  with exact vectors.
- **Ground truth check** — \`bypassVectorIndex: true\` skips the ANN index entirely (slow, exact). Use it
  to judge whether the index is costing recall ("is the index lying to me?"), not for routine queries.
- **\`where\` + few results** — the default prefilter can starve the ANN search when the predicate is
  selective. Try \`postfilter: true\` with a larger \`candidatePool\` — but note postfiltering can return
  fewer than \`k\` rows even when many rows match.
- **Score bounds** — \`distanceRangeLower\`/\`distanceRangeUpper\` bound \`_distance\` engine-side and are
  the pushdown variant of \`minScore\`; prefer \`minScore\`/\`maxScoreGapFromTop\` when a reranker is in
  play, since those apply to \`_rerank_score\`.
- **\`distanceType\`** — l2 | cosine | dot for the query. Caveat: when the column has an ANN index, the
  index's own metric governs the search; describe_table and get_indexes both show it, so match it (or
  bypassVectorIndex to compare metrics exactly).

## Two grammars, one connection
\`where\` (here and on read_table) is **LanceDB predicate syntax**: comparisons, AND/OR/NOT, IN, LIKE,
IS [NOT] NULL over scalar columns, single-quoted strings, dotted struct access. No subqueries, JOINs,
aggregates, or CTEs. \`run_query\` — where the connection has it — is **DuckDB SQL**, a different
grammar entirely. Don't carry phrasing between them.

## Before searching
1. Call \`describe_table\` to see which column is the vector (and its dimension) and which text columns
   exist. Never guess column names.
2. Call \`get_indexes\` if you're about to tune, or if a search is behaving oddly.
3. Use \`read_table\` with a small \`limit\` if you need to see the shape of real values.

## Phrasing & reading results
- For vector_search, write the \`query\` as the *meaning* you want, not keywords — a short natural phrase
  embeds better than a boolean expression.
- Narrow with \`where\` and \`columns\` to keep results small.
- Rank by \`_distance\` (ascending) for vector search, \`_relevance_score\` (descending) for hybrid, or
  \`_rerank_score\` (descending) when a reranker profile was used.
- If vector_search or hybrid_search fails because no embedding profile is configured and no raw vector was
  given, say so and fall back to text_search, or ask the user to configure an embedding profile. If a
  search fails because the table lacks a full-text index, say so and fall back to a search the table
  supports.

Present the top rows as a compact markdown table; never dump raw embedding vectors.`,
};
