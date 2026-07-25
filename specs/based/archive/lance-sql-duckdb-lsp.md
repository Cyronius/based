# Plan: Lance SQL tab (embedded DuckDB) + LSP for both engines + lazy engine deps

## Context

LanceDB connections currently have no SQL surface — `LanceDbAdapter.execute()` hard-errors and the
UI hides the query editor for the engine. The `@lancedb/lancedb` SDK only offers SQL-*style* filter
predicates, not real SQL. But DuckDB now ships **`lance` as a core extension** (windows_amd64
supported): `ATTACH '<dir>' (TYPE lance)` lets DuckDB scan `.lance` files directly with pushdown —
real SELECT/JOIN/GROUP BY plus `lance_vector_search()`/`lance_fts()` in SQL. This plan gives local
LanceDB connections a SQL tab identical in UX to the MSSQL one, adds real LSP-protocol language
intelligence to the editor for **both** engines, and makes all engine-specific native deps
(`mssql`, `@lancedb/lancedb`, `@duckdb/node-api`) lazy-load at connection time.

Decisions already made (do not re-litigate):

- Embed DuckDB via **`@duckdb/node-api`** (^1.5.5-r.1). The old `duckdb` npm package is deprecated.
  Known-good combo: Bun ≥ 1.2.2 + node-api ≥ 1.5.1-r.2 (we run Bun 1.3.14).
- **No LSP exists for DuckDB/DataFusion/Arrow SQL** (researched thoroughly) → build a small
  **in-house LSP server in TypeScript inside core** for the Lance/DuckDB dialect, sourced from the
  embedded DuckDB (`autocomplete` extension `sql_auto_complete()` + `duckdb_tables/columns/functions()`).
- **sqls** (github.com/sqls-server/sqls, v0.2.48, prebuilt Windows binary, schema-aware MSSQL
  completion) provides LSP for the SQL Server tab — spawned per MSSQL connection, stdio-bridged.
- UI keeps **plain `monaco-editor`** — a thin hand-rolled LSP client over WebSocket (LSP JSON-RPC,
  one message per WS frame), mapped onto Monaco provider APIs. No monaco-languageclient/@codingame
  fork migration.
- **LanceDB Cloud (`db://`) gets no SQL tab** — the lance extension reads storage, not the cloud
  API. `capabilities.sql` stays false there.

## Spec impact

New requirements (new section `## Lance SQL + LSP` in `spec.md`):

| ID | Summary | Test category |
|---|---|---|
| BASED-LAZY-ENGINES | Importing `@based/core` evaluates no engine dep; async `createAdapter` dynamic-imports per engine; adapters importable via `@based/core/mssql` / `@based/core/lancedb` subpaths | integration |
| BASED-LANCE-SQL | DuckDB-backed `execute()` for local Lance: correct QueryChunk stream, base-folder namespaces + cross-namespace JOIN, `{$:"vec"}` vector cells, rowCap truncation, best-effort cancel, descriptive error when extension INSTALL fails | integration |
| BASED-LANCE-SQL-GATING | SQL affordances keyed off `capabilities.sql` (local Lance true, cloud false); engine-appropriate quoting in generated snippets | manual |
| BASED-LSP-TRANSPORT | `/api/lsp` WebSocket endpoint: auth-gated upgrade, one JSON-RPC msg per frame, backend torn down on disconnect/close/stop | integration |
| BASED-LSP-DUCKDB | In-house Lance/DuckDB LSP: table/column/function completions + hover from live catalog; catalog-only fallback when autocomplete extension unavailable | integration |
| BASED-LSP-MSSQL | sqls: pinned-version+hash download to dataDir, spawn + stdio↔WS bridge, `workspace/configuration` answered locally with DSN (never sent to browser), sql-login only, kill on disconnect | integration (env-gated) + manual |
| BASED-LSP-UI | Thin Monaco LSP client: completions/hover/diagnostics; full graceful degradation to today's editor when LSP unavailable | manual |
| BASED-LANCE-AGENT-SQL | Agent `run_query` tool on local Lance (read-only gated), persona updated | integration |

