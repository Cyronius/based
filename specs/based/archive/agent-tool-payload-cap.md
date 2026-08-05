# Plan: bounded agent tool payloads + context-overflow recovery

## Symptom

A `run_query` against a table with a wide text column (`runs`, 21K+ chars per cell) killed the
agentic loop outright:

```
Engine protocol predict request returned 400:
request (1536114 tokens) exceeds the available context size (262144 tokens)
```

1.5M tokens against a 262K window. And it stayed dead: the next send — a deliberately tiny
`SELECT TOP 1 SUBSTRING(runs, 1, 500)` — failed the same way, because the poisoned tool result was
already persisted in the tab's thread and got replayed on every subsequent turn. The only escape
was "New chat", which throws away the whole conversation.

## Root cause

Two separate defects. Both have to be fixed; either alone leaves a bad experience.

### 1. Tool results cap row *count*, never cell *size*

Every core tool that returns rows bounds how many rows it hands the model and nothing else:

- [shared.ts:550-557](../../../core/src/agent/tools/shared.ts#L550-L557) — `run_query` does
  `rs.rows.slice(0, TOOL_PREVIEW_ROWS)` (50) with raw cell values
- [shared.ts:327-335](../../../core/src/agent/tools/shared.ts#L327-L335) — `read_table` returns
  `page.rows` verbatim, up to `AGENT_PAGE_CAP` = 200
- [shared.ts:427-431](../../../core/src/agent/tools/shared.ts#L427-L431) — `take_rows`, same
- [lancedb.ts:71-73](../../../core/src/agent/tools/lancedb.ts#L71-L73) — search hits, same (and
  these can carry raw embedding vectors)

50 rows × 21K chars ≈ 1M characters ≈ 260K tokens from a single tool call. The row cap is sized
for a *narrow* row and silently becomes meaningless on a wide one.

The UI half already got this right — [tabContext.ts:59-75](../../../ui/src/agent/tabContext.ts#L59-L75)
caps each cell at `CELL_CAP` = 300 chars before handing rows to `get_tab`/`show_results`. Core
never got the same treatment.

### 2. A context-overflow rejection is terminal

[server.ts:1218-1234](../../../core/src/server.ts#L1218-L1234) turns any stream error into a
`RUN_ERROR` frame and closes. That is correct for a real failure, but the oversized tool result is
already in `agent.db` by then, so every later turn on that thread re-sends it and re-fails. The
agent has no way to shed the payload it choked on. [memory.ts:15](../../../core/src/agent/memory.ts#L15)
constructs `new Memory({ storage })` with no recall bound at all.

## Fix

### A. `core/src/agent/toolPayload.ts` (new) — one bounded serializer

Pure module, no adapter/DB imports, so it unit-tests cleanly.

```ts
export const TOOL_CELL_CAP = 300;        // chars per cell, matches the UI's CELL_CAP
export const TOOL_PAYLOAD_CAP = 100_000; // chars per tool result, total

boundRows(rows, columns) -> { rows, rowsReturned, cellsTruncated, droppedForSize }
```

Rules:
- Stringify each cell; over `TOOL_CELL_CAP`, slice and append `…`.
- Arrays of numbers longer than 8 elements (embedding vectors) collapse to
  `[0.12, 0.34, … 1536 values]` — the model can never use the raw floats and they cost more than
  the rest of the row combined.
- Accumulate the running character total; stop adding rows once `TOOL_PAYLOAD_CAP` is crossed and
  report how many were dropped.
- Never silently truncate: the returned envelope carries `truncated: true` plus a `note` naming
  what was cut ("cell values over 300 chars truncated; 12 of 50 rows dropped to fit the payload
  budget — narrow the columns or use SUBSTRING/export_data for full values"). A model that knows
  it got a clipped value will re-query for the rest; one that doesn't will quote the clipped value
  as fact.

### B. Apply it at all four call sites

`run_query`, `read_table`, `take_rows`, and the LanceDB search serializer route their rows through
`boundRows` before returning. No change to row caps or tool schemas.

`export_data` and `save_file` are untouched — they write to disk and return a path, which is
already the right answer for "I need all the data".

### C. `core/src/agent/contextRecovery.ts` (new) — an `errorProcessor` that heals a poisoned thread

`@mastra/core@1.51` supports `errorProcessors` on the Agent config: a processor with
`processAPIError({ error, messages, messageList, retryCount })` returning `{ retry: boolean }`,
with a default retry cap of 10.

Recovery processor:
1. Match context-overflow rejections — `exceed_context_size_error`, and the equivalent
   `context_length_exceeded` / `prompt is too long` shapes from OpenAI and Anthropic. Anything
   else returns `{ retry: false }` and falls through to today's `RUN_ERROR`.
2. On match, drop the largest tool-result message from the list, replacing it with a stub
   (`[tool result dropped — too large for the context window; re-run the query with fewer columns
   or a SUBSTRING]`), and return `{ retry: true }`.
3. Cap at 3 attempts of our own; if the request still doesn't fit, fail with a plain-language
   message instead of the raw provider JSON.

Wire it in `buildAgent` ([agent.ts:89-106](../../../core/src/agent/agent.ts#L89-L106)) so both
top-level and subagent runs get it.

### D. Bound memory recall

`createAgentMemory` gets `options: { lastMessages: 40 }`. Cheap belt-and-braces: it bounds how far
back a poisoned message can be replayed even if C never fires.

## Spec impact

Two new requirements in `specs/based/spec.md`, next to BASED-AGENT-READ-ROWS:

- **BASED-AGENT-TOOL-PAYLOAD-CAP** (`unit`) — every row-returning tool bounds cell length, vector
  columns, and total payload size, and declares what it cut.
- **BASED-AGENT-CONTEXT-RECOVERY** (`integration`) — a context-overflow rejection sheds the
  offending tool result and retries rather than ending the run; the thread stays usable.

Modified: BASED-AGENT-READ-ROWS and BASED-LANCE-SCAN gain a sentence pointing at the payload cap
(their row caps are no longer the only bound). No requirement is removed.

## Tests

`specs/based/tests/unit.toolPayload.test.ts` (new) — real assertions, no stubs:
- A 21,000-char cell comes back at 301 chars and ends with `…`
- 50 rows × one wide column: payload stays under `TOOL_PAYLOAD_CAP`, `droppedForSize` > 0,
  `truncated` is true, and the note names both cuts
- A 1536-element number array collapses to a summary, not raw floats
- Narrow rows (the common case) pass through byte-for-byte unchanged with `truncated: false`

`specs/based/tests/integration.contextRecovery.test.ts` (new) — a fake model that throws an
`exceed_context_size_error` on the first call and succeeds on the second: the run completes, and
the retried request is smaller than the first.

Existing `unit.rowcap.test.ts` and the agent tool tests must still pass unchanged.

## Files

| File | Change |
|---|---|
| `core/src/agent/toolPayload.ts` | new — bounded serializer |
| `core/src/agent/contextRecovery.ts` | new — overflow error processor |
| `core/src/agent/tools/shared.ts` | route `run_query` / `read_table` / `take_rows` through it |
| `core/src/agent/tools/lancedb.ts` | same for search hits |
| `core/src/agent/agent.ts` | register `errorProcessors` |
| `core/src/agent/memory.ts` | `lastMessages: 40` |
| `specs/based/spec.md` | 2 new requirements, 2 amended |
| `specs/based/tests/unit.toolPayload.test.ts` | new |
| `specs/based/tests/integration.contextRecovery.test.ts` | new |

## As built (deltas from the plan above)

- **The vector-collapse rule was unnecessary.** The adapters already summarize vector and binary
  cells on the wire as `{$:"vec"}` / `{$:"bin"}` (BASED-LANCE-WIRE), so raw embeddings never reach
  a tool result in the first place. `boundRows` passes those summaries through untouched, and a
  test pins that.
- **`run_query`'s budget is shared across result sets.** Not called out in the plan: a batch
  returning five result sets would otherwise have spent the cap five times.
- **`read_table` keeps `hasMore` off the adapter's page**, not the size-bounded one — rows dropped
  to fit the budget must not read as the end of the table.
- **The plain-language `RUN_ERROR`** (plan step C.3) landed in `server.ts` rather than in the
  processor: by the time the stream errors, recovery has already tried and failed, which is exactly
  where the user-facing wording belongs.
- Both new requirements are verified by real tests (10 + 10 assertions passing); the whole-loop
  recovery test drives a real agent through a real LM Studio 400 and observes the retried request
  on the wire.

## Open question

`TOOL_PAYLOAD_CAP = 100_000` chars (~25K tokens) is sized for a 262K-token local model, leaving
room for the system prompt, the workspace context block, and several tool rounds. A cloud model
with a 200K+ window could afford more, and a small local one less. Making it a per-profile setting
is possible (`AiProfile` already carries `maxToolSteps` and `timeoutSeconds`) but adds a settings
surface. Starting with the constant; will revisit if the fixed value proves wrong in use.
