# Plan: DuckDB-backed execution plan + client statistics for local LanceDB SQL

## Problem

The TabStrip "Execution Plan" and "Client Statistics" toggles are global and not
capability-gated ([TabStrip.tsx:149-172](../../../ui/src/components/TabStrip.tsx#L149-L172));
`store.ts:895` forwards `{ capturePlan, captureStats }` into **every** `execute()`.
The MSSQL adapter honors them via `SET STATISTICS XML/IO/TIME` (`planWrap.ts`), but the
Lance/DuckDB bridge (`core/src/db/lanceSql.ts`) reads only `opts.rowCap` in `runStatement` —
both toggles are silent no-ops on local LanceDB connections. Wire them up with DuckDB.

## Chosen approach (de-risked against installed DuckDB v1.5.5)

Single-execution profiling to a temp file:

- `EXPLAIN ANALYZE (FORMAT json)` is **rejected** by this build (`syntax error at or near "FORMAT"`).
- `SET enable_profiling='json'; SET profiling_mode='standard'; SET profiling_output='<file>'`
  captures the **actual** runtime profile of the normal query run. Verified output carries:
  - top-level: `latency` (s), `cpu_time` (s), `rows_returned`, `cumulative_rows_scanned`,
    `cumulative_cardinality`, `system_peak_buffer_memory`, `total_bytes_read/written`
  - `children[]` operator tree: `operator_type`, `operator_cardinality` (actual rows),
    `operator_timing` (self seconds), `extra_info` (`Table`, `Filters`, `Estimated Cardinality`,
    `Order By`, `Groups`, `Projections`, …)

Because the profile comes from the real run, **results still stream to the grid** (no second
execution, no side effects — the build is read-only). Each query runs on its own DuckDB
connection that is closed in `finally`, so profiling settings cannot leak to a later query —
no defensive OFF prefix (unlike the pooled-connection MSSQL path).

## Spec impact

Two new requirements (both `integration`, home repo hosts the test), plus a shared-UI note.

### New: BASED-LANCE-SQL-PLAN — Actual execution plan for local LanceDB SQL
**Applies to:** based (core), based (ui) · **Test category:** integration

When `capturePlan` is set, the Lance bridge enables DuckDB JSON profiling to a temp file, runs
each statement normally (results unaffected), then reads the profile and emits one
`{type:"plan", format:"duckdb-json", json}` chunk **per statement** carrying the operator tree.
The `plan` `QueryChunk` becomes a discriminated union keyed by `format`
(`"showplan-xml"` for MSSQL, `"duckdb-json"` for DuckDB); the shared `PlanView` graph renders
both by parsing to the common `PlanOperator` tree.

**Acceptance criteria:**
- `capturePlan:true` on a table-touching SELECT → exactly one `{type:"plan",format:"duckdb-json"}`
  chunk whose JSON parses to a non-empty operator tree with a scan node naming the table; the
  normal resultset is unaffected (no extra "Results" tab).
- A 2-statement script with `capturePlan:true` → one plan chunk per statement.
- `capturePlan:false` → zero plan chunks (current behavior preserved).

### New: BASED-LANCE-SQL-STATS — Client statistics for local LanceDB SQL
**Applies to:** based (core) · **Test category:** integration

When `captureStats` is set, the bridge surfaces the same profile's summary as ordinary
`{type:"message"}` chunks (Output pane) — total latency (ms), CPU time, rows returned, rows
scanned, peak memory — mirroring how MSSQL client stats arrive as messages (BASED-CLIENT-STATS).

**Acceptance criteria:**
- `captureStats:true` on a real SELECT → message chunk(s) containing recognizable text
  (`latency`/`ms`, `rows returned`, `rows scanned`).
- `captureStats:false` → no such messages.

### Amend: BASED-LANCE-SQL-GATING (manual note)
Note that the Execution Plan graph now renders for local LanceDB runs via the shared `PlanView`
(format-dispatched parser), and both capture toggles are functional — not just MSSQL.

## Implementation

**core/src/db/types.ts** — plan chunk → union:
```ts
| { type: "plan"; format: "showplan-xml"; xml: string }
| { type: "plan"; format: "duckdb-json"; json: string }
```

**core/src/db/mssqlAdapter.ts** — add `format: "showplan-xml"` to its plan emit (~line 457).

**core/src/db/lanceSql.ts** — in `execute`/`runStatement`, when `capturePlan||captureStats`:
1. Once before the statement loop: `SET enable_profiling='json'`, `SET profiling_mode='standard'`,
   `SET profiling_output='<tmp>'` (temp file under `os.tmpdir()`, unique per execute()).
2. After each statement's stream fully drains (before the next statement), read the temp file;
   parse JSON. Guard: if the run was cap-truncated or the file is missing/short, skip silently.
3. `capturePlan` → emit `{type:"plan",format:"duckdb-json",json:<children-tree>}`.
4. `captureStats` → emit `{type:"message",text}` summary line(s).
5. Best-effort unlink the temp file in `finally`.

**ui/src/duckPlan.ts** (new) — `parseDuckPlanJson(json): PlanOperator[]`:
- `physicalOp` ← `operator_type` (humanized), `logicalOp` ← `extra_info.Type ?? ""`
- `actualRows` ← `operator_cardinality`; `estimateRows` ← `extra_info["Estimated Cardinality"]`
- `estimatedTotalSubtreeCost` ← **cumulative** `operator_timing` (self + children) so the existing
  `layoutPlan` cost% math (self = subtree − Σchildren) recovers each operator's self-time share
- `object` ← `extra_info.Table`; `predicate` ← `extra_info.Filters ?? Order By ?? Groups`
- `estimateIO`/`estimateCPU` ← null (DuckDB doesn't split them; DetailPanel hides null rows)

**ui/src/store.ts** — `tab.plan: PlanDoc[]` where `PlanDoc = {format, data}`; update the
`case "plan"` accumulation to push `{format: chunk.format, data: chunk.xml ?? chunk.json}`.

**ui/src/components/PlanView.tsx** — accept `PlanDoc[]`; `SinglePlanCanvas` dispatches on
`format` (`parsePlanXml` vs `parseDuckPlanJson`). Add a few DuckDB operator glyphs to
`OPERATOR_GLYPHS` (SEQ_SCAN/TABLE_SCAN→▤, HASH_GROUP_BY→Σ, HASH_JOIN→⋈, ORDER_BY→⇅, TOP_N/LIMIT,
PROJECTION→ƒ, FILTER→▽); the `?? "▢"` fallback already covers the rest.

**ui/src/components/ResultsPane.tsx** — `hasPlan`/`tab.plan!` typing follows `PlanDoc[]`
(no logic change beyond the type).

## Tests

- **specs/based/tests/integration.lanceSql.test.ts** (+): `capturePlan` case (one duckdb-json plan
  chunk, tree non-empty, results intact), 2-statement plan case, `captureStats` case (message text),
  and a negative (toggles off → no plan/stats).
- **specs/based/tests/unit.duckPlan.test.ts** (new): pure `parseDuckPlanJson` over a captured
  fixture JSON → asserts operator mapping (actualRows, object, predicate, cumulative cost).

## Out of scope
- Capability-gating the toggles (they now work for local Lance; still dead for Lance **Cloud** —
  Cloud `execute` already returns a graceful error, so a capture toggle there is harmless).
- Reworking DetailPanel labels ("Subtree Cost" reads as seconds for DuckDB — meaningful, kept).