Modified requirements: **BASED-LANCE-UI** (SQL-hidden claim now scoped to Cloud only),
**BASED-CAPABILITIES-WIRE** (TabStrip/LeftRail/newQueryTab added to capability readers),
**BASED-LANCE-ENGINE** (`createAdapter` now async), **BASED-LANCE-AGENT-SURFACE** (drop "no
run_query" phrasing).

## Implementation order

### Phase 1 — Lazy engine loading (small, isolated, keeps suite green)

- `core/src/db/adapterFactory.ts`: `createAdapter` → `async`, per-branch
  `const { MssqlAdapter } = await import("./mssqlAdapter")` etc. Static string specifiers keep
  bundler analyzability; modules just don't *evaluate* until first use. Delete the top-level adapter
  imports. Only two callers: `connectSession` (`core/src/server.ts:136`, already async — add
  `await`) and `testConnection` (same file as factory, already async).
- `core/src/index.ts`: remove concrete `MssqlAdapter`/`LanceDbAdapter` re-exports. Add subpath
  exports to `core/package.json`: `"./mssql": "./src/db/mssqlAdapter.ts"`,
  `"./lancedb": "./src/db/lanceAdapter.ts"`. Update the specs tests that import the classes from
  the barrel (`integration.lancedb.test.ts`, `integration.mssql.test.ts`,
  `integration.server.test.ts`, `integration.agent.test.ts`) to the subpaths.
- Test `integration.lazyEngines.test.ts`: child `bun -e` imports `@based/core` and asserts neither
  engine module evaluated (via `require.cache` if Bun populates it — verify; fallback: source-level
  assertion that index/factory contain no static adapter imports) + async factory resolves the
  right class per engine, engine-less config → mssql (preserves BASED-LANCE-ENGINE).

### Phase 2 — DuckDB-under-Bun spike (gate for everything below; before any UI work)

Throwaway scratchpad script, looped ~20×: dynamic-import `@duckdb/node-api` → create `:memory:`
instance → `INSTALL lance; LOAD lance;` → ATTACH a temp-seeded Lance dir (reuse the `beforeAll`
seeding pattern from `specs/based/tests/integration.lancedb.test.ts`) → SELECT, two-namespace JOIN,
`lance_vector_search()` → close. Verify and record:

1. napi load + finalization stability under Bun 1.3.14 on Windows (the known-crash class was fixed
   in node-api 1.5.1-r.2, but Bun-on-Windows is the least-tested leg).
2. Exact error text when extension download is blocked (informs UI error copy). Extensions land in
   `%USERPROFILE%\.duckdb`.
3. Streaming-read API shape (`stream()` / `streamAndReadAll` / `fetchChunk`), whether
   `connection.interrupt()` (or pending-result cancel) exists, whether ATTACH/LOAD are
   instance-scoped or connection-scoped, multi-statement handling (`extractStatements`?).
4. JS value classes for Lance `FixedSizeList` vector columns, TIMESTAMP, BIGINT — drives the
   `WireValue` mapping.
5. `INSTALL autocomplete; LOAD autocomplete;` + `sql_auto_complete('SELECT * FR')` works.

### Phase 3 — Lance SQL execution (core)

**New `core/src/db/lanceSql.ts` — `LanceSqlBridge`**, owned by `LanceDbAdapter`, created lazily on
first SQL use (first `execute()` or first LSP attach — connect/browse must not pay DuckDB startup
or need network). Memoized init promise:

1. `await import("@duckdb/node-api")` (the only import site of the package).
2. In-memory instance → `INSTALL lance; LOAD lance;`. Failure → typed `LanceSqlSetupError` with
   actionable copy (mentions extensions.duckdb.org download + `%USERPROFILE%\.duckdb`); `execute()`
   turns it into `{type:"error"}` + `{type:"done",status:"error"}` chunks. Don't cache the failure —
   retry next run.
3. ATTACH: single-db → `ATTACH '<dir>' AS db (TYPE lance); USE db;`. Base-folder → one
   `ATTACH '<dir>/<sub>' AS "<sub>" (TYPE lance)` per subfolder (namespace = subfolder name,
   mirroring `listObjects()` schema mapping). Always double-quote; reject folder names containing
   `"` with a clear error.

`execute(sql, onChunk, opts): QueryExecution` mirrors `mssqlAdapter` shape: emit
`resultset` (names + DuckDB type names) → `rows` batches (reuse the existing row-cap plumbing,
`opts?.rowCap ?? this.rowCap`) → `resultsetEnd {rowCount, truncated}` → `done {durationMs, status}`.
Once cap exceeded, stop fetching entirely (`truncated:true` — document the small semantic
difference vs MSSQL which counts the true total). `cancel()`: flag checked between chunk fetches +
best-effort `interrupt()` per spike → `cancelled` chunk, `status:"cancelled"`.

Value mapping `duckToWire()`: vector columns detected from column type metadata → reuse
`serializeLanceValue(v, true)` (`core/src/db/lanceSerialize.ts`) for `{$:"vec",dim,preview}`;
BigInt → number when safe-integer else string; DuckDB date/timestamp objects → `Date`/string;
lists/structs → JSON summary via `serializeLanceValue(v, false)`; `Uint8Array` → `{$:"bin"}`.

**`core/src/db/lanceAdapter.ts`**: `capabilities` becomes a getter —
`{ ..., sql: !this.isCloud() }` (safe pre-connect; `isCloud()` reads only cfg). Store the resolved
local dir at connect. `execute()`: cloud → graceful error reworded for Cloud; local → delegate to
lazily-constructed bridge. `disconnect()` closes the bridge. Add internal
`ensureSqlBridge(): Promise<LanceSqlBridge>` for the LSP server (not on the `DatabaseAdapter`
interface).

Server: no query-path changes — `streamQuery` already gates on `adapter.capabilities.sql`, and
connect/state responses already carry capabilities.

Tests: `integration.lanceSql.test.ts` — temp-seeded dir (+ base-folder fixture), drive
`LanceDbAdapter.execute` with a chunk-collector; network-dependent cases self-skip when
`INSTALL lance` fails but assert the error path in that branch.

### Phase 4 — UI gating + copy

- `ui/src/store.ts` `newQueryTab()`: replace engine check with `capabilities.sql` guard.
- `ui/src/components/TabStrip.tsx:22`: `capabilities?.sql ?? true` instead of
  `engineOf === "mssql"` (default true when disconnected; click no-ops via store guard).
- `ui/src/components/LeftRail.tsx:135`: split the gates — database selector stays mssql-only;
  schema filter shows whenever schemas exist (base-folder Lance populates it).
- `ui/src/components/ConnectionDialog.tsx` (~140): mode-aware copy — Local: "gets a SQL editor
  (DuckDB engine with the Lance extension)…"; Cloud keeps the no-SQL wording.
- `ensureSqlView` (store): engine-aware quoting for generated `SELECT * FROM …` — `[s].[t]` for
  mssql, `"s"."t"` / bare name for lancedb (small `quoteForEngine` helper in `ui/src/lib/`).
- `QueryTabView`/`EditorPane`/`ResultsPane`: no changes (engine-agnostic). Reuse the existing
  `"query"` tab kind — no new tab kind.

### Phase 5 — LSP subsystem (core) + thin client (ui)

**Transport** (`core/src/server.ts` + new `core/src/lsp/index.ts`): `/api/lsp` upgrade route
(auth-gated; refuse un-connected sids or `!capabilities.sql`), `websocket` handlers on the existing
`Bun.serve`. **One WS = one LSP connection per session**; engine resolved server-side; per-tab
documents ride the standard LSP multi-document model (`based:///{tabId}.sql` URIs). One JSON-RPC
message per WS text frame (no Content-Length framing on the wire). Backend disposed on session
disconnect/close/server stop. Backends dynamically imported per engine (preserves lazy loading).

**`core/src/lsp/protocol.ts`**: minimal hand-rolled JSON-RPC endpoint + the LSP types we use — no
`vscode-languageserver` dependency.

**`core/src/lsp/duckdbLsp.ts` — in-house server**: full-document sync (docs are small query tabs),
`initialize` advertises completion (trigger chars `.`, space, `"`), hover, utf-16 positions.
Completions: `sql_auto_complete(?)` on text-up-to-cursor (param-bound) mapped to `textEdit`s via
`suggestion_start`; merged/fallback catalog completions from `duckdb_tables()/duckdb_columns()/
duckdb_functions()` (+ keyword list) with ~5s cache — catalog-only mode when the autocomplete
extension can't install. Hover: word → table/column/function lookup, markdown; vector columns
described as `FLOAT[n] — Lance vector column`. No diagnostics in v1 (no safe parse-only API
confirmed); wire path left in place.

**`core/src/lsp/sqlsBridge.ts` + `sqlsBinary.ts` — MSSQL**: download-on-first-use (not vendored) —
pinned v0.2.48 GitHub release zip, pinned SHA-256, extracted to `dataDir()/bin/sqls-v0.2.48/`,
atomic temp-dir+rename. `Bun.spawn` (precedent: `core/src/dialogs.ts`), stdio Content-Length
framing bridged ↔ WS frames. sqls' `workspace/configuration` request answered **locally** with
`{sqls:{connections:[{driver:"mssql", dataSourceName: DSN}]}}` — DSN built from ConnectionConfig +
`getSecret` (go-mssqldb URL form; map encrypt/trustServerCertificate; host/port via the existing
`parseServer` convention) and **never forwarded to the browser**. Scope: sql-login connections
only; Entra sessions get no MSSQL LSP backend (UI degrades gracefully). Crash → notify client,
close WS, max 2 respawns per session. `dispose()`: shutdown/exit with 1s deadline then kill.

**UI (`ui/src/lsp/`)**:
- `client.ts`: WebSocket JSON-RPC client (request/notify/onNotification, 10s request timeout,
  initialize/initialized handshake, exponential backoff reconnect while store says
  `connected && capabilities.sql`). Vite dev proxy needs `ws: true` on the `/api` entry.
- `manager.ts`: singleton watching `(activeConnectionId, status, capabilities)` via
  `useStore.subscribe` — creates/replaces/disposes the client. Syncs **all live query-tab models**
  (not just active): add `onModelCreated/onModelDisposed` listener hooks to
  `ui/src/editorModels.ts`; didOpen on ready, debounced (250ms) full-text didChange, didClose on
  dispose, re-didOpen all on reconnect.
- `providers.ts`: registered once globally for language `"sql"` from `main.tsx` — completion
  provider (LSP↔Monaco kind/range/position mapping; 0-based vs 1-based conversion), hover
  provider, `publishDiagnostics` → `setModelMarkers`. When no client: return empty (Monaco's
  built-in word suggestions = today's behavior).

Graceful-degradation matrix (must all hold): server down / WS refused / extension offline / sqls
missing / Entra MSSQL / request timeout → providers empty, no markers, editor fully functional.

Tests: `integration.lsp.test.ts` — real `startServer()`, HTTP-connect a session to a seeded Lance
dir, drive the WS handshake + completion/hover from bun:test. sqls cases env-gated like
`integration.mssql.test.ts`.

### Phase 6 — Agent surface

- `core/src/agent/tools/lancedb.ts`: add `run_query` cloned from the mssql tool — reuse the
  engine-agnostic `collectQuery` + `isReadOnly` helpers; gate at execute time on
  `capabilities.sql`; description covers DuckDB dialect, `folder.table` qualification,
  `lance_vector_search()`/`lance_fts()`.
- `LANCE_PERSONA`: reword — local connections support read-only DuckDB SQL; search tools remain the
  primary semantic/keyword path; cloud has no SQL.

## Dependencies

- `core/package.json`: `"@duckdb/node-api": "^1.5.5-r.1"` + `exports` subpaths.
- `ui/vite.config.ts`: `ws: true` on the `/api` proxy.
- No new UI packages. Never the deprecated `duckdb` package.

## Key risks

1. **Bun+napi on Windows** — settled by the Phase 2 spike before any dependent work.
2. **Extension downloads need network** (lance + autocomplete → `%USERPROFILE%\.duckdb`) —
   first-class error paths with actionable copy; retried per run, not cached.
3. **DuckDB node-api result/interrupt specifics** — spike verifies; cancel degrades to
   stop-reading if `interrupt()` is absent.
4. **sqls DSN parameter details** (encrypt/TrustServerCertificate casing) — verify manually against
   v0.2.48 before locking the env-gated test. Entra auth explicitly out of scope for sqls.
5. **Base-folder namespace quoting** — always double-quote ATTACH aliases; reject `"` in names.

## Verification

1. `cd specs && bun test .` — full suite green including the three new integration files.
2. Manual (BASED-LANCE-SQL-GATING / BASED-LSP-UI, procedures appended to the manual test file):
   connect a local base-folder Lance dir → "+" query tab appears → run a cross-folder JOIN → grid
   shows rows, vector cells render as `{$:"vec"}` chips → completions offer folder/table/column
   names → hover a column shows its type. Connect LanceDB Cloud → no SQL affordance anywhere.
   Connect MSSQL (sql-login) → completions become schema-aware (sqls); kill the sqls process →
   editor keeps working, completions fall back to word-based.
3. Offline check: block network, fresh profile → running SQL on a Lance connection shows the
   descriptive extension-install error in the Output pane; editor and browse features unaffected.
