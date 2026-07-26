# Agent capability surface — critique response

## Context

An external critique of based's AI tool surface argues the agent has no way to learn **which
connection variant it is talking to**, so it guesses: it offers `run_mutation` on a read-only
LanceDB connection, reaches for `run_query` on Cloud where there is no SQL, and can't know whether
`nprobes` (IVF) or `ef` (HNSW) is the live knob because no tool reports the index type.

Most of it is right. Some of it is wrong about *why*, and one part is worse than described. This
plan records the verdict, then implements the whole list — including the parameter renames — with
the two items the user prioritised first: **deterministic engine/variant tool filtering** and
**index introspection surfaced in the table view**.

---

## Verdict on the critique

| Claim | Verdict |
|---|---|
| "No capability discovery — the agent has to infer engine type from `get_schema` output" | **Right in effect, wrong in mechanism.** Engine-level filtering already exists: [`agentSurfaceFor`](core/src/agent/surface.ts#L22) hands mssql and lancedb genuinely different toolsets, and [`unit.surface.test.ts`](specs/based/tests/unit.surface.test.ts) enforces it. What's missing is *variant*-level filtering (Cloud / local / base-folder) and any tool that **reports** capabilities. |
| "It will offer to fix data via `run_mutation` on a read-only LanceDB connection" | **Right, and worse than described.** `run_mutation` and `import_csv` are *frontend* tools ([capiTools.tsx:471,510](ui/src/agent/capiTools.tsx#L471)) passed unconditionally at [RightRail.tsx:98](ui/src/components/RightRail.tsx#L98). The engine surface never sees them, so `expect(names).not.toContain("run_mutation")` at [unit.surface.test.ts:52](specs/based/tests/unit.surface.test.ts#L52) is **false confidence** — the model really does see `run_mutation` in every LanceDB session, and BASED-LANCE-AGENT-SURFACE's acceptance criterion is unmet at runtime. |
| "It won't know to qualify `folder.main.table`" | **Right in substance.** The rule *is* stated ([LANCE_PERSONA:29](core/src/agent/tools/lancedb.ts#L29), `run_query` description) — but the agent is never told whether *this* connection is a base folder or what the folder names are, so it can't apply the rule. |
| "On Cloud it will reach for `run_query` for every aggregate" | **Right.** `run_query` is in the Lance toolset unconditionally and only fails at execute ([lancedb.ts:326](core/src/agent/tools/lancedb.ts#L326)). |
| "`read_rows` orderBy/filters are SQL-Server-only; filtered scan is impossible on LanceDB" | **Right, and cheap to fix.** Gated at [shared.ts:139](core/src/agent/tools/shared.ts#L139); [`LanceDbAdapter.readTablePage`](core/src/db/lanceAdapter.ts#L330) ignores both. `t.query().where(...)` works on every Lance connection including Cloud. |
| "`count_rows(where)` — no way to count rows on Cloud" | **Right.** `t.countRows(filter?)` exists and the SDK is already imported. |
| "Index introspection — the agent can't know IVF vs HNSW, unindexed rows, or FTS existence" | **Right, and the data is already fetched and thrown away.** [`vectorMetricsFor`](core/src/db/lanceAdapter.ts#L303) already calls `listIndices()` + `indexStats()` and keeps only `distanceType`, discarding `indexType`, `numIndexedRows`, `numUnindexedRows`, `numIndices`. |
| "No `vectorColumn` parameter" | **Right.** `t.vectorSearch(vector)` never calls `.column()`, which the SDK provides (`@lancedb/lancedb/dist/query.d.ts:299`). Tables with two embeddings are unreachable. |
| "`list_search_profiles` returns `model` but not dimension" | **Right** ([lancedb.ts:176](core/src/agent/tools/lancedb.ts#L176)). |
| "`floor` will be used backwards" | **Naming right, behaviour right.** [`applyFloorDelta`](core/src/db/lanceAdapter.ts#L493) *is* direction-aware — for `_distance` it correctly acts as a ceiling. Only the name lies. |
| "`sampleSize` is the worst name in the schema" | **Right.** It means candidate over-fetch pool; `sample_rows` sits two tools away meaning row sampling. |
| "`sample_rows` claims to be the only tool that returns raw rows" | **Right — stale.** `read_rows` is in `sharedTools` for both engines and works on Lance. Same stale claim in [mssql.ts:33](core/src/agent/tools/mssql.ts#L33) and [lancedb.ts:122](core/src/agent/tools/lancedb.ts#L122). |
| "`schema` is overloaded (SQL schema vs base-folder name)" | **Right.** |
| "`script_object` vs `get_schema(table)` are the same information" | **Right for LanceDB only** — the Lance `script_object` is `describeLanceSchema` over the same `getTableColumns`. Not true for SQL Server, where it emits real DDL from `getTableDetails`. Merge the Lance half only. |
| "`get_tab.maxRows` is `number` not `integer`" | **Right** ([capiTools.tsx:369](ui/src/agent/capiTools.tsx#L369)). |
| "22 required params + `anyOf: null` — models fill plausible values" | **Confirmed, and it fires on the shipped default provider.** Mastra's `OpenAISchemaCompatLayer.shouldApply()` matches on `provider.includes("openai")` — and our default provider registers under the literal name `"openai-compatible"` ([provider.ts:76](core/src/agent/provider.ts#L76)), so LM Studio gets it too. `postProcessJSONNode` then pushes **all 22** `vector_search` params into `required`, sets `additionalProperties: false`, and rewrites each optional as `anyOf: [{…}, {type:"null"}]`. Only Anthropic profiles escape. Splitting a `tuning` object is the right hedge. |
| "`run_mutation` promises generality it doesn't have where LanceDB is involved" | **Right, but not actionable as code today** — there is no Lance write path (`capabilities.write === false`). The actionable half is *exposure gating*; the design constraint gets recorded in the spec. |
| "Versioning I'd downgrade" | **Agree.** Sequenced last. |

**Two problems the critique missed**, found while verifying it:

- **`POST /api/agent/mutation` never checks `capabilities.write`** ([server.ts:720](core/src/server.ts#L720) → [`runMutation`:974](core/src/server.ts#L974) → `collectQuery` → `adapter.execute`). Every sibling write path does — CSV import at [server.ts:756](core/src/server.ts#L756), grid edit at [:943](core/src/server.ts#L943). So on a **local** LanceDB connection an approved `run_mutation` goes straight into the DuckDB/Lance bridge; only Cloud is saved, and only by accident (`execute` emits an error chunk there). Read-only is enforced by the *frontend* tool never being offered — except it is offered, unconditionally. That's the same bug twice.
- **Base-folder connections are structurally unreachable for duplicate table names.** `sample_rows` ([lancedb.ts:120](core/src/agent/tools/lancedb.ts#L120)) and all three search tools have **no** `schema`/folder parameter, so `resolveTable` throws "exists in multiple folders" ([lanceAdapter.ts:234](core/src/db/lanceAdapter.ts#L234)) with no way for the agent to disambiguate. Only `script_object` has the param.

---

## Design: one capability object, everything derived from it

`EngineCapabilities` ([types.ts:382](core/src/db/types.ts#L382)) is already the single gating
authority (BASED-CAPABILITIES-WIRE) and already rides `/api/session/connect` into the UI store.
Extend it instead of inventing a parallel channel — then the agent surface, the frontend tool map,
the persona, and the UI all read one source of truth.

```ts
export type ConnectionVariant = "mssql" | "lancedb-cloud" | "lancedb-local" | "lancedb-basefolder";

export interface EngineCapabilities {
  sql: boolean; search: boolean; write: boolean;
  orderedBrowse: boolean; script: boolean; relations: boolean;   // unchanged
  engine: DbEngine;
  variant: ConnectionVariant;
  /** Base-folder names — the qualifier in `folder.main.table`. Null unless variant is basefolder. */
  containers: string[] | null;
  /** `where` predicate string on readTablePage/countRows (Lance grammar). */
  wherePredicate: boolean;
  /** Structured column/op/value filters on readTablePage (T-SQL, parameterized). */
  structuredFilters: boolean;
  countRows: boolean;
  takeByKey: boolean;
  /** listIndices/indexStats or sys.indexes are available. */
  indexIntrospect: boolean;
  versions: boolean;
}
```

`MssqlAdapter` and `LanceDbAdapter` fill it; `LanceDbAdapter.capabilities` already branches on
`isCloud()` ([lanceAdapter.ts:60](core/src/db/lanceAdapter.ts#L60)) and knows `baseFolderDbs`.

---

## Design principle: stable names, variant-shaped descriptions

**A tool's name is identical across every engine and variant. What varies is its description and
its parameter list.** A stable name keeps conversation history coherent when the user switches
connections mid-thread, and the agent never learns three names for one concept. Because the surface
is generated deterministically from `EngineCapabilities`, every description can be
*unconditionally true* for the connection it was generated for — no more "on SQL Server you may
also…" prose conditionals the agent has to evaluate against a variant it can't see.

This supersedes today's shape in two places: `read_rows`/`sample_rows` collapse into one tool, and
`get_schema(table)`/`script_object` collapse into `describe_table`.

### Final tool surface

| Tool | mssql | lance-local | lance-basefolder | lance-cloud | Notes |
|---|:--:|:--:|:--:|:--:|---|
| `list_objects` | ✅ | ✅ | ✅ | ✅ | today's `get_schema` with no `table` — renamed, since the two responsibilities no longer share a tool |
| `describe_table` | ✅ | ✅ | ✅ | ✅ | replaces `get_schema(table)` **and** `script_object` |
| `read_table` | ✅ | ✅ | ✅ | ✅ | replaces `read_rows` **and** `sample_rows` |
| `count_rows` | ✅ | ✅ | ✅ | ✅ | new |
| `get_connection_info` | ✅ | ✅ | ✅ | ✅ | new |
| `get_indexes` | ✅ | ✅ | ✅ | ✅ | new |
| `run_query` | ✅ | ✅ | ✅ | ❌ | absent, not error-gated |
| `export_data` | ✅ | ✅ | ✅ | ✅ | `sql` source param absent on Cloud |
| `show_results` | ✅ | ✅ | ✅ | ✅ | replaces `open_query_tab`; see below |
| `take_rows` | ❌ | ✅ | ✅ | ✅ | new, Lance only |
| `vector_search` / `text_search` / `hybrid_search` | ❌ | ✅ | ✅ | ✅ | |
| `list_search_profiles` | ❌ | ✅ | ✅ | ✅ | + `dimension` |
| `list_table_versions` | ❌ | ✅ | ✅ | ✅ | new, Phase 6 |
| `run_mutation` / `import_csv` | ✅ | ❌ | ❌ | ❌ | frontend tools — filtered on `capabilities.write` |
| `list_tabs` / `get_tab` | ✅ | ✅ | ✅ | ✅ | |
| `load_skill` | ✅ | ✅ | ✅ | ✅ | |

### Per-variant parameter lists

| Tool | mssql params | lance params |
|---|---|---|
| `read_table` | `table, schema, offset, limit, orderBy, filters, columns` | `table, folder*, offset, limit, where, columns` |
| `count_rows` | `table, schema, filters` | `table, folder*, where` |
| `describe_table` | `table, schema, format: "columns"\|"ddl"` | `table, folder*, format: "columns"\|"pyarrow"` |
| `take_rows` | — | `table, folder*, keyColumn, keys, columns` |
| search tools | — | `table, folder*, query, vector, vectorColumn, k, columns, …, tuning{}` |

`folder` appears **only on base-folder connections** — local single-db and Cloud never see it. This
replaces the overloaded `schema` param the critique flagged, and fixes the structural bug that
`sample_rows` and all three search tools have no folder param at all today
([lanceAdapter.ts:234](core/src/db/lanceAdapter.ts#L234) throws "exists in multiple folders" with
no way for the agent to disambiguate).

### Description text (generated per variant)

`read_table` — **SQL Server**:
> Read a page of rows from a table or view. Pass `orderBy` for a stable page order and `filters` to narrow rows server-side (both validated server-side); page by increasing `offset`, and `hasMore` tells you whether another page may exist. Omit `orderBy` and `filters` for a quick unordered peek at example values.

`read_table` — **LanceDB local / base folder**:
> Read a page of rows from a Lance table, optionally narrowed by a `where` predicate. Page by increasing `offset`; `hasMore` tells you whether another page may exist. Vector cells are summarized rather than dumped in full — use `columns` to project further. `where` uses LanceDB predicate syntax, **not DuckDB SQL**: comparisons, `AND`/`OR`/`NOT`, `IN`, `LIKE`, `IS NULL` over scalar columns. No subqueries, JOINs, aggregates, or CTEs — use `run_query` for those.

`read_table` — **LanceDB Cloud** (same, minus the `run_query` pointer, plus the reason):
> …This connection has no SQL, so `where` is the only way to filter rows. …No subqueries, JOINs, or aggregates.

`count_rows` — **SQL Server**:
> Count rows in a table or view, optionally narrowed by `filters`. Call before paging with `read_table` to know how much there is, and before proposing a `DELETE` or `UPDATE` to know the blast radius.

`count_rows` — **LanceDB**:
> Count rows in a Lance table, optionally narrowed by a `where` predicate (same syntax as `read_table`). Cheap — call it before paging so you know the total, and before telling the user how large a result is.

`run_query` — **SQL Server**:
> Execute a read-only T-SQL query against this connection: aggregates, JOINs, GROUP BY, window functions, CTEs. Mutating statements are rejected — propose those through `run_mutation`.

`run_query` — **LanceDB local, single database**:
> Execute a read-only SQL query (**DuckDB dialect**) over this connection's Lance tables: aggregates, JOINs, GROUP BY, CTEs. Reads Lance files directly — this is a different grammar from the `where` predicates used by `read_table` and the search tools, so don't carry phrasing between them. Mutating statements are rejected; Lance connections are read-only.

`run_query` — **LanceDB base folder** (adds):
> Qualify every table as `folder.main.table` — an unqualified name will not resolve.

`take_rows` — **LanceDB**:
> Fetch specific rows by primary/id value — the follow-up to a search that returned ids, or to a user naming documents directly. Faster and more precise than a `where ... IN (...)` scan.

`describe_table` — **LanceDB**:
> Describe one table's schema. `format: "columns"` returns each column with type and nullability, and each vector column with its dimension, element type, and index metric. `format: "pyarrow"` additionally returns a pyarrow schema snippet for creating a compatible table. Schema only — never row data.

`describe_table` — **SQL Server**: same first sentence; `format: "ddl"` returns a `CREATE TABLE`
script (columns, PK, defaults, checks, FKs, indexes) instead of pyarrow. The drop / drop-create /
alter / select / insert variants of today's `script_object` stay as additional `format` values, so
no scripting capability is lost.

Search tools — append to `where` in all three:
> Uses LanceDB predicate syntax, not DuckDB SQL — no subqueries, JOINs, or aggregates. Same grammar as `read_table`'s `where`.

…and to `postfilter`:
> Applies `where` after the ANN search, so fewer than `k` rows may come back even when many rows match. Prefer prefiltering unless you have a reason not to.

### `show_results` — closing the Cloud gap

Dropping `open_query_tab` on Cloud would strip the "put data in a real grid, don't paste rows into
chat" norm from `GENERIC_CORE` ([agent.ts:29](core/src/agent/agent.ts#L29)) *precisely where the
agent also can't aggregate* — every Cloud answer would degrade to rows in chat. It must not simply
disappear.

Instead `open_query_tab` becomes **`show_results`**, present on every variant, dispatching on
capability:
- `caps.sql` → today's behaviour: open a query tab with the SQL and run it
  ([capiTools.tsx:422](ui/src/agent/capiTools.tsx#L422), `newQueryTabWithContent`
  [store.ts:1151](ui/src/store.ts#L1151)).
- Otherwise → open the table's **Data tab**, in Browse mode with a `where`, or in Search mode with
  a prefilled search request — the UI that already exists per BASED-LANCE-SEARCH-UI
  ([TableDataGrid.tsx](ui/src/components/TableDataGrid.tsx)). This needs a new store action
  (`openTableTabWithQuery`) alongside `newQueryTabWithContent`.

Params: `sql` (sql-capable variants) or `table` + `where` + optional `search` (Lance variants).

---

## Phase 1 — Capability discovery + deterministic tool filtering

**New:** `BASED-AGENT-CAPABILITY-DISCOVERY`, `BASED-AGENT-SURFACE-VARIANT`, `BASED-AGENT-SHOW-RESULTS`
**Modifies:** `BASED-LANCE-AGENT-SURFACE`, `BASED-CAPABILITIES-WIRE`, `BASED-AGENT-TAB-TOOLS`, `BASED-AGENT-MUTATION-GATE`

1. **Extend `EngineCapabilities`** (above) in [core/src/db/types.ts](core/src/db/types.ts) and its
   webview mirror [ui/src/api/types.ts](ui/src/api/types.ts); populate in both adapters.
2. **`agentSurfaceFor(caps, deps)`** — signature changes from `(engine, deps)` to take the whole
   capability object ([surface.ts:22](core/src/agent/surface.ts#L22)); `buildAgent`
   ([agent.ts:48](core/src/agent/agent.ts#L48)) passes `capabilities` instead of `engine`.
   Each tool becomes a **builder taking `caps`** and returning its variant-shaped description +
   parameter list (see "Final tool surface" above). Tools and params are **omitted, not
   error-gated**:
   - `run_query` only when `caps.sql` → a Cloud session never sees it.
   - `read_table`'s `orderBy`/`filters` only when `caps.structuredFilters`; `where` only when
     `caps.wherePredicate`; `folder` only when `caps.variant === "lancedb-basefolder"`.
   - `count_rows` / `take_rows` / `get_indexes` / `list_table_versions` only where supported.
   - `export_data`'s `sql` source param only when `caps.sql`.
   The existing execute-time guards stay as belt-and-braces.
   Practically this means the engine-split files ([mssql.ts](core/src/agent/tools/mssql.ts),
   [lancedb.ts](core/src/agent/tools/lancedb.ts)) stop being "different tools" and become
   "different `caps` branches of the same tool builders" for the shared names
   (`read_table`, `count_rows`, `describe_table`, `run_query`, `export_data`, `show_results`);
   the search tools stay Lance-only files.
3. **Persona becomes a function of capabilities.** `LANCE_PERSONA` turns into
   `lancePersona(caps)`: the base-folder qualification rule and the folder names appear only for
   `lancedb-basefolder`; the `run_query` bullet disappears entirely on Cloud. Same treatment for
   the `run_mutation`/`import_csv` bullets in `MSSQL_PERSONA` and the `open_query_tab` bullet in
   `GENERIC_CORE` ([agent.ts:24](core/src/agent/agent.ts#L24)).
4. **Filter the frontend tools too** — the real bug. In
   [RightRail.tsx:98](ui/src/components/RightRail.tsx#L98), build the tool map from `capiTools`
   filtered by the store's `capabilities`: drop `run_mutation` and `import_csv` when
   `!capabilities.write`. Keep `list_tabs`/`get_tab`/`open_query_tab` unconditional.
5. **Close the mutation hole (server-side).** Add the `capabilities.write` guard to
   [`POST /api/agent/mutation`](core/src/server.ts#L720), matching CSV import
   ([server.ts:756](core/src/server.ts#L756)) and grid edit ([:943](core/src/server.ts#L943)).
   Frontend filtering is UX; this is the actual enforcement, and it is missing today.
6. **`get_connection_info`** — new shared tool (both engines). Returns: engine, variant, connection
   name/database, every capability flag, `containers` (base-folder names) with the
   `folder.main.table` qualification rule spelled out, default embedding/reranker profile
   ids + models + dimensions, the row caps (`AGENT_ROW_CAP`, `AGENT_PAGE_CAP`, `EXPORT_ROW_CAP`),
   and the one-line search pipeline order. Advertised in `GENERIC_CORE` as the first call to make
   when the agent is unsure what it can do.
7. **`open_query_tab` → `show_results`** — the capability-dispatching version described above, plus
   the new `openTableTabWithQuery` store action so a Cloud session can still land rows in a grid.
   Ships in this phase because dropping `open_query_tab` on Cloud without it is a regression.
8. **Fix the test that lied.** `unit.surface.test.ts` gains a variant matrix (cloud/local/
   basefolder/mssql × expected tool names), and a new `unit.capiTools.test.ts` asserts the
   frontend map is filtered on `write`. An integration test asserts `/api/agent/mutation` returns
   a refusal on a LanceDB session.

## Phase 2 — Index introspection (core) + Details-tab panel (UI)

**New:** `BASED-INDEX-INTROSPECT`, `BASED-INDEX-UI`
**Modifies:** `BASED-LANCE-VECTOR-METRIC`, `BASED-TABLE-DETAILS`

1. **Widen `TableIndex`** ([types.ts:161](core/src/db/types.ts#L161)) with optional vector-engine
   fields — mssql leaves them undefined, so the existing Details rendering is unaffected:
   ```ts
   indexType?: string | null;        // "IVF_PQ" | "HNSW_SQ" | "FTS" | "BTREE" | …
   distanceType?: "l2"|"cosine"|"dot"|null;
   numIndexedRows?: number | null;
   numUnindexedRows?: number | null;
   numIndices?: number | null;
   ```
2. **New adapter method `getIndexes?(schema, table): Promise<TableIndex[]>`**, present when
   `capabilities.indexIntrospect`.
   - *LanceDB*: `listIndices()` + `indexStats(name)` — the **exact calls
     [`vectorMetricsFor`](core/src/db/lanceAdapter.ts#L303) already makes**. Refactor it to build
     the full `TableIndex[]` once, memoize *that*, and derive `vectorMetric` from it — so the
     existing per-column metric lookup and the new panel share one cached round-trip.
   - *SQL Server*: extract the index recordset already inside
     [`getTableDetails`](core/src/db/mssqlAdapter.ts#L443) (`sys.indexes`/`sys.index_columns`/
     `sys.columns`, rs1, assembled at `:507`) into a reusable helper so there is one query, not two.
3. **New adapter method `countRows?(schema, table, opts?)`** → `t.countRows(where)` on Lance;
   `SELECT COUNT_BIG(*)` with the existing parameterized filter builder on mssql.
4. **Server route** `GET /api/session/indexes?schema=&table=` next to
   [`/api/session/table-details`](core/src/server.ts#L404), gated on `capabilities.indexIntrospect`;
   plus `GET /api/session/row-count`.
5. **UI.** In [`fetchTableTabDetails`](ui/src/store.ts#L427), fetch indexes + row count for **both**
   branches (today the non-script branch only fetches columns) into
   `TableTabState.indexes` / `.rowCount`. In
   [TableDetailsView.tsx](ui/src/components/TableDetailsView.tsx):
   - Lift the **Indexes** section out of `DetailSections` (`:53-78`) so it renders from
     `tab.indexes` for both engines rather than only when `tab.details` exists (mssql-only today).
   - Vector-engine columns render conditionally: Type (`IVF_PQ`/`HNSW`/`FTS`/`BTREE`), Metric,
     Indexed rows, Unindexed rows.
   - **`numUnindexedRows > 0` shows a warning line** — this is the standard explanation for
     "search got slow" and for a row that search can't find.
   - **Zero indexes renders explicitly** ("No indexes — `text_search`/`hybrid_search` need a
     full-text index"), because absence is the actionable fact.
   - Add the row count to the header next to `{n} columns` ([:284](ui/src/components/TableDetailsView.tsx#L284)).
6. **Agent tools** `get_indexes` and `count_rows` over the same adapter methods. `get_indexes` is
   what makes `nprobes`-vs-`ef` a lookup instead of a guess; its description says so.

## Phase 3 — Close the scan/retrieval gaps

**New:** `BASED-LANCE-SCAN`, `BASED-LANCE-VECTOR-COLUMN`
**Modifies:** `BASED-AGENT-READ-ROWS`, `BASED-LANCE-BROWSE`, `BASED-LANCE-SEARCH-UNIFIED`, `BASED-LANCE-PROFILE-DISCOVERY`

1. **`where` on `readTablePage`** — add `where?: string` to the adapter opts; LanceDB applies
   `t.query().where(where)` ([lanceAdapter.ts:330](core/src/db/lanceAdapter.ts#L330)). This is the
   critique's top post-discovery item: it gives Cloud a filtered scan that returns *rows in table
   order*, not ANN-ordered results from an abused `vector_search`. It is also what makes
   `read_table` a single tool — `sample_rows` is just `read_table` with no `where` and a small
   `limit`, so it stops existing.
2. **`take_rows`** tool (Lance only) — `{table, folder?, keyColumn, keys[], columns?}`. Escapes
   literals **server-side** into an `IN (…)` predicate; the agent never hand-quotes. The common RAG
   follow-up, and impossible on Cloud today.
3. **`folder` param on every Lance tool** — `sample_rows`/`read_rows` and all three search tools
   have no folder parameter today, so a table name duplicated across base folders is unreachable
   (`resolveTable` throws, [lanceAdapter.ts:234](core/src/db/lanceAdapter.ts#L234)). Thread
   `schema` through `LanceSearchRequest` → `adapter.search` → `resolveTable`, exposed to the agent
   as `folder` only on base-folder connections.
4. **`vectorColumn`** — add to `LanceSearchRequest`/`LanceSearchParams`
   ([types.ts:300](core/src/db/types.ts#L300)); apply `.column(name)` on the vector branch
   ([lanceAdapter.ts:600](core/src/db/lanceAdapter.ts#L600)) and after `.nearestTo(...)` on the
   hybrid branch (`:610`). Feed `assertVectorDimension` the *named* column. Surface a column picker
   in the Data-tab search controls when a table has more than one vector column.
5. **Dimension in `list_search_profiles`** — add an optional `dimension` to the embedding-profile
   record, editable in the Search settings tab and auto-filled from the first successful
   `embedQuery` response ([embeddings.ts](core/src/db/embeddings.ts)). `list_search_profiles`
   returns it, so profile↔column compatibility is a single-tool check instead of cross-tool
   reasoning. The existing runtime guard (BASED-LANCE-EMBED-DIM-GUARD) stays as the backstop.

## Phase 4 — Naming, schemas, and descriptions

**New:** `BASED-SEARCH-PARAM-NAMES`
**Modifies:** `BASED-LANCE-SEARCH-KNOBS`, `BASED-LANCE-SEARCH-UI`, `BASED-SCRIPT-OBJECT`, `BASED-AGENT-READ-ROWS`, `BASED-AGENT-SCHEMA-CTX`

The tool *merges* land with their own phases (`read_table` in Phase 3, `describe_table`/`get_indexes`
in Phase 2). This phase is the sweep that makes the rest consistent: the renamed wire fields, the
generated descriptions, and syncing the `lance-search` skill, the settings UI controls, `spec.md`,
and the tests to the new vocabulary.

Renames land **everywhere** (wire type, adapter, server route, agent tools, UI controls,
`lance-search` skill, spec, tests) — this is a breaking change to `/api/session/search`:

| Old | New |
|---|---|
| `floor` | `minScore` |
| `delta` | `maxScoreGapFromTop` |
| `sampleSize` | `candidatePool` |
| `distanceRangeLower/Upper` | unchanged — documented as the engine-side pushdown variant |
| `read_rows` + `sample_rows` | `read_table` (both engines) |
| `get_schema(table)` + `script_object` | `describe_table(format)` (both engines) |
| `get_schema()` (no table) | `list_objects` |
| `open_query_tab` | `show_results` |
| `schema` param on Lance tools | `folder`, base-folder connections only |

`describe_table` on SQL Server keeps every action of today's `script_object` as `format` values
(`columns`, `ddl`, `drop`, `drop-create`, `alter`, `select`, `insert`) over the existing pure
[`scriptObject`](core/src/db/scripter.ts) — the name changes, the DDL capability does not.

Also:
- **Split a `tuning` object** out of `vector_search`/`hybrid_search`: `distanceType`, `nprobes`,
  `ef`, `refineFactor`, `postfilter`, `bypassVectorIndex`, `distanceRangeLower/Upper` move under
  one nested field. Cuts the top-level parameter count roughly in half and reduces the surface a
  strict-mode model feels obliged to populate.
- **Document the pipeline order once, in all three search tools:**
  `probe (nprobes/ef) → prefilter (where, unless postfilter) → candidatePool → rerank (rerankTopN)
  → threshold (minScore/maxScoreGapFromTop) → k`, plus the clamping rules already in
  [`search`](core/src/db/lanceAdapter.ts#L575) (`k ≤ candidatePool`; `rerankTopN` clamped to
  `candidatePool`).
- **Replace `where`'s "(not SQL DML)" disclaimer** with the actual supported subset: comparisons,
  `AND`/`OR`/`NOT`, `IN`, `LIKE`, `IS [NOT] NULL`, single-quoted string literals, dotted struct
  access, `array_has_any`/`array_length` for list columns; **no** subqueries, joins, or aggregates.
- **Split the overloaded `schema` param.** Lance tools take `folder` (base-folder name, values
  listed by `get_connection_info`) and only on base-folder connections; mssql tools keep `schema`.
  `schema` stays accepted as a deprecated alias on the wire for one release.
- **The stale "only tool that returns raw rows" claims disappear with the tools that carried them**
  ([mssql.ts:33](core/src/agent/tools/mssql.ts#L33),
  [lancedb.ts:122](core/src/agent/tools/lancedb.ts#L122)) — `read_table` is now the single answer,
  which is why merging beats re-wording.
- **Grammar confusion gets named explicitly.** `run_query` (DuckDB SQL) and `where` (Lance
  predicate) are two grammars one connection exposes at once; every description that mentions
  either now says so and points at the other. This is the failure the "(not SQL DML)" disclaimer
  was gesturing at and missing.
- **`get_tab.maxRows`** → `"type": "integer"` ([capiTools.tsx:369](ui/src/agent/capiTools.tsx#L369)).

## Phase 5 — Export reach

**Modifies:** `BASED-AGENT-EXPORT`, `BASED-GRID-EXPORT-STANDARD`

1. **`jsonl`** writer alongside [csv.ts](core/src/export/csv.ts)/[xlsx.ts](core/src/export/xlsx.ts) —
   trivial, no new dependency.
2. **`parquet`** via the already-present `@duckdb/node-api`: in-memory instance, register the rows,
   `COPY (SELECT * FROM t) TO '<path>' (FORMAT PARQUET)`.
   ⚠️ This pulls the DuckDB native binding into **mssql** sessions, which today only load it for
   local Lance. [lanceSql.ts:66](core/src/db/lanceSql.ts#L66) documents a real Windows
   load-failure mode. Load it lazily, only when `format === "parquet"`, and surface the same
   named error rather than a bare `undefined is not an object`.
3. **Search results become exportable** — add a third `ExportSource` kind
   ([exportData.ts:15](core/src/export/exportData.ts#L15)):
   `{ kind: "search"; request: LanceSearchRequest }`, collected via `adapter.search()`. Fixes the
   critique's "a vector search's output can't leave the chat".

## Phase 6 — Versioning (last, low value)

**New:** `BASED-LANCE-VERSIONS` — `list_table_versions` tool over `t.version()`/`t.listVersions()`,
plus a "v{n}" chip in the Details header. Read-only "what changed", nothing more.

## Phase 7 — Spec-only: the run_mutation constraint

No code. Record in `spec.md` under `BASED-AGENT-MUTATION-GATE` that a future LanceDB write surface
**cannot** be expressed as SQL text through `run_mutation`: `merge_insert`, `add_columns` with
expressions, `alter_columns`, and predicate `delete` are SDK API calls, not DDL. They will need
distinct proposal tools with their own approval cards. This constrains the design before anyone
builds it.

---

## Files touched (representative)

- **Capabilities/types**: [core/src/db/types.ts](core/src/db/types.ts), [ui/src/api/types.ts](ui/src/api/types.ts)
- **Adapters**: [core/src/db/lanceAdapter.ts](core/src/db/lanceAdapter.ts), [core/src/db/mssqlAdapter.ts](core/src/db/mssqlAdapter.ts)
- **Agent surface**: [core/src/agent/surface.ts](core/src/agent/surface.ts), [core/src/agent/agent.ts](core/src/agent/agent.ts), [core/src/agent/tools/shared.ts](core/src/agent/tools/shared.ts), [core/src/agent/tools/lancedb.ts](core/src/agent/tools/lancedb.ts), [core/src/agent/tools/mssql.ts](core/src/agent/tools/mssql.ts), [core/src/agent/skills/lanceSearch.ts](core/src/agent/skills/lanceSearch.ts)
- **Server**: [core/src/server.ts](core/src/server.ts) (indexes / row-count routes, search-param renames)
- **Export**: [core/src/export/exportData.ts](core/src/export/exportData.ts) + new `jsonl.ts` / `parquet.ts`
- **UI**: [ui/src/components/RightRail.tsx](ui/src/components/RightRail.tsx) (capability-filtered tool map), [ui/src/agent/capiTools.tsx](ui/src/agent/capiTools.tsx) (`show_results`, `maxRows` integer), [ui/src/components/TableDetailsView.tsx](ui/src/components/TableDetailsView.tsx) (index panel), [ui/src/components/TableDataGrid.tsx](ui/src/components/TableDataGrid.tsx) (vector-column picker, agent-driven open), [ui/src/store.ts](ui/src/store.ts) (`openTableTabWithQuery`, index/row-count fetch), [ui/src/api/client.ts](ui/src/api/client.ts)
- **Spec**: [specs/based/spec.md](specs/based/spec.md), plan archived to `specs/based/archive/`

## Reuse — don't rebuild

- `EngineCapabilities` + BASED-CAPABILITIES-WIRE is the existing gating channel; extend it, don't add a second one.
- `vectorMetricsFor` ([lanceAdapter.ts:303](core/src/db/lanceAdapter.ts#L303)) already makes the exact `listIndices`/`indexStats` calls the index panel needs — refactor, don't duplicate.
- `getTableDetails`'s index recordset ([mssqlAdapter.ts:443](core/src/db/mssqlAdapter.ts#L443)) is the SQL Server index query — extract it.
- `DetailSections`' Indexes table ([TableDetailsView.tsx:53](ui/src/components/TableDetailsView.tsx#L53)) is the existing renderer — lift it, don't write a second one.
- `resolveEmbeddingProfile`/`resolveRerankerProfile` ([searchProfileResolve.ts](core/src/db/searchProfileResolve.ts)), `applyFloorDelta`, `assertVectorDimension`, `collectQuery`, `auditRead`, `sanitizeExportFileName`, `IconButton` — all already exist.

---

## Verification

**Unit** (`bun test` in `specs/`) — write first, per the workflow:
- `unit.surface.test.ts`: variant matrix — the four variants × the tool table above. Asserts both directions: `lancedb-cloud` has **no** `run_query` and `lancedb-local` does; `folder` is a param only on `lancedb-basefolder`; `orderBy`/`filters` only on mssql; `where` only on Lance; **and that the shared names are byte-identical across variants** (the stable-name principle — a test that fails the moment someone adds `read_table_lance`).
- new `unit.toolDescriptions.test.ts`: every generated description is checked against the variant it was generated for — no description mentions a tool or param absent from that same surface (this is what makes "unconditionally true" enforceable rather than aspirational).
- new `unit.capiTools.test.ts`: the frontend map drops `run_mutation`/`import_csv` when `!capabilities.write`.
- new `unit.connectionInfo.test.ts`: `get_connection_info` output matches the adapter's capabilities for each variant.
- `unit.readRows.test.ts` → `unit.readTable.test.ts`: `where` accepted only when `wherePredicate`; params absent otherwise; the small-limit no-`where` call reproduces old `sample_rows` output.
- new `unit.searchParams.test.ts`: `minScore`/`maxScoreGapFromTop`/`candidatePool` map to the same filtering `floor`/`delta`/`sampleSize` produced (behaviour unchanged by the rename).
- `unit.exportData.test.ts`: jsonl + parquet round-trip; `kind:"search"` source.

**Integration** (live dev LanceDB + SQL Server, per the existing `integration.lancedb.test.ts` / `integration.mssql.test.ts` patterns):
- `getIndexes` returns `indexType`/`numIndexedRows`/`numUnindexedRows` for an IVF-indexed table and `[]` for an unindexed one *(self-skip if index training fails on the small fixture, matching BASED-LANCE-VECTOR-METRIC's existing note)*.
- `countRows(where)` matches a `run_query` `COUNT(*)` on a local connection.
- `readTablePage` with `where` returns table-ordered filtered rows.
- `vector_search` with `vectorColumn` targets the named column on a two-embedding fixture; omitting it on such a table returns a clear error.
- mssql `getIndexes` matches the `indexes` array inside `getTableDetails` for the same table.

**Manual / e2e** (procedures documented in `manual.ui.test.ts`):
1. Connect **LanceDB Cloud** → ask "aggregate rows by source" → the agent uses search/`count_rows`, and **never proposes `run_query`** (it isn't in its list). Ask "fix this row" → it says the connection is read-only without proposing `run_mutation`.
2. Connect **LanceDB base folder** → ask "how many rows in X" → it qualifies `folder.main.table` on the **first** try.
3. Open a Lance table → **Details** tab → Indexes panel shows type/metric/indexed/unindexed; a table with unindexed rows shows the warning; a table with none shows the "no indexes" line. Row count appears in the header.
4. Open a SQL Server table → Details → the existing Indexes section is unchanged; row count appears.
5. Data tab → Search → the vector-column picker appears only on a multi-embedding table.
6. Ask the agent to export a vector search to Parquet → file lands in Downloads and opens.
7. **Cloud regression for `show_results`**: on a Cloud connection ask "show me rows where source = 'discord'" → the agent calls `show_results` and the rows land in a **real Data-tab grid**, not pasted into chat. This is the norm that would have been silently lost by dropping `open_query_tab` on Cloud.
8. **Thread continuity across a connection switch**: start a thread on SQL Server, call `read_table`, switch the connection to LanceDB Cloud, ask a follow-up → the agent calls `read_table` again with Lance params. The stable-name principle is only worth anything if this works.

---

## Outcome (archived)

Phases 1–4 and 7 implemented; Phases 5 (export formats) and 6 (versioning) deliberately not — the
user scoped them out. Durable requirements merged into `spec.md` as BASED-AGENT-SURFACE-VARIANT,
BASED-AGENT-CAPABILITY-DISCOVERY, BASED-INDEX-INTROSPECT, BASED-LANCE-SCAN,
BASED-LANCE-VECTOR-COLUMN, BASED-LANCE-EMBED-DIM, BASED-SEARCH-PARAM-NAMES,
BASED-AGENT-SHOW-RESULTS, and rewrites of BASED-LANCE-AGENT-SURFACE, BASED-AGENT-READ-ROWS,
BASED-SCRIPT-OBJECT, BASED-AGENT-SCHEMA-CTX, BASED-AGENT-MUTATION-GATE and BASED-CAPABILITIES-WIRE.

Two things found while implementing that the plan didn't anticipate:

- **Lance predicates are DataFusion-flavoured.** `"id" IN (…)` parses the double-quoted name as a
  *string literal*, so `take_rows` silently matched nothing. Caught by its own test on first run.
  Identifiers go bare, or backtick-quoted when not a plain name.
- **The default instruction set can't hold a persona string any more.** Personas are generated per
  variant, so `resolveById("default", …)` returns `persona: null` meaning "use the generated one";
  only a user's custom set pins a fixed string. The settings UI still shows the representative
  rendering for reading and forking.

Not done, and deliberately: Phase 5's Parquet export. It would pull the DuckDB native binding into
mssql sessions that never load it today, and `lanceSql.ts:66` documents a real Windows
load-failure mode — the riskiest item on the list for the least value.

## Follow-up: the custom-persona downgrade, closed

The variant work made the built-in persona connection-aware, which silently made *forking* it a
downgrade — a custom set was a fixed string, so it couldn't adapt. (Not a regression: custom sets
were fixed strings before too. The default got better and custom stayed put.)

Closed by splitting the prompt's engine half in two:

- **`mssqlBriefing(caps)` / `lanceBriefing(caps)`** — facts about this connection. Generated,
  injected between core and persona, and deliberately *not* overridable by anything.
- **`MSSQL_PERSONA` / `LANCE_PERSONA`** — voice and policy. Editable, and variant-neutral by
  construction: `unit.surface.test.ts` fails if `run_query`, `folder.main.table`, `folder`,
  `take_rows`, or "read-only" appears in a persona.

A custom set now overrides only the voice, so forking costs nothing — `buildAgent` takes a `persona`
override but has no briefing override at all, and a test asserts a fully custom persona still
contains the connection's briefing. `resolveById` returns plain strings again; the `persona: null`
sentinel is gone.

The editor shows each briefing read-only beneath its persona, marked "this connection" when it was
rendered from the live adapter. Without that the split is invisible: a user seeing a persona that
never mentions the available tools would helpfully write them back in by hand, pinned to whichever
connection they had in mind — reintroducing exactly the staleness the split removes.
