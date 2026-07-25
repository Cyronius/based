# Rerank document text: smarter column heuristic, length cap, UI picker

The rerank "document" heuristic picks the *first* non-vector string column, so a table whose
first string column is an id/ref (e.g. `memory_facts.source_ref`) sends hash junk to the
reranker — every candidate scores a hard 0 while the actual prose sits in `text`. The Data
tab also has no way to override the column, even though the wire request supports
`rerankTextColumn` end-to-end. Separately, unbounded document text overflows small local
rerankers' context windows (LM Studio then silently returns empty completions with no
logprobs).

## Spec impact

**Modified: BASED-LANCE-RERANK-PIPELINE**
- Heuristic becomes: a conventionally-named content column (`text`, `content`, `body`,
  `document`, `chunk`, `passage`, `summary`, `description`, `message`) if present, else the
  string column with the longest values across the sampled candidates, else the first
  non-vector column. Explicit `rerankTextColumn` still always wins.
- New: document text is capped at 6000 characters before being sent to the rerank endpoint
  (both api shapes).

**Modified: BASED-LANCE-RERANK-PROFILES (manual procedure)**
- The Data tab search toolbar gains a "Rerank column" picker (auto + the table's string
  columns), shown when a reranker is selected, feeding `rerankTextColumn`.

No requirements added/removed.
