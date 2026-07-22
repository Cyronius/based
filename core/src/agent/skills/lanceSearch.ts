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

LanceDB has no SQL. You retrieve rows with three tools; pick by intent.

## Choosing a search
- **vector_search** — "find rows *like* / *about* / *similar to* X" (meaning-based). Pass \`query\` text
  if the table has a registered embedding function; otherwise pass a raw \`vector\`. Returns a
  \`_distance\` column (smaller = closer).
- **text_search** — "find rows *containing* / *mentioning* these words" (exact keywords, names, codes).
  Requires a full-text index on the searched text column.
- **hybrid_search** — when you want both semantic relevance and keyword precision (e.g. a concept plus a
  specific term). Reranks with reciprocal rank fusion; returns a \`_relevance_score\`.

## Before searching
1. Call get_schema on the table to see which column is the vector (and its dimension) and which text
   columns exist. Never guess column names.
2. Use \`sample_rows\` if you need to see the shape of real values.

## Phrasing & reading results
- For vector_search, write the \`query\` as the *meaning* you want, not keywords — a short natural phrase
  embeds better than a boolean expression.
- Narrow with \`where\` (a LanceDB filter predicate like \`year > 2020\`, not SQL) and \`columns\` to keep
  results small.
- Rank by \`_distance\` (ascending) for vector search or \`_relevance_score\` (descending) for hybrid.
- If a search fails because the table lacks an embedding function or a full-text index, say so and fall
  back to a search the table supports.

Present the top rows as a compact markdown table; never dump raw embedding vectors.`,
};
