# based — canonical spec

Requirement prefix: `BASED`. Home repo: `based`.
Architecture reference: [.claude/plans/feasibility-and-architecture.md](../../.claude/plans/feasibility-and-architecture.md).

Test infrastructure: `bun test` from `specs/` (`bun test` is the doctrine deviation recorded in the Phase 1 plan — app runtime is Bun). Integration tests target a real Azure SQL dev DB via AzureCliCredential and self-skip when unavailable.

---

## Connections & auth

### BASED-CONN-STORE: Connection metadata persistence
**Applies to:** based (core)
**Test category:** integration

Connections (name, server, initial database, auth type, options) shall persist in the local SQLite store across restarts. Secrets are never written to this store.

**Acceptance criteria:**
- Create → list returns the connection with identical fields; reopening the store still returns it
- Update changes fields in place (same id); delete removes the row
- The stored record contains no password/client-secret material

### BASED-SECRET-STORE: Secrets in Windows Credential Manager
**Applies to:** based (core)
**Test category:** integration

SQL-login passwords and service-principal client secrets shall be stored in Windows Credential Manager keyed by connection id, retrievable by the core process, and deleted when the connection is deleted.

**Acceptance criteria:**
- `setSecret(id, s)` → `getSecret(id)` returns `s`
- `deleteSecret(id)` → `getSecret(id)` returns null
- Deleting a connection through the connections API removes its secret

**Implementation note (packaging, no spec impact):** `@napi-rs/keyring`'s loader reassigns `require = createRequire(__filename)` so it resolves its native `.node` binding relative to its own package when run unbundled (validated directly under Bun). electrobun's Bun bundler inlines `__filename` as the store path and lets that reassignment clobber the bundle-global `require` (`import.meta.require`), so the platform binary — which the bundler copies next to the output `index.js` — is resolved against the wrong directory and fails to load as a misleading "Cannot find native binding". Fixed in [shell/electrobun.config.ts](../../shell/electrobun.config.ts) with a `Bun.build` `onLoad` plugin that strips the reassignment for the shell bundle only (core's direct-Bun path and these tests are unaffected). Upstream this is an electrobun 1.18.1 bundler bug with napi-rs loaders that reassign `require`; the config plugin is a rebuild-surviving workaround. If keyring loading breaks again after an electrobun upgrade, re-check that plugin.

### BASED-CONN-TEST: Test connection
**Applies to:** based (core)
**Test category:** integration

The connect-test operation shall attempt a real connection + `SELECT 1` with the supplied config and return success, or failure with the underlying error text.

**Acceptance criteria:**
- Valid config (dev DB, azure-cli auth) → `{ ok: true }` with server version populated
- Unreachable server → `{ ok: false }` with a non-empty error message

### BASED-AUTH-AZCLI: Azure CLI credential auth
**Applies to:** based (core)
**Test category:** integration

Auth type `azure-cli` shall acquire an Entra token via AzureCliCredential and connect with `azure-active-directory-access-token`.

**Acceptance criteria:**
- With an active `az login`, connecting to the dev DB succeeds and `SELECT SUSER_SNAME()` returns the signed-in identity

### BASED-AUTH-INTERACTIVE: Entra ID interactive browser auth
**Applies to:** based (core)
**Test category:** manual

Auth type `entra-interactive` shall launch the system browser, capture the redirect on a local loopback listener (`InteractiveBrowserCredential`), and connect with the resulting token.

**Verification procedure:** create a connection with auth type "Entra ID (interactive)", Test Connection → browser opens → sign in → dialog reports success. **Result: PASS** (verified 2026-07-22 against the dev DB; the only issue hit was the target DB being restricted to SQL auth, a database-config constraint, not a code defect).

### BASED-AUTH-SQLLOGIN: SQL login auth
**Applies to:** based (core)
**Test category:** manual

Auth type `sql-login` shall connect with username + password (password from Credential Manager).

**Verification procedure:** create a connection with a SQL auth login on any reachable SQL Server, Test Connection → success; wrong password → readable failure.

### BASED-AUTH-SP: Service principal auth
**Applies to:** based (core)
**Test category:** manual

Auth type `service-principal` shall acquire a token via ClientSecretCredential (tenant id + client id + secret from Credential Manager) and connect.

**Verification procedure:** create a connection with a service principal that has DB access, Test Connection → success.

---

## Engine / adapter

### BASED-MSSQL-OBJECTS: Schema object enumeration
**Applies to:** based (core)
**Test category:** integration

The adapter shall list databases on the server, schemas in the current database, and user objects (tables, views, stored procedures, functions) with their schema names, excluding ms-shipped objects.

**Acceptance criteria:**
- Dev DB: databases list contains the current database; schemas list contains `dbo`
- Objects list is non-empty, every entry has `schema`, `name`, and `type` ∈ {table, view, procedure, function}, and contains at least one known table

### BASED-MSSQL-COLUMNS: Table column introspection
**Applies to:** based (core)
**Test category:** integration

For a given table/view the adapter shall return columns with name, type name, max length / precision / scale, nullability, and PK/FK membership.

**Acceptance criteria:**
- A known dev-DB table returns ≥1 column; its PK column reports `isPrimaryKey: true`
- A varchar column reports its length; a nullable column reports `nullable: true`

### BASED-BATCH-GO: Client-side GO batch splitting
**Applies to:** based (core)
**Test category:** unit

SQL text shall split into batches on lines containing only `GO` (case-insensitive, surrounding whitespace and trailing line comment allowed), like SSMS. Empty batches are dropped.

**Acceptance criteria:**
- `"SELECT 1\nGO\nSELECT 2"` → 2 batches
- `"SELECT 1\ngo  -- comment\nSELECT 2"` → 2 batches
- `"SELECT 'GO'"` and `"SELECT 1 GO"` → 1 batch (GO not alone on a line)
- `"SELECT 1\nGO\n\nGO"` → 1 batch

### BASED-MULTI-RESULTSET: Multiple result sets per execution
**Applies to:** based (core)
**Test category:** integration

Executing text containing multiple SELECTs (within one batch or across GO batches) shall produce one result set per SELECT, each with its own columns, rows, and row count, in order.

**Acceptance criteria:**
- `"SELECT 1 AS a; SELECT 2 AS b, 3 AS c\nGO\nSELECT 4 AS d"` → 3 result sets with column names `[a]`, `[b,c]`, `[d]` and 1 row each

### BASED-CANCEL: Cancel in-flight query
**Applies to:** based (core)
**Test category:** integration

A running execution shall be cancellable; cancellation ends the stream promptly with a cancelled status, not an unhandled error, and the connection remains usable.

**Acceptance criteria:**
- Cancel during `WAITFOR DELAY '00:00:30'` completes the execution as cancelled in < 5 s
- A subsequent `SELECT 1` on the same adapter succeeds

### BASED-ERROR-TEXT: Real SQL error text
**Applies to:** based (core)
**Test category:** integration

SQL errors (syntax, permissions, timeout, runtime) shall surface as error chunks carrying the server's message text — never a silent failure or process crash.

**Acceptance criteria:**
- `"SELECT FROM"` → error chunk whose message mentions the syntax problem (`Incorrect syntax near ...`)
- `"SELECT 1/0"` → error chunk containing "Divide by zero"
- Execution after an error batch continues with remaining GO batches reported (SSMS behavior: batch-scoped failure)

### BASED-EXEC-PLAN: Actual execution plan capture
**Applies to:** based (core)
**Test category:** integration

`execute()` shall accept a `capturePlan` option that wraps each GO-batch with `SET STATISTICS XML ON`/`OFF` and emits the resulting plan XML (one document per statement) as a `{type:"plan"}` chunk, never as a spurious grid resultset. SQL Server's showplan resultset is recognized by its stable, version-independent single-column name (`Microsoft SQL Server 2005 XML Showplan`) and diverted before it reaches the normal row-collection path. A batch whose first statement is `CREATE PROCEDURE/VIEW/FUNCTION/TRIGGER` is returned completely unwrapped (capture skipped, with a notice message) since `CREATE` must be the first statement in its batch and even the defensive OFF prefix would violate that. Note: a trivial constant query (e.g. `SELECT 1`) does not reach SQL Server's normal plan-generation path and never emits a plan — the underlying table access must be real.

**Acceptance criteria:**
- `capturePlan: true` against a real table-touching SELECT → exactly one `{type:"plan"}` chunk containing well-formed `<ShowPlanXML` text, and the normal resultset is unaffected (no extra "Results N" tab)
- A multi-statement batch with `capturePlan: true` → one plan chunk per statement
- Cancelling a capture-enabled run does not leak `SET STATISTICS XML/IO/TIME ON` onto the pooled connection: a second query run afterward is completely clean (no plan chunks, no stray stats messages) — the very next query may carry one harmless echoed stats message (inherent SQL Server behavior: a statement executed while STATISTICS TIME is still on prints its own stats, even the OFF statement that turns it off)
- A batch starting with `CREATE PROCEDURE` with `capturePlan`/`captureStats` requested still runs successfully and emits a "capture skipped" message rather than erroring

### BASED-CLIENT-STATS: Client statistics capture
**Applies to:** based (core)
**Test category:** integration

`execute()` shall accept a `captureStats` option that wraps each GO-batch with `SET STATISTICS IO, TIME ON`/`OFF`. This output arrives over the same TDS INFO-token channel as `PRINT`, so it needs no new chunk type — it surfaces as ordinary `{type:"message"}` chunks through the existing Output pane.

**Acceptance criteria:**
- `captureStats: true` against a real table-touching SELECT → message chunks contain recognizable IO/TIME text (`logical reads`, `CPU time`)

### BASED-RECONNECT-RETRY: Token-expiry / dropped-connection retry
**Applies to:** based (core)
**Test category:** unit

When connect/execute fails with a retryable condition (expired Entra token, closed/reset socket), the adapter shall re-mint the token, rebuild the pool, emit a "reconnecting" status, and retry with bounded exponential backoff (up to `MAX_RECONNECT_ATTEMPTS` total tries) so a blip that outlasts one retry — a brief failover, a longer network hiccup — still self-heals without the user re-running anything; exhausting the cap propagates the error rather than retrying forever. A pool-level socket error while idle (no operation in flight) proactively rebuilds in the background on the same backoff, instead of only reacting to the next user-initiated operation.

**Acceptance criteria:**
- Fake pool that fails once with token-expiry then succeeds → operation succeeds, status callback saw `reconnecting`, token minted twice
- Fake pool that always fails → error propagates after exactly `MAX_RECONNECT_ATTEMPTS` attempts, with backoff (`delay`) invoked between each
- Non-retryable error (syntax) → no retry, 1 attempt
- Fake pool that fails `MAX_RECONNECT_ATTEMPTS - 1` times then succeeds → operation succeeds without exhausting the cap

### BASED-VALUE-SAFETY: Safe cell serialization
**Applies to:** based (core)
**Test category:** unit

Cell values shall serialize to a JSON-safe wire form that distinguishes SQL NULL, renders binary/varbinary/geography/geometry as a tagged summary (not raw bytes), and formats temporal values as SQL-style strings.

**Acceptance criteria:**
- SQL NULL → wire `null`; string `"null"` stays a string
- `Buffer` → `{ $: "bin", len, preview }` with hex preview capped
- `Date` → `"YYYY-MM-DD HH:mm:ss.mmm"`; strings/numbers/booleans pass through

### BASED-ROWCAP: Display row cap
**Applies to:** based (core)
**Test category:** unit

Each result set shall cap the rows forwarded to the client at a configured maximum (default 50,000), continue counting the true total where cheap, and mark the result set truncated.

**Acceptance criteria:**
- Cap 10, 25 input rows → 10 rows forwarded, `truncated: true`, `rowCount` 25
- Cap 10, 10 input rows → 10 rows, `truncated: false`

---

## Server

### BASED-API-AUTH: Per-launch API token
**Applies to:** based (core)
**Test category:** integration

Every `/api/*` request shall require the per-launch bearer token (SSE may pass it as a query parameter); requests without it get 401 and no work is performed.

**Acceptance criteria:**
- `GET /api/connections` without token → 401; with token → 200
- SSE `/api/events` without token → 401

### BASED-HISTORY: Query history
**Applies to:** based (core)
**Test category:** integration

Every user-initiated execution shall append a history row (connection, database, SQL text, started-at, duration, status ok/error/cancelled, error text if any) to the local store, retrievable most-recent-first.

**Acceptance criteria:**
- After an execution completes, history returns it with status `ok` and duration ≥ 0
- A failed execution records status `error` with the message

### BASED-TABSTORE: Tab persistence
**Applies to:** based (core)
**Test category:** integration

Tabs of every kind — query (content, optional file path), table/view (schema, table, object type, current sub-view), and routine (schema, name, routine type) — shall persist automatically, scoped by connection id and kind-specific metadata, so a restart restores each connection's full tab set. Persistence is a per-connection **replace**: saving a connection's tabs mirrors the currently-open set, pruning any previously-persisted tab (of any kind) that is no longer open, so restore never accumulates tabs beyond what was open at exit.

**Acceptance criteria:**
- Upsert one tab of each kind (query, table, routine) for a connection, each with its kind-specific `meta` → list for that connection returns all three in order with `kind` and `meta` intact after store reopen
- Delete removes a tab; tabs are scoped per connection id
- `replaceForConnection(connId, subset)` prunes persisted tabs absent from `subset` (of any kind) and keeps those present, in order; an empty array clears the connection; other connections are untouched; result survives store reopen

### BASED-WINDOW-RESTORE: Per-window session restore
**Applies to:** based (core, ui, shell)
**Test category:** manual

On launch, the app shall reopen one native window per window that was still open when it last exited (cleanly or via kill), each reconnecting to its last connection and restoring its active tab and schema filter. A window that was closed cleanly before the app exited shall not be reopened. Each window's state (connection id, active tab id, schema filter) is keyed by the same per-window session id (`sid`) the backend already uses to give each window an independent DB session — the shell reuses a window's prior `sid` across restarts instead of minting a fresh one, so window state and DB session share one durable key.

**Acceptance criteria (`WindowStateStore`, integration-tested):**
- Save connection/active-tab/schema-filter for a sid → get returns it; `list()` returns all rows; survives store reopen
- Deleting a sid's row removes it from `list()`; deleting a connection cascades to remove every window_state row referencing it

**Manual verification (multi-window relaunch):**
1. Open 2 windows (Ctrl+N), connect each to a different connection, open a few tabs in each
2. Quit the app (test both a clean quit and killing the process) and relaunch → both windows reopen with their respective connection, tabs, active tab, and schema filter intact
3. Close one window cleanly, quit, relaunch → only the still-open window comes back

### BASED-CONN-SWITCH-CACHE: Instant in-session connection switching
**Applies to:** based (ui)
**Test category:** manual

Within one window's session, switching to a connection already visited restores its tabs, active tab, and schema filter instantly from an in-memory cache — without a server refetch and without discarding unsaved edits in the connection being left.

**Manual verification:**
1. In one window, open mixed query/table/routine tabs on connection A, switch to connection B, switch back to A → all tabs and the active tab are exactly as left
2. Type in a query tab and switch connections within 700ms → the edit is not lost (flushed before the switch, not discarded)

---

## Settings / Appearance

### BASED-SETTINGS: App settings persistence
**Applies to:** based (core)
**Test category:** integration

App-wide user preferences (the active theme id, and `rowPageSize` — the Table Data view's rows-per-page *and* the tab bar's ad-hoc query fetch-size cap, see BASED-UI-EXEC-PLAN) shall persist server-side in a single-row `app_settings` table so they survive restart. `GET /api/settings` returns the stored settings merged over defaults (`theme: "ledger"`, `rowPageSize: 500` out of the box); `POST /api/settings` accepts a partial patch, merges it over the current value, persists it, and returns the full settings.

**Acceptance criteria:**
- Fresh store → `GET /api/settings` returns `{ theme: "ledger", rowPageSize: 500 }`
- `POST { theme: "chillwave" }` → returns `{ theme: "chillwave", rowPageSize: 500 }`; a subsequent `GET` (after store reopen) still returns `chillwave`
- `POST { rowPageSize: 1000 }` → returns `rowPageSize: 1000` with `theme` unchanged; persists across store reopen
- A partial patch merges over existing settings rather than replacing the row

### BASED-THEME: Theme switching
**Applies to:** based (ui)
**Test category:** manual

The UI shall offer a theme picker (LeftRail header) listing all themes grouped dark/light. Selecting a theme applies it immediately by writing CSS custom properties onto `<html>` — retinting the Tailwind-driven chrome, the Monaco editor (`based` theme rebuilt from the live variables), and both Glide result grids — and persists the choice via `POST /api/settings`. On launch the theme is painted from a localStorage hint before React mounts (no flash), then reconciled to the server value. Themes carry their own display/body/mono fonts (full swap).

**Acceptance criteria:**
- Picking a light theme (e.g. Cozy Reading Room) recolors the rails, editor, grids, and native controls with no reload; the wordmark/body/editor fonts change to that theme's fonts
- The choice survives an app restart (loaded from `/api/settings`)
- Result grid header/cells, NULL cells, and the editable grid's dirty/new row tints all match the active palette

---

## Export

### BASED-EXPORT-CSV: CSV export
**Applies to:** based (core)
**Test category:** unit

A result set shall export to RFC-4180-style CSV: header row from column names, quoted fields when containing comma/quote/newline, NULL as empty field, binary as its summary text.

**Acceptance criteria:**
- Columns `[a,b]`, row `["x,y", null]` → `a,b\r\n"x,y",\r\n`
- Embedded quote doubles: `he said "hi"` → `"he said ""hi"""`

### BASED-EXPORT-XLSX: XLSX export
**Applies to:** based (core)
**Test category:** unit

A result set shall export to a valid `.xlsx` (header row + data rows) that round-trips through a reader with values intact; string cells are stripped of XML-1.0-illegal characters (C0 controls except tab/LF/CR, lone surrogates, U+FFFE/FFFF) so Excel never reports a `sharedStrings.xml` repair. The Excel export writes to a temp file and shell-opens it with the OS default handler.

**Acceptance criteria:**
- Export 2×2 result → reading the file back yields the same header and cell values
- NULL cells are empty; numbers stay numeric
- A cell containing a lone surrogate or U+FFFF reads back with those characters removed (file opens without repair); valid surrogate pairs (emoji) survive

---

## Import

### BASED-IMPORT-CSV-PARSE: Streaming RFC-4180 CSV parser
**Applies to:** based (core)
**Test category:** unit

A hand-rolled streaming parser (`core/src/import/csvParse.ts`, no dependency — mirrors the
hand-rolled export side): `CsvParser.push(chunk)` yields completed rows, `finish()` flushes the
last unterminated row. Handles quoted fields, `""` escapes, embedded commas/newlines, CRLF and LF,
and fields/rows spanning chunk boundaries. Ragged rows are returned as-is (the runner validates
width).

**Acceptance criteria:**
- `a,"b,1","he said ""hi"""\r\nc,,d` → two rows with the quoted comma, escaped quote, and empty
  field intact
- A quoted field containing `\r\n` stays one field; a row split across two `push` chunks (even
  mid-quote) parses identically to one chunk
- `finish()` emits a final row without a trailing newline; empty input → no rows

### BASED-IMPORT-CSV-COERCE: Per-column value coercion
**Applies to:** based (core)
**Test category:** unit

`coerceCsv(col, raw, { nullEmpty })` maps a CSV string to a wire value for the column type:
numeric types parse to validated numbers (non-numeric → a descriptive error, not NaN); `bit`
accepts 0/1/true/false (case-insensitive); an empty string becomes NULL when `nullEmpty` and the
column is nullable, an error when the column is NOT NULL and non-defaulted otherwise passes as ""
for string types; all other types pass through as strings (NVarChar implicit conversion — the
established runCommands pattern).

**Acceptance criteria:**
- int `"42"` → 42; int `"x"` → error naming the column; decimal `"1.5"` → 1.5
- bit `"true"`/`"1"` → 1; bit `"no"` → error
- empty + nullable + nullEmpty → null; empty + nvarchar + !nullEmpty → ""

### BASED-IMPORT-CSV-RUN: Batched transactional import
**Applies to:** based (core)
**Test category:** integration

`POST /api/import/csv/inspect { path, sampleRows? }` returns the header row and a sample for the
mapping UI. `POST /api/import/csv/run { path, schema, table, hasHeader, mapping, nullEmpty,
skipBadRows }` streams NDJSON progress (`progress` / `rowError` / `done` chunks) while inserting
via multi-row parameterized INSERTs built by a pure command builder
(`buildInsertBatches` — rows per statement = `floor(2000 / mappedColumns)`, respecting SQL
Server's 2,100-parameter limit; NULLs are parameters too). ≤ 5,000 total rows run as **one**
transaction (all-or-nothing via `runCommands`); larger files run per-batch transactions (1,000
rows) with progress. A coercion or SQL failure stops the import (reporting the 1-based CSV row)
unless `skipBadRows`, which skips coercion-failed rows and reports each. Gated on
`capabilities.write` + engine mssql; a summary history row is recorded.

**Acceptance criteria:**
- A valid CSV imports atomically; a read-back matches (scratch table, self-skips without perms)
- A mid-file bad value in atomic mode → nothing committed, the error names the CSV row
- `skipBadRows` imports the good rows and reports the bad ones with row numbers
- The pure batch builder packs ≤ 2,000 params per statement (unit-covered within this
  requirement's test file)

### BASED-IMPORT-CSV-UI: Import stepper
**Applies to:** based (ui)
**Test category:** manual

The Data tab toolbar of an editable table gains an "Import CSV" button (mssql tables only) opening
a stepper dialog: pick file (native dialog) → column mapping (auto-map by case-insensitive name;
warnings for unmapped non-nullable columns and identity targets) → coerced preview of the first
rows with per-cell error highlighting → run with live progress + error list → summary, then the
grid reloads.

**Verification procedure:**
1. Import a CSV whose headers match a scratch table → auto-mapped; preview shows coerced values;
   run → progress → summary; the grid shows the rows; History records the import
2. A CSV with a bad numeric value → the preview highlights it; running in atomic mode fails with
   the row number and nothing commits; with "skip bad rows" the rest import and the report lists
   the skipped rows
3. Unmapping a NOT NULL column shows a warning before run
4. The button is absent on views, PK-less (read-only) tables, and LanceDB connections

### BASED-DIALOG-OPEN-FILE: Native open-file dialog
**Applies to:** based (core)
**Test category:** manual

`POST /api/dialog/open-file { kind }` opens a native OpenFileDialog (PowerShell WinForms, like the
existing save/folder dialogs) filtered per kind and returns `{ path }` or `{ path: null }` on
cancel.

**Verification procedure:** the import stepper's "Choose file" opens the native dialog filtered to
`*.csv`; cancel returns to the stepper without error.

### BASED-FILE-OPEN-SQL: Open a .sql file into a query tab
**Applies to:** based (core + ui)
**Test category:** integration (endpoint) + manual (UI)

`POST /api/file/open-sql { path? }` opens a native OpenFileDialog filtered to `*.sql` when no
`path` is given (cancel → `{ path: null }`), reads the file, and returns `{ path, content }`; an
explicit `path` skips the dialog (mirrors `/api/file/save-sql`). A missing file is a 400 with an
error message. In the UI, Ctrl+O and the query-tab toolbar's "Open…" button open the chosen file
in a new query tab titled by the file name, with `filePath` set and not dirty; choosing a file
already backed by an open tab activates that tab instead of duplicating it.

**Acceptance criteria (integration):**
- Save `content` to a temp path via save-sql, then open-sql with that `path` → `{ path, content }` round-trips
- open-sql with a nonexistent `path` → 400 with the path in the error
- A leading UTF-8 BOM is stripped from `content`
- A file over the size cap (2 MB) → 400 with a clear error, no content

**Verification procedure (manual):**
1. Ctrl+O (or toolbar "Open…") → native dialog filtered to `*.sql` → picked file opens in a new
   tab titled by file name, content loaded, no dirty dot; cancel does nothing
2. Ctrl+O and re-pick the same file → the existing tab is focused, no duplicate
3. Restart the app → the file-backed tab restores with its content and file path

## Table data (browse + edit) — Phase 3

### BASED-TABLE-BROWSE: Paginated table data read
**Applies to:** based (core)
**Test category:** integration

The adapter shall read a page of a table's rows ordered by a stable key, capped by the row cap, returning columns (with PK flags) and the page rows.

**Acceptance criteria:**
- A known table returns ≤ pageSize rows for `{offset:0, limit:N}`; a second page (`offset:N`) returns different rows
- Ordering is deterministic across page calls (PK if present, else first column)
- Column metadata marks the PK column(s)

### BASED-TABLE-ORDERBY: Server-side sort + filter for table browse
**Applies to:** based (core)
**Test category:** integration

`readTablePage` accepts optional `orderBy: TableSort[]` (`{column, dir}`) and `filters:
TableFilter[]` (`{column, op, value?}`, ops `eq|ne|gt|ge|lt|le|like|is-null|not-null`). Every
referenced column is validated against the table's real column list (membership check — stronger
than quoting alone) before being bracket-quoted; filter values ride as typed parameters (numbers
for numeric column types, strings otherwise), never interpolated. The effective ORDER BY is the
user sort followed by the stable key columns (PK else first column) not already present, so paging
stays deterministic under any sort. `GET /api/session/table-data` passes `sort` and `filters` as
URL-encoded JSON. A new `EngineCapabilities.orderedBrowse` flag gates the UI (mssql `true`,
LanceDB `false` — unordered engine; amends BASED-CAPABILITIES-WIRE's flag list).

**Acceptance criteria:**
- `orderBy: [{column: c, dir: "desc"}]` returns a first row different from the ascending default,
  and page 2 under that sort contains no rows from page 1 (deterministic tiebreak)
- `filters: [{column, op: "eq", value}]` narrows to matching rows; `like` matches substrings via
  the caller's pattern; `is-null`/`not-null` behave as in SQL
- An `orderBy`/`filter` column not on the table throws before any SQL runs
- Filter values are parameterized (a value containing `'` or `--` narrows safely, no error)

### BASED-TABLE-FILTER-UI: Data-tab header sort + filter
**Applies to:** based (ui)
**Test category:** manual

For engines with `orderedBrowse`, the Data tab's grid headers become interactive: header click
cycles column sort asc → desc → none (` ▲`/` ▼` suffix), the header menu hosts the same filter
input as the results grid (BASED-GRID-FILTER's mini-language, parsed client-side into structured
`TableFilter`s), and applying either reloads from page 1 server-side. With pending edits, sort and
filter are blocked with an inline notice ("commit or discard first") — a reload clears pending
state and silently losing edits is unacceptable. LanceDB search-result mode and browse keep their
existing non-interactive headers.

**Verification procedure:**
1. Open a big table's Data tab → click a column header → rows reload sorted; click again →
   descending; again → default order
2. Header menu → type `> 100` on a numeric column → rows reload filtered; a "filtered" chip shows
   with a clear affordance; paging works within the filter
3. Edit a cell (don't commit) → header click shows the pending-changes notice and does not reload
4. A LanceDB table's Data tab headers are not sortable/filterable

### BASED-TABLE-DML: Pure edit→SQL builder
**Applies to:** based (core)
**Test category:** unit

A pure function shall turn a change set (row updates keyed by PK, inserts, deletes keyed by PK) into **parameterized** T-SQL commands with bracket-quoted, identifier-validated names. Cell values ride as parameters, never string-interpolated.

**Acceptance criteria:**
- Update of one column → `UPDATE [s].[t] SET [c]=@p0 WHERE [pk]=@k0`, value carried as a param, not interpolated
- Insert → `INSERT INTO [s].[t] ([a],[b]) VALUES (@p0,@p1)`
- Delete → `DELETE FROM [s].[t] WHERE [pk]=@k0`
- Composite PK → all key columns in the WHERE
- Update/delete with **no PK column** → throws/refuses (no command emitted)
- An invalid identifier (`;`, brackets, quotes) is rejected without emitting SQL

### BASED-TABLE-COMMIT: Transactional edit commit
**Applies to:** based (core)
**Test category:** integration

`POST /api/session/table-edit` shall build the commands (`buildEditCommands`) and, unless `preview: true`, execute them via `runCommands` in one transaction (all-or-nothing) and record a history row. A build failure (no PK, invalid identifier) returns 400; a runtime failure returns the server message and nothing partially commits.

**Acceptance criteria:**
- Committing an insert+update+delete on a scratch table applies all three; a subsequent read reflects them *(test creates/drops its own scratch table; self-skips without CREATE TABLE permission)*
- A failing command rolls the whole batch back (no partial write) and returns the error text
- A history row is recorded for the commit
- `preview: true` returns the built commands without executing; a no-PK edit returns 400

### BASED-TABLE-DETAILS: Full table introspection
**Applies to:** based (core)
**Test category:** integration

An optional adapter method `getTableDetails(schema, name)` (present when the new
`capabilities.script` flag is true — mssql only) returns everything the scripter and the enriched
Details view need in one parameterized multi-recordset batch over the `sys.*` catalog views:
columns (the `TableColumn` fields plus collation, identity seed/increment, computed definition +
persisted flag), indexes (type, unique/PK/unique-constraint flags, key columns with descending
flags, INCLUDE columns, filter definition), foreign keys (per-column pairs, referenced
schema/table/columns, delete/update actions, disabled flag), check constraints (definition,
column-scoped or table-level, disabled), default constraints (column, definition), and triggers
(events, AFTER/INSTEAD OF, disabled). Exposed at `GET /api/session/table-details?schema&table`,
which also returns the server-computed `createScript` (BASED-SCRIPT-TSQL). `EngineCapabilities`
gains `script` and `relations` flags (mssql both `true`, LanceDB both `false`; `relations` is
consumed by BASED-RELATIONS) — amends BASED-CAPABILITIES-WIRE.

**Acceptance criteria:**
- A scratch table with an identity PK, an FK with ON DELETE CASCADE, a default, a check
  constraint, a computed column, and a filtered/INCLUDE index reports every one of those pieces
  with correct metadata (seed/increment, FK target columns + action, index key order/INCLUDE list,
  filter text)
- A plain table reports empty arrays (not errors) for the sections it lacks
- The endpoint 400s on an engine without `capabilities.script`

### BASED-SCRIPT-TSQL: Pure T-SQL scripter
**Applies to:** based (core)
**Test category:** unit

A pure module (`core/src/db/scripter.ts`, no DB access) turns `TableDetails` /
`getObjectDefinition` output into runnable T-SQL. Identifiers use its own `]]`-escaping bracket
quote (any legal name — deliberately NOT `tableEdit.ts`'s strict `quoteIdent`, which stays an
injection guard on the write path). `scriptCreateTable` emits SSMS-style DDL: columns with type
(via `formatTypeTsql` — length/max/precision/scale), IDENTITY(seed,increment), computed `AS (expr)
[PERSISTED]`, NULL/NOT NULL; inline PK and UNIQUE constraints (from the flagged indexes, DESC keys
honored); then `ALTER TABLE … ADD` for defaults, checks (`WITH CHECK`/`NOCHECK` per disabled), and
FKs with `ON DELETE/UPDATE` actions; then `CREATE [UNIQUE] INDEX` for the rest (INCLUDE + filter).
Features outside v1 scope (partitioning, temporal, FILESTREAM, COLLATE) emit a `-- not scripted:`
comment, never a silent drop. `scriptDropTable`/`scriptDropModule` use `DROP … IF EXISTS`.
`rewriteCreateToAlter` (modules only) scans past leading whitespace and `--`/`/* */` comments and
rewrites the first `CREATE [OR ALTER]` + module keyword to `ALTER`; no match → the original text
with a leading warning comment (never corrupt DDL). SELECT and INSERT templates cover the SSMS
"Script as SELECT/INSERT" affordances (INSERT omits identity/computed columns). A dispatcher
`scriptObject(input, action)` routes and throws on invalid combos (`alter` on a table — SSMS
parity); `joinScripts` joins with `GO` (module CREATE must be batch-first).

**Acceptance criteria:**
- Fixture with identity/computed/composite-PK/desc-key/filtered-index/INCLUDE/default/check/FK
  actions round-trips into CREATE DDL containing each construct
- `]` in an identifier doubles; `scriptDropTable` emits `DROP TABLE IF EXISTS`
- `drop-create` = DROP + GO + CREATE in order
- `alter` on a table throws; `alter` on a view/procedure rewrites CREATE→ALTER
- INSERT template lists no identity/computed columns; SELECT template lists all columns

### BASED-SCRIPT-MODULE-ALTER: CREATE→ALTER rewrite
**Applies to:** based (core)
**Test category:** unit

`rewriteCreateToAlter(definition)` is comment- and case-aware: leading line comments (`--`) and
block comments (`/* */`) are skipped, not searched, so the word CREATE inside a leading comment is
never rewritten; `CREATE OR ALTER` collapses to `ALTER`; lowercase/mixed-case definitions rewrite
correctly; a definition with no CREATE+module-keyword match returns the original text prefixed
with a `-- based: could not rewrite to ALTER` warning comment.

**Acceptance criteria:**
- `/* CREATE VIEW note */ CREATE VIEW v AS …` rewrites only the real CREATE
- `create or alter procedure p …` → `ALTER procedure p …` (keyword case preserved after ALTER)
- A definition with no match comes back unchanged plus the warning comment

### BASED-SCRIPT-API: Multi-object scripting endpoint
**Applies to:** based (core)
**Test category:** integration

`POST /api/session/script` `{ objects: [{schema, name, type}], action }` returns `{ sql, errors }`:
per object, tables/views route through `getTableDetails`+scripter or
`getObjectDefinition`+scripter as appropriate for the action; results join in request order via
`joinScripts`; a per-object failure (unknown object, invalid action for its type) lands in
`errors` with that object's identity while the rest still script. Gated on `capabilities.script`
(400 otherwise).

**Acceptance criteria:**
- Two known objects, action `create` → one GO-joined script containing both, request order
- One good + one unknown object → `sql` has the good one, `errors` names the bad one
- Engine without `script` capability → 400

### BASED-VIEW-DEFINITION: View/routine SQL definition text
**Applies to:** based (core)
**Test category:** integration

The adapter shall expose the CREATE VIEW/PROCEDURE/FUNCTION body of a schema object via `getObjectDefinition(schema, name)` (backed by `sys.sql_modules`), reachable at `GET /api/session/definition`. Unknown objects return `null` rather than throwing. Optional on `DatabaseAdapter` — absent on engines without SQL definitions (e.g. LanceDB).

**Acceptance criteria:**
- A known view's definition contains `CREATE VIEW` and the view's own name (case-insensitive)
- A known function's definition contains `CREATE FUNCTION`
- An unknown schema/name pair returns `null`, not an error

### BASED-ROUTINE-DETAILS: Stored procedure / function parameter introspection
**Applies to:** based (core)
**Test category:** integration

The adapter shall list a stored procedure or function's parameters (name, SQL type, in/out mode, declaration ordinal) via `getRoutineParameters(schema, name)` (backed by `sys.parameters`/`sys.types`), reachable at `GET /api/session/parameters`. Optional on `DatabaseAdapter`, same gating as BASED-VIEW-DEFINITION.

**Acceptance criteria:**
- A known procedure with parameters returns them in declaration order (ordinals ascending from 1), each with a non-empty name/type and `mode` ∈ {in, out, inout}
- A parameterless function returns an empty list, not an error

### BASED-UI-TABLE-EDIT: Editable data grid
**Applies to:** based (ui)
**Test category:** manual

The table/view tab's header tabs (Details / Edit Data / SQL — see BASED-TABLE-SQL-VIEW) sit at the left of the header, before the object title. Edit Data shows an editable grid (glide-data-grid edit mode) with page controls (Prev/Next plus a rows-per-page picker, backed by the `rowPageSize` app setting from BASED-SETTINGS, default 500), add-row and delete-row affordances, a **pending changes** indicator, a **Review SQL** peek, and **Commit**/**Discard**. Details additionally shows a view's SQL definition text (BASED-VIEW-DEFINITION) below its columns. No PK → read-only with a notice.

**Verification procedure:**
1. Double-click a table → Details view, tabs at the left of the header; toggle to Edit Data → rows list; Prev/Next paging works
2. Change the rows-per-page picker → grid reloads from page 1 at the new page size, and the choice persists across reopening the tab/app
3. Edit a cell → cell marked dirty; Review SQL shows a parameterized `UPDATE`
4. Add a row and delete a row → Commit → grid refreshes with the changes; History shows the commit
5. Open a view → Details shows both columns and its CREATE VIEW text; Edit Data grid works the same as for a table
6. A table with no PK → grid is read-only with a notice
7. Break a value (bad type) → Commit shows the server error; grid still reflects pre-commit (uncommitted) state

### BASED-TABLE-DETAILS-UI: Enriched Details view + Script dropdown
**Applies to:** based (ui)
**Test category:** manual

For engines with `capabilities.script`, a table tab fetches `GET /api/session/table-details` in
place of the plain columns call (its columns are a superset, so the existing columns table and
Data-grid PK gating are unchanged; LanceDB keeps the old path). The Details sub-view gains
ledger-styled sections, each omitted when empty: **Indexes** (name, type/unique, key columns with
desc flags, INCLUDE list, filter), **Foreign keys** (columns → referenced table(columns), delete/
update actions, disabled), **Constraints** (checks + defaults with definitions), **Triggers**
(events, after/instead-of, disabled) — and, for tables, a **DDL** block showing the
server-computed CREATE script (exactly how views already show their definition). A **Script ▾**
dropdown sits next to the Details/Data/SQL sub-tab buttons (tables/views) and in the routine tab
header (procedures/functions), offering the SSMS-parity action set per object type (no ALTER for
tables; SELECT for tables/views; INSERT for tables only); each action opens the generated script
in a new query tab (not run) via `POST /api/session/script`.

**Verification procedure:**
1. Open a table with an FK, an index, a default and a check constraint → Details shows all four
   sections with correct metadata, plus its CREATE DDL block
2. A plain table shows only its columns table + DDL (no empty sections)
3. Script ▾ → "Script as create" opens `Script: schema.table` as a new query tab containing
   runnable CREATE DDL; "drop and create" contains DROP + GO + CREATE
4. A view's Script menu offers alter (rewritten from its definition); a procedure tab's header
   Script menu works the same
5. On a LanceDB connection no Script dropdown appears and Details renders exactly as before

### BASED-TABLE-SQL-VIEW: Prepopulated, autorun, cached SQL tab
**Applies to:** based (ui)
**Test category:** manual

A table/view tab's "SQL" tab (mssql connections only) is a full query-tab experience (editor + results + output, run/cancel/save) backed by a hidden query tab prepopulated with `SELECT * FROM [schema].[table]`. The query runs automatically the first time the tab is opened; navigating to Details/Edit Data and back re-renders the same cached results rather than re-running. Editing the SQL and rerunning behaves exactly like an ordinary query tab. Closing the table/view tab disposes the hidden tab too; it is not persisted across app restarts.

**Verification procedure:**
1. Open a table → click SQL → `SELECT * FROM` the table runs automatically and results appear
2. Click Details, then click SQL again → previous results still shown, no new query fires (no new row in the status bar's duration / no query log entry)
3. Edit the SQL and press F5 → reruns with the new results, same as any query tab
4. Close the table tab → reopen it → SQL tab starts fresh (autoruns again)
5. Connect to a LanceDB connection → no SQL tab is shown

---

## ER diagram (mssql only)

### BASED-RELATIONS: Bulk relations introspection
**Applies to:** based (core)
**Test category:** integration

An optional adapter method `getRelations(schemaFilter?)` (present when `capabilities.relations`)
returns, in **one** two-recordset batch (no N+1): every user table in scope with its columns
(name, type, PK/FK/nullable flags) and every FK edge (constraint name, parent schema/table/columns,
referenced schema/table/columns, per-column pairs in order). A schema scope filters the table list
but keeps any edge touching the scope, so cross-schema references still render (referenced tables
outside the scope appear as stubs on the edge only). Exposed at
`GET /api/session/relations[?schema=]`, 400 on engines without `relations`.

**Acceptance criteria:**
- Two scratch tables with an FK → one call returns both tables with columns + the edge with
  correct column pairs
- `?schema=` scoping filters tables to the schema but keeps edges touching it
- LanceDB → 400

### BASED-DIAGRAM-LAYOUT: Pure diagram auto-layout
**Applies to:** based (ui)
**Test category:** unit

`layoutDiagram(graph)` (`ui/src/diagramLayout.ts`, pure — dagre `rankdir: LR`, node height from
column count) positions every table node with finite coordinates, emits one edge per FK
referencing existing node ids, is deterministic for a fixed input, and handles cyclic FK graphs
without throwing.

**Acceptance criteria:**
- Every input table gets a node with finite x/y; no two nodes share identical coordinates for a
  multi-node graph
- Edges reference existing node ids; a two-table cycle lays out without throwing
- Same input twice → identical output

### BASED-DIAGRAM-UI: ER diagram tab
**Applies to:** based (ui)
**Test category:** manual

A new tab kind `diagram` (persisted/restored like other tabs — amends BASED-TABSTORE's kind set)
renders the relations graph with React Flow: custom table nodes (schema.name header, column rows
with the ⚿/⚷ glyphs, capped at ~25 rows with a "+N more" footer), smoothstep FK edges (name shown
on selection in a detail card), pan/zoom/fitView/controls. A scope `<select>` (All schemas + each
schema) in the diagram header refetches; >300 tables in scope shows a pick-a-schema prompt instead
of the canvas. Entry points: a diagram icon button beside the left rail's schema filter (visible
when `capabilities.relations`, opens with the current schema filter as scope) and the explorer
context menu. Read-only v1 — no diagram-driven DDL. Not exposed for LanceDB.

**Verification procedure:**
1. Click the diagram button with a schema filter active → a diagram tab opens scoped to it; tables
   render with PK/FK glyphs and FK edges; pan/zoom work; clicking an edge shows the FK name
2. Switch the scope select to All schemas → refetches and re-lays-out
3. Restart the app → the diagram tab restores with its scope
4. On a LanceDB connection the button is absent

## Agent / AI (Phase 2 — Ask Capi)

### BASED-AI-PROVIDER: AI provider configuration & model resolution
**Applies to:** based (core)
**Test category:** integration

Provider config (kind ∈ {openai-compatible, openai, azure-openai, anthropic}, base URL, default model, optional deployment) persists in the local store; the API key lives in Windows Credential Manager, never the store. A resolver turns the active config into an AI SDK `LanguageModel`. The out-of-box default targets a local LM Studio OpenAI-compatible server.

**Acceptance criteria:**
- Save config → read back identical fields; the stored record contains no key material
- `setAiKey`/`getAiKey`/`deleteAiKey` round-trip through Credential Manager
- The `openai-compatible` resolver returns a model for a reachable base URL

**Implementation note (no spec impact):** the `openai` / `azure-openai` / `anthropic` branches are wired natively — see BASED-AI-PROVIDER-WIRED. A single `zod@3.25.76` override reconciles the AI SDK's `zod/v4` subpath imports.

### BASED-AGENT-RUNQUERY: Read-only `run_query` tool with row cap
**Applies to:** based (core)
**Test category:** unit

The agent `run_query` tool executes only read-only statements. A pure classifier (`isReadOnly`) decides read-only vs. mutating; non-read statements are refused without touching the DB. Forwarded rows are capped (agent default 1,000) and marked truncated past the cap.

**Acceptance criteria:**
- `SELECT`/leading-CTE → read-only; `INSERT`/`UPDATE`/`DELETE`/`DROP`/`TRUNCATE`/`EXEC`/`MERGE`/`SELECT…INTO` → not (case/whitespace/comment/string-literal insensitive)
- `run_query` on a mutating statement returns `{ refused: true }` and never calls the adapter

### BASED-AGENT-SCHEMA-CTX: Schema-only context tool
**Applies to:** based (core)
**Test category:** integration

`get_schema` returns objects (schema-qualified) and, on request, a table's columns — the same introspection the explorer uses — and never row data.

**Acceptance criteria:**
- `get_schema()` returns a non-empty object list, each with schema/name/type
- `get_schema({ table })` returns that table's columns and no rows

### BASED-AGENT-SAMPLE: `sample_rows` tool
**Applies to:** based (core)
**Test category:** integration

`sample_rows({ schema, table, limit })` returns up to `limit` (hard-capped 100) rows via a parameterized `SELECT TOP` over an identifier-validated object — the only tool that returns row data.

**Acceptance criteria:**
- Returns ≤ limit rows with the table's columns for a known table
- An invalid identifier (`;`, brackets, quotes) is rejected without querying

### BASED-AGENT-READ-ROWS: `read_rows` paging tool
**Applies to:** based (core)
**Test category:** unit

An engine-neutral `read_rows({ table, schema?, offset?, limit? })` tool pages through a table via
the adapter's `readTablePage` in a stable order, so the agent never has to pull a whole table at
once. `limit` clamps to 1–200 (default 100); the result carries `{ columns, rows, orderBy, offset,
returned, hasMore }` where `hasMore` is the `returned === limit` heuristic (`TablePage` has no total
count; an exactly-full final page costs one extra empty read — documented, accepted). On engines
with `orderedBrowse` (mssql) the tool additionally accepts `orderBy: [{column, dir}]` and
`filters: [{column, op, value?}]`, passed straight through to `readTablePage`'s validated
sort/filter path (BASED-TABLE-ORDERBY); on other engines those arguments return a descriptive
error. Every call is audited as a read. `sample_rows` stays as the quick-peek affordance — the two
tools cross-reference each other in their descriptions.

**Acceptance criteria:**
- `limit: 500` clamps to 200; omitted limit reads 100; `offset` forwards verbatim
- A full page reports `hasMore: true`; a short page reports `hasMore: false`
- Default schema is `dbo` on mssql and `""` on lancedb (same resolution as `get_schema`)
- `orderBy`/`filters` forward to the adapter on an `orderedBrowse` engine and error gracefully
  (no adapter call) on an engine without it
- Both engine surfaces contain `read_rows`; each call writes an audit row

### BASED-SCRIPT-OBJECT: Agent `script_object` tool
**Applies to:** based (core)
**Test category:** unit + integration

An engine-appropriate `script_object` agent tool returns DDL/description text — never executes it
(execution stays on the BASED-AGENT-MUTATION-GATE approval path). On mssql
(`capabilities.script`), `script_object({ name, schema?, action? })` resolves the object's type via
`listObjects()` and routes through the existing scripter (BASED-SCRIPT-TSQL): tables via
`getTableDetails` + `scriptObject({kind:"table"})`, views/procedures/functions via
`getObjectDefinition` + `scriptObject({kind:"module"})`; `action` ∈
create|drop|drop-create|alter|select|insert (default create), with the scripter's own invalid-combo
errors surfaced as tool errors, not throws. On LanceDB, `script_object({ table, schema? })` returns
a readable schema description (`describeLanceSchema`, a pure function): per-column name/type/
nullability, vector columns as `vector[dim] of <elementType>` with the index metric when known
(BASED-LANCE-VECTOR-METRIC), plus a `pyarrow` schema snippet (Lance tooling is Python-first).
Unknown objects return `{ error }` with the valid-name list, mirroring `load_skill`. Calls are
audited as reads.

**Acceptance criteria:**
- mssql: a table round-trips to a `CREATE TABLE` containing its PK; a view returns its `CREATE VIEW` text; `action: "alter"` on a table returns an error object (no throw)
- lancedb: the seeded table's description names every column, renders the vector column as `vector[dim]`, and includes a `pa.schema` snippet
- An unknown object name returns `{ error, validNames }` without calling the scripter
- `describeLanceSchema` is pure (unit-tested with fixture columns, no DB)

### BASED-AGENT-EXPORT: Agent `export_data` tool
**Applies to:** based (core)
**Test category:** unit + integration

An engine-neutral `export_data({ format, sql? | table?, schema?, fileName?, openAfter? })` tool
writes a query result or a whole table to a CSV/XLSX file and returns `{ path, rowCount,
truncated }`. Exactly one of `sql`/`table` is required. A `sql` source needs `capabilities.sql` and
an `isReadOnly` pass (a mutating statement is refused without touching the adapter); a `table`
source loops `readTablePage` in pages of 1,000 on any engine. Rows cap at `EXPORT_ROW_CAP`
(100,000, `truncated: true` past it). The file writes server-side to the user's Downloads folder
(fallback: temp dir) — no dialog mid-run — as `based-export-<name>-<timestamp>.<ext>`; `fileName`
is sanitized (path separators and `..` rejected, extension enforced); `openAfter` shell-opens the
result. Writers are the existing `toCsv`/`writeXlsx` (BASED-EXPORT-CSV/XLSX). Calls audit as
reads. The agent-side **import** counterpart is BASED-AGENT-IMPORT (approval-gated, frontend).

**Acceptance criteria:**
- Table source: the paging loop stops on a short page; rows past `EXPORT_ROW_CAP` set `truncated`
- SQL source: a mutating statement → `{ refused }`, adapter untouched
- `fileName` containing `/`, `\`, or `..` is rejected; a missing extension is appended
- End-to-end (lancedb integration): exporting the seeded table writes a real CSV whose header
  matches the table's columns, returns its path, and appends a kind-`read` audit row

### BASED-AGENT-IMPORT: Approval-gated agent CSV import
**Applies to:** based (ui)
**Test category:** manual

The agent proposes imports; it never runs them. A frontend `import_csv({ path, table, schema?,
hasHeader?, mapping?, nullEmpty?, skipBadRows?, reason? })` tool (pattern: `run_mutation`) renders
an approval card that inspects the file (`/api/import/csv/inspect`) and the target's columns,
resolves the mapping (explicit, else auto: case-insensitive header-name match when `hasHeader`,
positional otherwise — unmapped CSV columns are shown as a warning), and previews `csv[i] → column`
lines. Only the user's Approve drives the existing `/api/import/csv/run` NDJSON stream
(BASED-IMPORT-CSV-RUN), with live inserted/total progress on the card; the server's
`capabilities.write` gate still applies (a read-only connection invalidates the card before it ever
offers Approve). Reject resolves `{ approved: false }` and nothing runs. The tool result carries
the outcome summary (status, inserted/failed counts, first row errors) so the agent can narrate it.

**Verification procedure:**
1. Ask Capi to "import C:\...\file.csv into dbo.T" → an approval card shows the file → table, the
   auto-resolved mapping, and any unmapped CSV columns
2. Reject → nothing runs; the agent reports the rejection
3. Approve on a valid file → progress counts up; the card shows the inserted-rows summary; the grid
   shows the new rows; History records the import (BASED-IMPORT-CSV-RUN)
4. Repeat on a LanceDB (read-only) connection → the card immediately shows the read-only error and
   never offers Approve
5. A mapping the agent proposes with an unknown column name invalidates the card (no Approve)

### BASED-AGENT-TAB-CONTEXT: Workspace context injection
**Applies to:** based (core)
**Test category:** unit + integration

Each agent run can carry a workspace snapshot from the client in
`RunAgentInput.forwardedProps.tabContext` (the AG-UI channel that reaches the server on every
send — a client-injected `system` message would be dropped by the `@ag-ui/mastra` message
converter, which only maps user/assistant/tool roles). A pure `renderTabContext(raw)` validates
the loose shape and renders a `<workspace_context>` block — the active tab's identity, its SQL
(≤4,000 chars), result-set *summaries* (columns/rowCount/truncated, never rows), and a one-line
list of all open tabs (≤30) — hard-capped at 8,000 chars total; absent/malformed input returns
`null`. `buildAgent` accepts an optional `contextNote` appended to the composed instructions, and
`agentStream` wires the two together per request.

**Acceptance criteria:**
- `renderTabContext(null | garbage)` → `null`; a valid snapshot renders the active tab title, SQL, and open-tab list
- Oversized SQL truncates at the cap; >30 tabs truncate with a "+N more" marker; total output ≤8,000 chars
- `buildAgent({ contextNote })` includes the block in its instructions; omitting it reproduces the prior instructions exactly

### BASED-AGENT-MUTATION-GATE: Approval-gated mutations
**Applies to:** based (core)
**Test category:** integration

The agent has no server tool that executes DML/DDL. Mutations run only through `POST /api/agent/mutation`, which requires `approved: true` and audits the SQL before executing. The frontend reaches it only after the user approves the `run_mutation` card.

**Acceptance criteria:**
- Mutation-exec with `approved` absent/false → 400, nothing runs, no audit row
- With `approved: true` → runs and writes an audit row with `approved`
- `run_query` (the only agent-callable exec tool) rejects mutations, so the model cannot self-execute DML

**Security posture (no spec impact):** `approved` is a UX gate suited to a personal tool; the real enforcement is that DML has no agent-reachable tool and the frontend only calls the endpoint on user approval.

### BASED-AGENT-AUDIT: Audit log of agent SQL
**Applies to:** based (core)
**Test category:** integration

Every SQL the agent causes to run (reads via `run_query`/`sample_rows`, approved mutations) appends an audit row (connection, database, kind read|mutation, sql, approved, started-at, status, error), retrievable most-recent-first. Row data is never recorded.

**Acceptance criteria:**
- After an agent `run_query`, the audit list returns it with kind `read`, status `ok`
- An approved mutation records kind `mutation`, `approved: true`; a refused mutation records nothing

### BASED-AGENT-ENDPOINT: AG-UI endpoint on the core server
**Applies to:** based (core)
**Test category:** integration

`POST /api/agent/:agentId` exposes the Mastra agent as an AG-UI SSE stream, gated by the per-launch token, and requires a live session so the tools have an adapter. Run errors surface as a `RUN_ERROR` event, never a crash.

**Acceptance criteria:**
- POST without the bearer token → 401
- POST with the token but no connection → 409
- With a connection and a valid `RunAgentInput`, the response streams AG-UI events (`RUN_STARTED` … `RUN_FINISHED`, or a clean `RUN_ERROR` on model failure)

### BASED-AGENT-MULTISTEP: Multi-step tool loop completes with a final message
**Applies to:** based (core)
**Test category:** unit

The agent is built with a default step budget of 30 (`defaultOptions.maxSteps`) so multi-step tool runs (e.g. schema audits) are not cut off by Mastra's implicit 5-step default, which ends a run immediately after tool results with no final assistant text. (The AG-UI bridge passes no `maxSteps`/`stopWhen` of its own, so the agent-config default is what governs the loop.) A run that genuinely exhausts the budget still ends tool-calls-last without a summary — accepted residual limitation.

**Acceptance criteria:**
- `buildAgent(...)` yields an agent whose resolved default options have `maxSteps` of 30 (assert via `agent.getDefaultOptions(...)`)
- Manual: "audit my tables" against the dev DB streams tool calls and ends with a final assistant text message before `RUN_FINISHED`

### BASED-AGENT-THREADS: Per-tab thread persistence
**Applies to:** based (core, ui)
**Test category:** integration + unit

Chat threads persist via Mastra Memory (LibSQLStore, its own `agent.db`), **one thread per tab**:
the client derives `threadId` as `tab:{connectionId}:{tabId}` (the connectionId prefix guarantees
global uniqueness — deterministic tab ids like `table:dbo.Users` repeat across connections), or
`conn:{connectionId}` when no tab is active; `resourceId` stays the connection id. Switching tabs
switches the visible conversation (BASED-AGENT-TAB-TOOLS).

**Ownership & aliasing:** a user-opened tab *owns* its derived thread. A tab the agent opens
(`open_query_tab`) instead *aliases* the thread that created it — the tab stores `originThreadId`
(round-tripped through the persisted tab's `meta`), and thread resolution everywhere is
`originThreadId ?? derived`. Closing a tab deletes a thread only when the tab owns it and no other
open tab aliases it; "New chat" on an aliased tab detaches it (clears `originThreadId`) rather
than clearing the shared conversation.

**Endpoints:** `GET /api/agent/threads/:threadId/messages?resourceId=…` returns the thread's
history as AG-UI messages via `Memory.recall` + a defensive mapper (`mapDbMessagesToAgui`:
user/assistant text, assistant `tool-invocation` parts as `toolCalls` plus one synthetic
`role:"tool"` message per resolved invocation, id-prefixed `hist_` so the client can exclude them
from outbound sends; unknown parts/roles are skipped). Unknown thread → `[]`, never an error. It
does not require a live DB connection. `DELETE /api/agent/threads/:threadId` removes the thread
(`Memory.deleteThread`).

**Acceptance criteria:**
- Memory tables live in `agent.db`, not the bun:sqlite `app.db`
- A run with a stable `threadId`/`resourceId` accumulates history in memory
- The messages GET returns mapped history for a seeded thread and `[]` for an unknown one; after a DELETE, a subsequent GET returns `[]`
- `mapDbMessagesToAgui` pairs a resolved tool invocation with a synthetic `hist_`-prefixed tool message and skips unknown part types (unit)
- The client-side thread resolution (`originThreadId ?? derived`) and the owns-and-unaliased close rule are pure and unit-tested

### BASED-SKILL-REGISTRY: Skill registry & prompt catalog
**Applies to:** based (core)
**Test category:** unit

Developer-authored capability modules (TS modules, not runtime-loaded files — bundler-safe for the shell) register in a registry. `catalog(engines?)` yields each skill's name + description (never the body) for the system prompt, filtered to the active engine: a skill with no `engines` tag is universal; a tagged skill (e.g. `lance-search` → `["lancedb"]`) is advertised only when its engine is active. `get(name)` returns the full skill or undefined.

**Acceptance criteria:**
- `catalog(allEngines)` contains every registered skill's name and description and none of the body text
- A universal skill (`diagrams`) appears in every catalog; an engine-tagged skill appears only for its engine
- `get(known)` returns the body; `get(unknown)` returns undefined
- At least the `diagrams` skill is registered

### BASED-SKILL-LOAD: `load_skill` tool (progressive disclosure)
**Applies to:** based (core)
**Test category:** integration

The agent has a `load_skill({ name })` tool returning the skill body; an unknown name returns the valid-name list (no throw). The system prompt advertises the catalog and instructs the agent to load a matching skill before acting on it.

**Acceptance criteria:**
- `load_skill({ name: "diagrams" })` returns the diagrams body
- An unknown name returns the list of valid names, not an error
- The built agent's instructions include the skill catalog and the load-a-skill-first protocol

### BASED-AGENT-INSTRUCTIONS: Editable, named agent instruction sets
**Applies to:** based (core)
**Test category:** integration

The agent's system prompt (the shared core + each engine's persona — SQL Server, LanceDB) is
user-editable and persisted as named instruction sets. A single virtual `"default"` set always
mirrors the built-in `GENERIC_CORE`/`MSSQL_PERSONA`/`LANCE_PERSONA` constants — it is never persisted
and can be neither edited nor deleted, so it can't drift from the code. `GET /api/agent/instructions`
returns the active id plus every set (default first); `POST /api/agent/instructions` creates
(no `id`) or updates (matching `id`) a custom set; `POST /api/agent/instructions/active` switches the
active set; `DELETE /api/agent/instructions/:id` removes a custom set. All four reject `id: "default"`
(create/update/delete) or an unknown id (activate) with a 400.

Which set the **running agent** uses is not the store's own `activeId` — it is the set the active
AI provider profile links to (`BASED-AI-PROVIDER-PROFILES`). `resolveById(id, engine)` returns a set's
`{core, persona}` for the connected engine, falling back to the `"default"` set when `id` no longer
resolves (e.g. the linked set was deleted). Instruction sets are thus authored/managed here but
*assigned* to an agent from its profile, and remain reusable across profiles.

**Acceptance criteria:**
- Fresh store → `GET` returns exactly one set, `{ id: "default", editable: false, core: GENERIC_CORE, mssqlPersona: MSSQL_PERSONA, lancePersona: LANCE_PERSONA }`
- `POST` with no `id` creates a custom set (`editable: true`); a subsequent `GET` (after store reopen) still returns it
- `POST` with a matching `id` updates that set in place rather than duplicating it
- `POST`/`DELETE` targeting `id: "default"` → 400, no change
- Activating a set persists across a `GET`; deleting the active custom set falls back `activeId` to `"default"`
- Activating an unknown id → 400
- `resolveById(id, engine)` returns that set's `core` + the engine-appropriate persona (`mssqlPersona` for `mssql`, `lancePersona` otherwise); an unresolved `id` returns the `"default"` set's values

### BASED-AGENT-INSTRUCTIONS-COMPOSE: Instruction-set override wiring
**Applies to:** based (core)
**Test category:** unit

`buildAgent` accepts optional `core`/`persona` overrides; when supplied they replace `GENERIC_CORE`
and the engine surface's persona in the composed system prompt (`agentInstructions`). Omitting them
reproduces today's hardcoded per-engine output exactly — a regression guard as this becomes
settings-driven.

**Acceptance criteria:**
- `buildAgent` with no `core`/`persona` → instructions equal `agentInstructions(GENERIC_CORE, <engine persona>)` for both `mssql` and `lancedb`
- `buildAgent` with `core`/`persona` overrides → the built agent's instructions contain the override text and omit the built-in `GENERIC_CORE`/persona text

### BASED-AGENT-INSTRUCTIONS-UI: Agent instructions editor
**Applies to:** based (ui)
**Test category:** manual

The Agent tab of the settings popover (gear icon, `ThemePicker`) hosts, below the AI provider profile
list, an "Agent instructions" section that *authors* persona sets, shown as a row list (Default + any
custom sets — a local editing list only, no runtime "active" switch) where each row shows the set
name, whether it's built-in, how many profiles link to it, and Edit + duplicate icon buttons.

Editing takes over the whole Agent tab: while a set (or an AI provider profile) is being edited, the
profile and instruction-set lists are hidden and the editor is the tab's entire content; Save or
Cancel returns to the lists. The set editor shows a "Name" field (editable sets only) and three
collapsible boxes — Core (shared), SQL Server persona, LanceDB persona — open by default. The
read-only Default set opens as a viewer (boxes disabled, note explaining why) with a
"Duplicate to edit" action; row-level duplicate likewise opens the editor on an unsaved editable
copy. Nothing is persisted until Save (which creates the set for an unsaved copy); Cancel discards
the draft. Delete removes a custom set and is only offered for saved custom sets. Which set an agent
*uses* is assigned per-profile: the AI provider profile Add/Edit form has an "Instructions" dropdown
bound to the profile's `instructionSetId`, and each profile row shows its linked set name next to
the model.

**Acceptance criteria:**
- Opening any editor (profile or set) hides everything else on the Agent tab; Save and Cancel both return to the full lists
- Default's three boxes render read-only with a note explaining why; Duplicate (row icon or "Duplicate to edit") opens the editor on an editable unsaved copy named "<source> copy"
- An unsaved copy shows Save but no Delete, and does not appear in the list after a reload unless Save was clicked; Cancel discards it
- Renaming via the Name field and clicking Save persists the new name (the list shows it after reload)
- Editing a custom set's boxes and clicking Save persists the change across a reload
- The set list is an editing list only (no active-set network call); each row's subtitle reflects how many profiles link to the set
- A profile's "Instructions" dropdown lists Default + all custom sets and persists the chosen `instructionSetId` on Save; a chat turn's behavior reflects the active profile's linked set

### BASED-DIAGRAM-RENDER: Mermaid rendering in the rail
**Applies to:** based (ui)
**Test category:** manual

Assistant ` ```mermaid ` blocks render in the Capi rail (Streamdown mermaid plugin, already wired). The `diagrams` skill body covers ER (schema shape), FK graph (reference questions), sequence/flow (proc logic), `pie` (small categorical distribution), `xychart-beta` bar/line (trend/comparison, noting the beta limits), and "aggregate to a small group set and use `run_query`'s real numbers before charting."

**Verification procedure (needs a healthy model backend):**
1. "pie of orders by status" → agent runs an aggregate, emits a mermaid `pie` with the real counts, chart renders
2. "show the schema of X and what references it" → ER / FK diagram renders

---

## UI (manual verification — procedures are the artifact)

### BASED-UI-LAYOUT: Ledger layout
**Applies to:** based (ui)
**Test category:** manual

Three-region workbench: left rail (connection selector, database selector, schema dropdown, object explorer), center tabbed work area, right rail hosting Ask Capi (Phase 2; a "connect to chat" placeholder until a connection is active).

**Verification procedure:** launch app → left rail and center area render; right rail toggle exists and expands/collapses; with a connection active the rail shows Ask Capi.

### BASED-UI-CONNECTIONS: Connection management UI
**Applies to:** based (ui)
**Test category:** manual

Single active connection. "+ New connection" opens a form (name, server, auth type incl. all four, initial database, encrypt/trust-cert, Test Connection, Save); edit affordance opens the same form pre-filled with Delete + confirmation. Switching connections swaps the tab set. Database selector reconnects to the chosen database; schema dropdown: empty = all schemas with `schema.name` prefixes, a selection filters and drops the prefix.

**Verification procedure:**
1. Create a connection (azure-cli auth) → Test Connection succeeds → Save → it appears in the selector and survives app restart
2. Edit it (rename) → name updates; Delete asks for confirmation
3. Connect → database dropdown lists server databases; switching databases refreshes the explorer
4. Schema dropdown "All schemas" shows `dbo.X` style names; choosing `dbo` drops the prefix and filters

### BASED-UI-EXPLORER: Object explorer
**Applies to:** based (ui)
**Test category:** manual

Collapsible accordion grouped by type — Tables, Views, Stored Procedures, Functions — each header showing a count; collapsed groups hide members. Double-clicking a table/view opens a table-details tab (Name, Data Type, Size/Precision/Scale, Nullable, Key) sourced from the same introspection endpoint as everything else. Double-clicking a stored procedure/function opens a routine tab showing its parameter list (BASED-ROUTINE-DETAILS) and SQL definition text (BASED-VIEW-DEFINITION) — no Edit Data/SQL tabs, since a routine has no natural row set.

**Verification procedure:** connect to dev DB → four groups with counts; collapse/expand works; double-click a table → details tab shows its columns with PK marked; double-click a stored procedure or function → routine tab shows its parameters and definition text (previously not double-clickable at all).

### BASED-UI-SCRIPT-AS: Explorer multi-select + Script as
**Applies to:** based (ui)
**Test category:** manual

Explorer rows support multi-select: plain click selects one, ctrl-click toggles, shift-click
selects the visible range from the anchor **within the same group** — the selection is always
type-homogeneous (clicking into another group resets it), which keeps the action menu coherent.
Right-click opens a context menu (TabContextMenu-pattern popover; right-clicking outside the
selection first selects that row alone): single-selection Open actions (Details / Data / SQL per
capability for tables/views; Details for routines) and, gated on `capabilities.script`, the
"Script as" set from BASED-TABLE-DETAILS-UI applied to **all** selected objects — one
`POST /api/session/script` call, one new query tab (`Script: schema.name` / `Script: N objects`),
GO-separated in selection order; per-object failures surface via the banner.

**Verification procedure:**
1. Ctrl-click three tables → right-click → "Script as create" → one query tab with all three
   CREATEs GO-separated; the banner stays quiet
2. Shift-click a range within Views → the range is selected; clicking a procedure resets the
   selection to just it
3. Right-click an unselected row → the selection becomes that row; its menu shows Open actions
4. On a LanceDB connection the menu shows only Open actions (no Script section)

### BASED-EXPLORER-ACTION: Configurable double-click action
**Applies to:** based (ui + core settings)
**Test category:** manual (settings persistence rides the BASED-SETTINGS integration round-trip)

`AppSettings` gains `explorerTableAction` (`details | data | sql | script-create`, default
`details`) and `explorerRoutineAction` (`details | script-create`) — edited via two selects in the
settings General tab ("Double-click opens"). The explorer's double-click dispatches accordingly:
table/view actions open the table tab at that sub-view (`openTableTab` gains an initial-view
param; `sql` also triggers the autorun SQL view); `script-create` scripts the object into a query
tab. Engines lacking the needed capability degrade to `details`.

**Verification procedure:**
1. Settings → General → set tables to "Data" → double-click a table → opens on the Data sub-view;
   restart → the setting persists
2. Set tables to "Script as create" → double-click → a script tab opens instead of a table tab
3. Set routines to "Script as create" → double-click a procedure → its CREATE opens in a query tab
4. On a LanceDB connection double-click always opens Details regardless of the setting

### BASED-UI-TABS: SQL tabs
**Applies to:** based (ui)
**Test category:** manual

Connection-scoped multi-tabs; auto-persisted across restarts; explicit Save/Save-As to `.sql` (Ctrl+S; Ctrl+Shift+S / toolbar "Save As…" always re-dialogs, plain Ctrl+S on a file-backed tab overwrites in place); F5 / Ctrl+Enter run; Cancel toolbar button + Ctrl+Break while running; each tab = three vertically stacked, independently resizable panes (editor → results → output), output collapsible.

**Verification procedure:**
1. Open 2 tabs, type SQL, close app, reopen → both tabs restored with content
2. Ctrl+S → native save dialog → `.sql` written; tab title shows file name
3. On that file-backed tab: edit → Ctrl+S overwrites with no dialog; Ctrl+Shift+S (or "Save As…") → dialog seeded with the current file name → saves to the new path and re-titles the tab
4. F5 runs; run `WAITFOR DELAY '00:00:30'` → Cancel button (and Ctrl+Break) stops it with "cancelled" in Output
5. Drag both pane dividers; collapse/expand Output

### BASED-TAB-AUTONAME-DERIVE: Derive tab title from SQL text
**Applies to:** based (ui)
**Test category:** unit

A pure function `deriveTabTitle(sql)` (`ui/src/lib/deriveTabTitle.ts`) shall map SQL text to a deterministic tab title: `"{verb} {object}"` for the first statement (verb lowercased; object = last dotted segment of the target's name, brackets stripped), `"{verb}"` when no object is found, or `null` when the text has no leading keyword (empty / comments only). Derivation tokenizes rather than parses an AST — deliberately, so it never fails on valid T-SQL an AST parser can't handle — after stripping comments and string literals (mirroring `core/src/db/classify.ts`).

**Acceptance criteria:**
- `SELECT c.Name FROM dbo.Customers c JOIN Orders o ON …` → `select Customers` (first depth-0 `FROM`; a `FROM` inside a subquery in the select list is ignored)
- `WITH cte AS (SELECT … FROM A) SELECT * FROM cte JOIN B …` → `select cte` (CTE list skipped paren-aware; main verb wins, including CTE-prefixed DML)
- `INSERT INTO [dbo].[AuditLog] (…) VALUES (…)` → `insert AuditLog`; `UPDATE TOP (100) Users SET …` → `update Users`; `DELETE FROM #tmp …` → `delete #tmp`
- `EXEC dbo.usp_RebuildIndexes @db = 'x'` → `exec usp_RebuildIndexes` (a `@ret =` assignment is skipped)
- DDL skips object-type keywords: `CREATE TABLE dbo.OrdersArchive (…)` → `create OrdersArchive`; `DROP TABLE IF EXISTS Foo` → `drop Foo`; `TRUNCATE TABLE Foo` → `truncate Foo`; `BACKUP DATABASE x TO …` → `backup x`
- `SELECT 1` → `select`; `''` / whitespace / comment-only → `null`
- Keywords inside string literals or comments never influence the result
- A multi-statement batch is named from the first statement only (depth-0 `;` or `GO` ends it)
- Keyword matching is case-insensitive; identifier case is preserved

### BASED-TAB-AUTONAME-APPLY: Apply derived title on first successful run
**Applies to:** based (ui)
**Test category:** manual

When a query run completes with status `ok` and the tab's title still matches the default `Query N` pattern and the tab is not file-backed, the title shall be replaced by `deriveTabTitle(<the SQL that was executed>)` when non-null. This fires at most once per tab: after the rename the title no longer matches the default pattern, so later runs never rename. Errored/cancelled runs, file-backed tabs, and manually renamed tabs are never renamed. Duplicate titles across tabs are allowed (tabs are keyed by id).

**Verification procedure:**
1. New query tab (`Query N`), run `SELECT * FROM dbo.Customers` → tab title becomes `select Customers`
2. Change the SQL to `DELETE FROM Orders` and rerun → title stays `select Customers` (named once)
3. Open a `.sql` file and run it → tab keeps the file name
4. New tab, run invalid SQL (error) → title stays `Query N`; fix the SQL and rerun → now renamed

### BASED-UI-RESULTS: Results pane
**Applies to:** based (ui)
**Test category:** manual

At the far left of the results toolbar, Grid/Text (and Plan, when a plan was captured — see BASED-UI-EXEC-PLAN) render as real tabs matching the document tab bar's visual language (border dividers, brass inset-shadow active indicator), not a filled pill. Sub-tabs per result set for multi-statement batches. Toolbar: row-count + execution-time stats; Copy cell/row/column/selection; a CSV icon (save via dialog) and an Excel icon (open in Excel), each with a hover tooltip. Row numbers are clickable to multi-select whole rows (shift/ctrl); Copy honors row, column, and range selections. Grid renders NULL, binary, XML, geography safely (placeholder/summary, no crash); truncation notice at the row cap (now the tab bar's fetch-size input value, not a fixed constant).

**Verification procedure:**
1. Run `SELECT 1 AS a; SELECT 2 AS b GO SELECT 3` → 3 sub-tabs, each with stats
2. Toggle grid/text views (far left of the toolbar, styled as tabs)
3. Run a query with NULL, varbinary, and XML columns → placeholders render
4. Copy a cell-range, click row numbers to select whole rows, and click column headers to select columns → Copy clipboard contents match each selection; click the CSV icon → Save dialog; click the Excel icon → Excel launches with the temp file (no repair prompt, even with control/surrogate chars in the data)
5. Row-cap notice appears once fetched rows exceed the tab bar's fetch-size value

### BASED-GRID-SORT: Client-side column sort in the query results grid
**Applies to:** based (ui)
**Test category:** unit (`ui/src/gridView.ts` view computation) + manual

The query results grid sorts client-side over the fetched rows (they are fully client-side up to
the row cap — no server round-trip). Clicking a column header cycles ascending → descending → none;
the sorted column's title carries a ` ▲`/` ▼` suffix. Sorting is stable (equal keys keep arrival
order) and type-aware via a pure `computeViewIndex(rows, columns, sort, filters)` in
`ui/src/gridView.ts`: numeric column types compare numerically; temporal values compare by their
SQL-style string form (lexical = chronological); `{$:"vec"/"bin"}` wire objects compare by their
summary text; NULLs sort first ascending / last descending (SQL Server convention). Copy, CSV, and
Excel export are WYSIWYG — they read the sorted/filtered view, not the arrival order. The
truncation banner notes that sort applies to the fetched rows only.

**Acceptance criteria (unit):**
- Numeric column: `[3, 1, NULL, 2]` asc → `[NULL, 1, 2, 3]`; desc → `[3, 2, 1, NULL]`
- Stability: rows with equal keys keep their original relative order
- A `{$:"bin"}`/`{$:"vec"}` cell sorts by its `cellText` summary without throwing

**Manual:** header click cycles the three states with the arrow suffix; Copy/CSV reflect the view.

### BASED-GRID-FILTER: Per-column filters in the query results grid
**Applies to:** based (ui)
**Test category:** unit (filter mini-language) + manual

Each results-grid column header carries a menu (Glide's header menu icon → a DOM popover) with sort
actions and a filter input. The filter mini-language (`compileFilter(colType, expr)` in
`ui/src/gridView.ts`): plain text = case-insensitive contains over the cell's display text; a
leading `=`, `!=`/`<>`, `>`, `>=`, `<`, `<=` = typed compare (numeric on numeric columns or numeric
cells, case-insensitive string otherwise); the literals `NULL` / `NOT NULL` match nullness.
Operator filters never match NULL cells (SQL semantics). While any filter is active a chip row
above the grid shows "N of M rows · Clear filters". Filtering composes with sort (filter first,
then sort) and is WYSIWYG for copy/export (BASED-GRID-SORT).

**Acceptance criteria (unit):**
- `abc` on a text column matches `xABCy` (contains, case-insensitive); does not match NULL
- `= 5` on an int column matches 5, not 50; `> 5` matches 6, not 5, never NULL
- `!= x` matches `y` but not NULL; `NULL` matches only NULL; `NOT NULL` matches everything else
- `computeViewIndex` composes filter-then-sort and returns original row indices

**Manual:** the header menu opens positioned at the header; typing a filter narrows rows live; the
chip row's count is correct and Clear filters restores everything.

### BASED-UI-GRID-COLUMNS: Resizable, auto-fit grid columns with hover tooltip and Data-tab export
**Applies to:** based (ui)
**Test category:** manual

Both the query-results grid (BASED-UI-RESULTS) and the Edit Data grid (BASED-UI-TABLE-EDIT, including read-only LanceDB tables) support: dragging a column border to resize; columns default to a content-fit width (header + currently-loaded cell values, capped so one huge value can't blow out the grid); a "Fit columns" toolbar action resets manually-resized columns back to content-fit; hovering a cell whose text is wider than its column shows a tooltip with the full value. The Edit Data grid additionally gains Copy and CSV/Excel export (previously query-results-only), reflecting any pending in-grid edits.

**Verification procedure:**
1. Run a query returning short and long text columns → columns default to roughly fit content, capped at a max width for very long values
2. Drag a column border → resizes and stays at that width as more rows stream in
3. Hover a cell whose text is cut off → tooltip shows the full value; hover a cell that fits → no tooltip
4. Click "Fit columns" → all columns (including manually-resized ones) snap back to content-fit width
5. Repeat 1-4 in the Edit Data grid (Data tab of an mssql table, and a LanceDB table)
6. Edit a cell in Edit Data, then Copy / export CSV → the edited (uncommitted) value appears, not the stale committed one
7. Open a read-only LanceDB table's Data tab → Copy and CSV/Excel export both work despite the grid being read-only

### BASED-GRID-EXPORT-STANDARD: Standard export/copy action set on every data grid
**Applies to:** based (ui)
**Test category:** manual

Every data grid — the SQL results grid (ResultsPane), the Data tab grid (TableDataGrid), and the
embeddings Selection grid (SelectionGrid) — exposes the same toolbar action set: Fit columns, Copy
(selection-or-all, tab-separated), Copy as Markdown (BASED-GRID-COPY-MD), Save as CSV, and Open in
Excel. The action behavior lives in one shared hook (`useGridExportActions` in
`ui/src/components/GridToolbarActions.tsx`); each host creates a single instance that feeds both
its toolbar buttons and its right-click context menu (BASED-GRID-CONTEXT-MENU), so notices ("Copied",
"Saved …") surface in the toolbar regardless of which surface triggered the action. All toolbar
controls (text and icon buttons) render at the same height.

**Verification procedure:**
1. Lasso a selection in the embeddings view → the Selection tab shows a toolbar with row count +
   Fit columns / Copy / markdown / CSV / Excel; each action works on the lassoed rows
2. The same buttons appear and work in the SQL results toolbar and the Data tab toolbar
3. Visually confirm the CSV/Excel/markdown icon buttons are the same height as "Fit columns"/"Copy"

### BASED-GRID-COPY-MD: Copy selection as a markdown table
**Applies to:** based (ui)
**Test category:** unit

A "Copy as Markdown" action copies the current selection (falling back to the whole view when
nothing is selected — same slice semantics as Copy, `computeSelectionSlice` in
`ui/src/gridSelectionText.ts`) to the clipboard as a GitHub-flavored markdown table via
`selectionMarkdown`. The table always includes a header row naming the involved columns (markdown
tables require one, even for range copies that TSV-copy without a header). Cell text uses the same
formatting as Copy (NULL renders as `NULL`, vector/binary render their summary); pipes are escaped
as `\|` and embedded newlines become `<br>`.

**Acceptance criteria:**
- Whole grid, columns `a`,`b`: header `| a | b |` + `| --- | --- |` + one line per row
- A 1×1 range copy still yields a 3-line table (header, separator, value)
- Cell `x|y` → `x\|y`; cell `"l1\nl2"` → `l1<br>l2`; NULL cell → `NULL`
- TSV copy behavior is unchanged by the shared-slice refactor (header only for whole-grid and
  column copies; CRLF line joins)

### BASED-GRID-CONTEXT-MENU: Right-click context menu on grid cells and headers
**Applies to:** based (ui)
**Test category:** manual

Right-clicking a cell in any data grid opens a context menu at the mouse position with the shared
action set: Copy, Copy as Markdown, Save as CSV, Open in Excel. Copy actions use the
selection-or-all slice; the file exports are scoped to the current selection when one exists
(falling back to the whole view). Right-clicking a cell outside the current selection first moves
the selection to that cell; right-clicking inside the selection keeps it. Right-clicking a column
header opens the same sort/filter column menu as the header's menu icon (where header interactions
are enabled — the Data tab keeps its pending-edits gate). The menu closes on action, outside click,
or Escape, and clamps to the viewport.

**Verification procedure:**
1. In the SQL results grid, select a 2×2 range, right-click inside it → menu opens, selection kept;
   Copy yields the range, Save as CSV exports just the range
2. Right-click a cell outside the selection → that cell becomes the selection before the menu opens
3. With no selection, right-click → Copy/Save act on the whole view with a header row
4. Right-click a column header → the sort/filter popover opens (results grid and Data tab browse
   mode; gated with pending edits in the Data tab)
5. Repeat 1-3 in the Data tab grid and the embeddings Selection grid

### BASED-UI-EXEC-PLAN: Execution plan & client statistics controls
**Applies to:** based (ui)
**Test category:** manual

Far right of the document tab bar (`TabStrip`): a compact fetch-size number input (max rows to fetch per run — reuses the app's existing `rowPageSize` setting, default 500, persisted; this is now the *only* place that setting is edited, replacing the page-size `<select>` formerly in the Table Data view), and two checkable icon toggles — **Execution Plan** (captures the actual plan, with runtime stats, on the next run) and **Client Statistics** (captures `STATISTICS TIME, IO` output on the next run) — each with a hover tooltip, styled with the tab bar's active-tab look (brass inset-shadow) when checked. Both toggles are global, not per-tab, and apply to whichever run happens next. When a run captured a plan, a **Plan** tab appears in the results toolbar (BASED-UI-RESULTS) showing an interactive `@xyflow/react` operator-tree diagram: pan (drag), zoom (wheel/pinch), and click a node to open a detail panel (physical/logical operator, estimated vs. actual rows, IO/CPU estimates, subtree cost, object accessed, predicate). A multi-statement run shows a small "Statement 1/2/…" picker above the canvas.

**Verification procedure:**
1. Type a fetch size, tab away or press Enter → value persists across a restart (`GET /api/settings`)
2. Toggle Execution Plan on, run a query against a real table → a "Plan" tab appears next to Grid/Text; toggle off and rerun → Plan tab disappears
3. In the Plan view: drag to pan, scroll/pinch to zoom, click an operator node → detail panel shows its stats; click the canvas background → panel closes
4. Run a batch with 2+ statements with Execution Plan on → a Statement 1/Statement 2 picker appears above the canvas
5. Toggle Client Statistics on, run a query → Output pane shows `SQL Server Execution Times`/`logical reads` text
6. Both toggles on simultaneously → both the Plan tab and the stats messages appear from the same run

### BASED-UI-OUTPUT: Output pane & connection state
**Applies to:** based (ui)
**Test category:** manual

Errors (syntax, permissions, timeout) appear as readable text in the Output pane; a dropped connection or expired token shows a visible "reconnecting…" state (status strip), never a silent hang.

**Verification procedure:**
1. Run `SELECT FROM` → syntax error text in Output, tab flips to Output pane
2. Run `SELECT 1/0` → divide-by-zero message
3. Leave the app idle past token expiry (~1 h) then run a query → status shows reconnecting, query then succeeds

### BASED-UI-SESSION-RESUME: Auto-resume a lost server session
**Applies to:** based (ui), based (core)
**Test category:** manual
**External tests:** specs/based/tests/integration.server.test.ts (the 409 `session-lost` signal — `integration`)

The based server keeps each window's session (active connection, adapter, tabs context) in memory; a server restart or crash wipes it while the browser tab stays open. The UI shall detect this and automatically re-establish the session (re-`connect()` to the same connection/database) with bounded exponential backoff, showing "reconnecting…" in the status strip, with open tabs/schema-filter/active-tab preserved throughout. Detection has two independent triggers, so resume fires whether or not the window is actively making requests when the server comes back:

- **Push:** a `connection-status` SSE snapshot for a different/blank session arriving while the window still believes it's connected. A (re)connecting SSE client always receives such a snapshot up front, so a bare restart (which emits no other event) still trips this.
- **Pull:** any session-scoped API request whose session is gone server-side returns **409 with body `{ error: "session-lost" }`** (distinct from a generic 500 and from the agent endpoint's "connect first" 409). The API client drives the same resume and, once reconnected, transparently retries the original request — so an in-flight action that raced the restart heals instead of surfacing "Not connected".

Concurrent triggers collapse to a single in-flight resume attempt. If the backoff cap is exhausted the status settles on "disconnected" with a clear banner, and a **Reconnect** button appears in the status strip to retry on demand; the button never appears before a connection has actually been established (no connection picked yet).

**Acceptance criteria (pull signal, integration-tested):**
- A session-scoped request (e.g. `GET /api/session/objects`) for a sid with no live adapter responds `409` with `{ error: "session-lost" }`.

**Verification procedure:**
1. Connect, open a few tabs. Kill and restart the based server process; take no further action. Within the backoff window, status strip shows "reconnecting…" then "connected" again with no manual action — tabs/schema filter/active tab unchanged (push trigger via the SSE reconnect snapshot).
2. Connect, then restart the server and immediately run a query or open a table. The action succeeds after a brief reconnect rather than erroring with "Not connected" (pull trigger + retry).
3. Same as (1) but leave the server down past the backoff cap → status settles on "disconnected" with a banner, and a Reconnect button appears in the status strip.
4. Bring the server back up, click Reconnect → status returns to "connected", tabs preserved.
5. Fresh boot with no connection ever made → Reconnect button never appears.

### BASED-HISTORY-UI: Query history panel
**Applies to:** based (ui)
**Test category:** manual

The left rail's lower pane hosts a segmented **Objects | History** toggle (choice persisted in
localStorage). History replaces the object explorer with a panel of two sub-tabs — **Queries**
(BASED-HISTORY, `GET /api/history`) and **Agent** (BASED-AGENT-AUDIT, `GET /api/agent/audit`) —
scoped to the active connection, most-recent-first, fetched on open with a manual refresh button.
Each row shows a status dot (ok / error / cancelled), the first SQL line (mono, truncated), and
relative time · duration · database. A search box filters client-side (substring over the SQL);
status chips filter by outcome. Clicking a row expands it inline: full SQL, error text if any, and
actions — **Insert** (into the active query tab via the existing `insertSqlIntoEditor`), **Open in
new tab** (a fresh query tab with the SQL, not auto-run), **Copy**. The Agent sub-tab is read-only
(kind read/mutation + approved badges; Copy only — never a re-run affordance, which would bypass
the mutation gate).

**Verification procedure:**
1. Run a few queries (one failing) → History → Queries lists them newest-first with correct status
   dots; the failed row expands to show the error text
2. Search narrows the list; a status chip shows only matching rows
3. Insert appends the SQL to the active editor; Open in new tab creates a tab without running it;
   Copy puts the SQL on the clipboard
4. Ask Capi something that runs a read → Agent sub-tab lists it with kind "read"; no run affordance
5. Switch connections → the panel shows only the new connection's history; toggle back to Objects →
   explorer unchanged; the Objects/History choice survives an app restart

### BASED-CHAT-UI: Ask Capi panel
**Applies to:** based (ui)
**Test category:** manual

The right rail hosts the AG-UI chat (`useAgent`/`AgentProvider`), Streamdown-rendered assistant markdown with Shiki SQL highlighting; each SQL block offers **Insert into editor** and **Run**, labeled with the block's leading `--` purpose comment plus its first SQL line (falling back to "sql N" when no comment is present — see `BASED-CHAT-SQL-LABELS`); `run_mutation` renders an approval card whose Approve calls the gated endpoint. Run errors surface in the rail. `CapiAvatar` sits at the bottom-left of the prompt input row, stretched to that row's full height; the send control is an icon button positioned inside the textarea's bottom-right corner (Enter also sends). AI provider setup lives in the settings popover's Agent tab (`BASED-AI-PROVIDER-PROFILES`), not in this rail.

**Verification procedure (requires a healthy model backend — LM Studio engine on the configured host):**
1. Connect to a DB → open the Capi rail → ask "what tables are there?" → answer streams
2. Ask for SQL → a highlighted SQL block appears with Insert / Run, labeled with the agent's purpose comment and the first statement line → Run opens a results tab
3. Ask for an update → approval card renders; Reject = nothing runs; Approve = runs via the endpoint and an audit row appears
4. Kill the app mid-thread, reopen, same connection → the same tab's prior turns are restored from server memory (per-tab restore — BASED-AGENT-THREADS)
5. Capi's avatar renders to the left of the prompt textarea at the textarea's full height; clicking the send icon inside the textarea (or pressing Enter) sends the message; the icon dims while streaming
6. After an answer settles, a subtle wall-clock readout of that turn (send→answer, e.g. `3.1s`) shows at the bottom of the thread; it clears when the next message is sent and is not persisted across reload (front-end only, `performance.now()` bracket around `runAgent`)

**Status note:** endpoint wiring, streaming plumbing, and the RUN_ERROR path are verified live (RUN_STARTED streamed; a model-load failure surfaced cleanly). A successful token stream is pending a healthy LM Studio engine on the host. The persona instructs the agent that user-facing SQL results live in tabs (`open_query_tab`), not pasted into chat — BASED-AGENT-TAB-TOOLS.

### BASED-AGENT-TAB-TOOLS: Tab-aware chat — per-tab threads, workspace tools, results in tabs
**Applies to:** based (ui)
**Test category:** manual (pure builders: unit)

The chat is tab-scoped and tab-aware:

- **Per-tab conversations** (BASED-AGENT-THREADS): the rail's chat session is keyed on the active
  tab's resolved thread id (`originThreadId ?? tab:{connectionId}:{tabId}`, fallback
  `conn:{connectionId}`). The `useAgent` mount is remounted via a React `key` + `initialThreadId`
  (the client's thread id is fixed at construction); a module-level per-thread message cache makes
  in-session switches instant, and a cache miss seeds from the thread-history endpoint via
  `setMessages`. Restored synthetic tool messages (`hist_` ids) are excluded from outbound sends
  via `pruneOutboundMessages`. "New chat" deletes the thread server-side and clears messages — it
  never calls `endSession()` (that would randomize the thread id). A tab switch during a streaming
  run defers the remount until the run finishes, with a banner naming the tab the chat will follow.
- **Workspace snapshot**: every send carries `forwardedProps.tabContext` built by a pure
  `buildTabContext(state)` — active tab identity/SQL/result summaries + the open-tab list — which
  the server renders into the instructions (BASED-AGENT-TAB-CONTEXT).
- **Frontend tools** (pattern: `run_mutation`): `list_tabs` (active tab id + per-tab
  id/kind/title/result summaries), `get_tab({ tabId, maxRows? })` (a query tab's SQL, output,
  stats, and serialized result rows — default 50, max 200, cells truncated at 300 chars; table/
  routine tabs return columns/definition; unknown id → `{ error, validTabIds }`), and
  `open_query_tab({ sql, run?, title? })` — opens a real query tab via the store, `run !== false`
  awaits completion (15 s race; on timeout reports `status: "running"` while the tab keeps
  streaming) and returns `{ tabId, title, status, durationMs, resultSets, preview }` (10-row
  preview). The agent-opened tab records `originThreadId` so its rail shows the conversation that
  created it (aliasing — BASED-AGENT-THREADS).

**Verification procedure (requires a healthy model backend):**
1. Open two tabs; chat in each → each tab shows its own conversation; switching flips the thread
2. Restart the app, reconnect → each tab's history is restored; a brand-new tab starts empty
3. Close a tab → its thread is deleted (reopening the same table starts fresh); New chat clears only the current tab's thread
4. Ask "show me the customers table" → the agent calls `open_query_tab`; a results tab opens with the grid populated; the chat narrates a short summary instead of dumping rows
5. Click the agent-opened tab → the rail still shows the conversation that created it; closing that tab leaves the origin tab's chat intact; New chat on it starts a fresh thread for that tab only
6. Switch tabs while a run is streaming → a banner names the busy tab; when the run ends the rail follows to the new tab's thread
7. Ask "what's in my other tab?" → the agent calls `list_tabs`/`get_tab` and answers from the other tab's SQL/results

### BASED-CHAT-ACTIVITY: Live agent activity feed
**Applies to:** based (ui)
**Test category:** manual

While a Capi run is in flight the rail shows an abbreviated, live feed of the AG-UI event stream so the user can see what the agent is doing, not just a blank wait. The feed is driven by `useAgent`'s `onLifecycleEvent` (the one hook that fires across every run in a chained turn) captured into a small `activityStore`:
- `run_started` → a **Thinking** step; each run resets the live feed so it only ever shows the *current* run (prior runs' calls are already committed to the thread as settled rows, so the two never double-show the same call).
- `tool_used` → a step labeled with the tool name (snake_case rendered as spaced words, never uppercased — project UI rule).
- `message_added` → drops a trailing Thinking placeholder once the answer text begins streaming.

The last step in the feed carries a spinner (busy indicator); settled steps carry a check. When the run is busy but no event has landed yet and no text is streaming, a baseline **Working…** spinner shows, so a busy spinner is always visible during a run. The feed only renders while `isStreaming`; it is cleared when the user sends a new message and on New chat.

Settled tool calls (backend tools, which have no bespoke frontend renderer — only `run_mutation` does) render in the thread as an **expandable** row: collapsed shows the tool name plus a one-line hint (first string argument); opened shows the full JSON arguments and the tool result. `run_mutation` keeps its approval-card renderer.

**Verification procedure (requires a healthy model backend):**
1. Ask Capi something that triggers a backend tool (e.g. "what tables are there?") → while it runs, a spinner + abbreviated steps (Thinking → tool name) appear live in the rail
2. After the answer settles, each backend tool call shows as a collapsed row → click it → full arguments and the tool result expand; click again → collapses
3. During a multi-step turn the live feed shows only the current step's activity (no duplicate of already-settled calls), and a busy spinner is visible the whole time the run is in flight
4. Send a new message (or New chat) → the live feed resets

### BASED-AI-PROVIDER-PROFILES: Named, user-configured AI provider (agent) profiles
**Applies to:** based (core, ui)
**Test category:** integration (CRUD + migration, `specs/based/tests/integration.agent.test.ts`); manual (active-profile switch actually changing which model the agent runs against, needs a live backend)

Users configure one or more named AI provider profiles (`name`, `kind` — openai-compatible/openai/azure-openai/anthropic —, `baseUrl`, `model`, optional `deployment` for Azure, `instructionSetId`, optional API key) CRUD'd via `GET/POST /api/ai-profiles` and `DELETE /api/ai-profiles/:id`, persisted in `ai_profiles` (metadata) + Credential Manager (API key, keyed by profile id, `ai:` prefix — same convention as `BASED-LANCE-EMBED-PROFILES`). Exactly one profile is active at a time, set via `POST /api/ai-profiles/active` and persisted as `activeAiProfileId` in `AppSettings`; the agent resolves and runs against whichever profile is active. Each profile carries an `instructionSetId` linking it to a reusable instruction set (`BASED-AGENT-INSTRUCTIONS`, default `"default"`); the running agent resolves its instructions from the **active profile's** linked set (via `AgentInstructionsStore.resolveById`), so selecting a profile selects both the model and its persona. A link to a set that no longer exists falls back to the `"default"` set at resolve time. On first use, if no profile exists yet, the legacy single `ai_config` row (or its built-in default) is migrated once into a profile named "Default" (linked to `"default"`) and marked active, carrying over its Credential Manager key. Profiles read from the store without a stored `instructionSetId` (legacy rows) default it to `"default"`.

**Acceptance criteria:**
- The migrated "Default" profile has `instructionSetId: "default"`
- A profile saved with an explicit `instructionSetId` persists and round-trips via `GET`
- A profile saved with no `instructionSetId` reads back as `"default"`

**Verification procedure:**
1. Settings (gear icon) → Agent tab → see the migrated "Default" profile (or an empty list on a fresh install) → Add a second profile (the form takes over the tab; see `BASED-AGENT-INSTRUCTIONS-UI`) pointing at a different local model, choose its Instructions set → Save returns to the list
2. Click a profile row to mark it active (✓ appears next to its name) → ask Capi something → the request runs against the newly active profile's endpoint using that profile's linked instruction set
3. Editing a profile with a blank API key field keeps the previously stored key; deleting a non-active profile removes it from the list and Credential Manager; deleting the active profile clears the active selection
4. Point a profile's Instructions at a custom set, make it active → the agent's behavior reflects that persona; delete that set → the agent falls back to the Default persona instead of erroring

### BASED-AI-PROVIDER-WIRED: Native openai / azure-openai / anthropic providers
**Applies to:** based (core, ui)
**Test category:** unit (branch resolution); manual (live round-trip)

`resolveModel` shall construct a real AI SDK model for every `ProviderKind`: `openai` via `@ai-sdk/openai` (`createOpenAI`, optional custom base URL), `azure-openai` via `@ai-sdk/azure` (`createAzure` with `baseURL` = the full resource endpoint; the model that runs is the profile's `deployment`, which is required), and `anthropic` via `@ai-sdk/anthropic` (`createAnthropic`, optional custom base URL). These three kinds require a stored API key — a missing key throws an actionable error naming the provider (never the openai-compatible "not-needed" placeholder). The `openai-compatible` branch is unchanged except its provider instance name becomes the stable string `"openai-compatible"` so provider options have a predictable namespace (BASED-AI-PROFILE-PARAMS). All three packages ride the app's `ai@7` generation (`@ai-sdk/provider@4.x`); the Mastra (`ai@6`) transitive copies stay untouched.

**Acceptance criteria:**
- `openai` / `anthropic` with a key → a model whose `modelId` equals the profile's `model`; `azure-openai` → `modelId` equals the profile's `deployment`
- `azure-openai` without `deployment` throws an error mentioning "deployment"
- `openai` / `azure-openai` / `anthropic` with no key throw an error naming the provider kind
- `openai-compatible` with no key still resolves (local LM Studio path unchanged)

**UI (manual):** the profile form's field requirements are per-kind — base URL required for `openai-compatible` and `azure-openai` (labeled "Endpoint" for Azure, placeholder showing the resource-URL shape), optional for `openai`/`anthropic` (blank = provider default); `deployment` required for `azure-openai`. A profile pointed at a live provider with a real key streams a chat turn.

### BASED-AI-PROFILE-PARAMS: Per-profile model parameter JSON
**Applies to:** based (core, ui)
**Test category:** unit (split logic); integration (persistence); manual (params observably reach the endpoint)

`AiProfile` gains an optional `params` object (arbitrary JSON, persisted in the profile metadata store — it contains no secrets). A pure `resolveExecutionDefaults(kind, params)` splits it into Mastra execution defaults: recognized AI SDK call-settings keys (`temperature`, `topP`, `topK`, `maxOutputTokens`, `presencePenalty`, `frequencyPenalty`, `stopSequences`, `seed`, `maxRetries`) become `modelSettings`; an explicit `providerOptions` key is taken verbatim and deep-merged; every other key lands under the kind's provider-options namespace — `"openai-compatible"` for openai-compatible, `"openai"` for both `openai` and `azure-openai` (the Azure provider rides the OpenAI models), `"anthropic"` for anthropic. The agent endpoint applies the result to the built agent's default options, so every run of the active profile carries its params (e.g. `reasoning_effort` for LM Studio / OpenAI-compatible gateways, which spread the namespace object into the request body).

**Acceptance criteria:**
- `{ temperature: 0.2, reasoning_effort: "low" }` with kind `openai-compatible` → `modelSettings: { temperature: 0.2 }`, `providerOptions: { "openai-compatible": { reasoning_effort: "low" } }`
- Explicit + implicit merge: `{ providerOptions: { openai: { a: 1 } }, reasoning_effort: "low" }` with kind `openai` → `providerOptions.openai` carries both `a` and `reasoning_effort`
- Empty/absent params → no `modelSettings`, no `providerOptions` (undefined, not `{}`)
- A profile saved with `params` round-trips through the ai-profiles API and store reopen (integration)

**UI (manual):** the profile Add/Edit form gains a "Model parameters (JSON)" textarea; invalid JSON blocks Save with an inline error; clearing it removes the params. A `reasoning_effort` value observably changes the request the model backend receives.

### BASED-CHAT-SQL-LABELS: Purpose-comment labels on SQL blocks
**Applies to:** based (ui + core)
**Test category:** unit

The MSSQL persona shall instruct the model to make the first line of every ```sql fence a single-line comment (`-- ...`) briefly stating what the statement does. The chat UI shall parse each fence (`parseSqlBlocks` in `ui/src/lib/sqlBlocks.ts`) into `{sql, label, firstLine}`: `label` is the text of a leading `--` comment (or null), `firstLine` is the first non-empty non-comment line, and `sql` is the full fence content including the comment (what Insert/Run receive).

**Acceptance criteria:**
- Fence `-- Add covering index\nCREATE INDEX ...` → `label: "Add covering index"`, `firstLine: "CREATE INDEX ..."`, `sql` retains the comment line
- Fence with no leading comment → `label: null`, `firstLine` = first non-empty line
- Multiple leading comments → only the first becomes `label`; the rest stay in `sql`
- Multiple fences → one block each, order preserved; empty and non-`sql` fences ignored
- All-comment fence → `firstLine` falls back to the raw first line
- `MSSQL_PERSONA` contains the leading-comment instruction

---

## LanceDB engine (Phase 3 — workstream D)

A second database engine behind the `DatabaseAdapter` interface: LanceDB, both **cloud** (`db://slug` + API key + region) and **file-based** (a local directory). The engine is a property of the connection: each adapter declares its `capabilities` and exposes its own agent toolset + persona — the SQL Server and LanceDB toolsets deliberately do not match. `@lancedb/lancedb` is a napi module; loading it under Bun is the go/no-go gate (`BASED-LANCE-SPIKE`).

### BASED-LANCE-SPIKE: napi go/no-go under Bun
**Applies to:** based (core)
**Test category:** manual

`@lancedb/lancedb` shall load and run under Bun on Windows: open a table, create a fixed-size vector column, run a vector search and a full-text search. Failure blocks the whole workstream (fallback: a Node sidecar).

**Verification procedure:** create a table, vector-search, filter, under `bun run` on Windows. **Result: PASS under bun 1.3.14** (NAPI_LOAD_OK, CREATE_TABLE_OK, VECTOR_SEARCH_OK, FILTER_QUERY_OK); FTS + hybrid + Arrow schema introspection separately verified. The Electrobun pinned-Bun packaged load remains a later manual check under workstream E's shell gate.

### BASED-LANCE-ENGINE: Engine discriminator + adapter factory
**Applies to:** based (core)
**Test category:** integration

`ConnectionConfig` carries an optional `engine` discriminator; `engineOf(cfg)` defaults an absent value to `"mssql"` so every legacy config stays valid with no migration. `createAdapter(cfg, getSecret, opts)` is **async** (BASED-LAZY-ENGINES: each branch dynamic-imports its adapter module) and resolves to a `DatabaseAdapter` chosen by engine; `testConnection` is engine-agnostic (builds the adapter, runs its `probe()`). Session/tool code holds the interface, not a concrete class.

**Acceptance criteria:**
- A config with no `engine` resolves to the MSSQL adapter; the full existing suite stays green (behaviour-preserving)
- A config with `engine: "lancedb"` resolves to the LanceDB adapter

### BASED-LANCE-CONNECT: Cloud + local connect and probe
**Applies to:** based (core)
**Test category:** integration

The LanceDB adapter shall connect file-based (uri = a directory) and cloud (`db://slug` + API key from the secret channel + region), and `probe()` reports ok with a LanceDB server string or an error.

**Acceptance criteria:**
- A local dir probe returns `ok: true` with a `serverVersion` matching `/LanceDB/`
- Cloud connect (opt-in, env-gated `BASED_LANCE_CLOUD_URI`/`_KEY`; self-skips otherwise) connects and lists tables

### BASED-LANCE-BROWSE: List tables, columns (incl. vectors), page rows
**Applies to:** based (core)
**Test category:** integration

The adapter shall list tables (flat, no schemas), map the Arrow schema to `TableColumn` — flagging a `FixedSizeList` column as a vector with its dimension and element type, and every column `isPrimaryKey: false` — and read a page of rows (offset/limit, `orderBy: []` since LanceDB is unordered).

**Acceptance criteria:**
- `listObjects()` returns the seeded table with `type: "table"`; `listSchemas()` is empty
- `getTableColumns` marks the vector column `isVector` with the right `vectorDimension`; no column is a PK
- `readTablePage` returns ≤ pageSize rows; a second page differs

### BASED-LANCE-WIRE: Vector wire summary + column metadata
**Applies to:** based (core)
**Test category:** unit

A vector cell serializes to `{$:"vec", dim, preview}` (a short leading slice) rather than a full embedding, keeping rows small for the grid and the model. `TableColumn` gains optional `isVector`/`vectorDimension`/`vectorMetric`/`elementType`; MSSQL never sets them and its wire format is unchanged.

**Acceptance criteria:**
- A vector value (array, TypedArray, or Arrow `Vector`) → `{$:"vec"}` with `dim` = length and a bounded `preview`
- A scalar value serializes exactly as before

### BASED-LANCE-VECTOR-SEARCH / BASED-LANCE-FTS / BASED-LANCE-HYBRID: Search
**Applies to:** based (core)
**Test category:** integration

The adapter's `search()` method (BASED-LANCE-SEARCH-UNIFIED) supports three modes through one call: nearest-neighbour vector search (`.vectorSearch`, a raw vector or a text query embedded via a configured embedding profile — BASED-LANCE-EMBED-COMPUTE), full-text search over an FTS index (`.fullTextSearch`), and hybrid search (both, fused internally with reciprocal rank fusion). A `where` prefilter predicate is supported uniformly on all three modes. Score columns (`_distance`/`_relevance_score`) come back as ordinary numeric columns.

**Acceptance criteria:**
- Vector search for a row's own vector returns that row first, with a distance column
- Text search returns rows containing the keyword
- Hybrid search returns fused rows with a relevance/score column
- `where` narrows results on all three modes

### BASED-LANCE-SEARCH-UNIFIED: One search pipeline for vector/keyword/hybrid, with optional rerank and floor/delta filtering
**Applies to:** based (core)
**Test category:** integration

`DatabaseAdapter.search(params: LanceSearchParams)` is the single entry point for vector/text/hybrid search, replacing three separate methods. Pipeline: resolve `vector` from `query` via the selected embedding profile if needed (vector/hybrid modes) → fetch `sampleSize` native candidates for the chosen mode (prefiltered by `where`) → if a reranker profile is given, call it with the candidate documents and keep its scores as `_rerank_score`; otherwise sort by whichever native score column is present (`_distance` ascending, anything else descending) → apply `floor` (drop results worse than an absolute threshold) and `delta` (drop results trailing the #1 result's score by more than this) against the active score column → truncate to `keepSize`. `EngineCapabilities.search` (replacing the old `vectorSearch`/`fullTextSearch`/`hybridSearch` flags) gates whether an engine exposes this at all.

**Acceptance criteria:**
- `search({mode:"vector", vector, sampleSize, keepSize})` returns at most `keepSize` rows sorted by ascending `_distance`
- `delta` drops rows whose `_distance` exceeds the top result's by more than the given delta
- `floor` drops rows scoring worse than the given absolute threshold
- A configured reranker profile reorders and truncates results to `keepSize` by `_rerank_score`, independent of the native score order
- `mssqlAdapter.capabilities.search` is `false`; `lanceAdapter.capabilities.search` is `true`

### BASED-LANCE-AGENT-SURFACE: Per-engine agent tools + persona + skills
**Applies to:** based (core)
**Test category:** unit + integration

The agent surface is a property of the engine. `agentSurfaceFor(engine, deps)` returns the engine's tools, persona fragment, and skill tags. SQL Server exposes `get_schema`/`sample_rows`/`run_query`; LanceDB exposes `get_schema`/`sample_rows`/`vector_search`/`text_search`/`hybrid_search` — each a thin wrapper over the adapter's unified `search()`, additionally accepting `sampleSize`, `where`, `embeddingProfileId`, `rerankerProfileId`, `floor`, and `delta` — plus its own `run_query` for read-only DuckDB SQL on local connections (BASED-LANCE-AGENT-SQL). The system prompt is a generic core + the engine persona + the engine-filtered skill catalog. `buildAgent` selects the surface by the session connection's engine.

**Acceptance criteria:**
- The MSSQL surface contains `run_query` and no `vector_search`; the LanceDB surface contains `vector_search`/`text_search`/`hybrid_search` (and its own `run_query` — BASED-LANCE-AGENT-SQL) but no `run_mutation` — the two toolsets do not match
- The LanceDB surface carries `skillTags: ["lancedb"]`; `lance-search` appears only in a LanceDB catalog
- The `vector_search` tool runs end-to-end against a live LanceDB table
- The three tools accept `embeddingProfileId`/`rerankerProfileId`/`floor`/`delta` and pass them through to `search()`
- Both engine surfaces additionally contain `read_rows` (BASED-AGENT-READ-ROWS), `export_data` (BASED-AGENT-EXPORT), and `script_object` (BASED-SCRIPT-OBJECT); the vector/hybrid search tools carry the tuning knobs of BASED-LANCE-SEARCH-KNOBS

### BASED-LANCE-UI: Engine selector, vector display, read-only browse, SQL gating
**Applies to:** based (ui)
**Test category:** manual

The connection dialog gains an Engine selector (SQL Server / LanceDB); LanceDB shows a Cloud/Local mode with URI/region/API-key or a directory path (SQL fields hidden). Vector columns render as `vector[dim] type`; vector cells render as `vec[dim] [v0, v1, …]`. LanceDB tables (no PK) browse read-only. The SQL editor / new-query affordance is hidden for LanceDB **Cloud** connections only — local connections have a SQL editor via the embedded DuckDB (BASED-LANCE-SQL / BASED-LANCE-SQL-GATING). SQL-tab and Data-tab-search gating are both driven by the real `EngineCapabilities` from the connection response (BASED-CAPABILITIES-WIRE), not a hardcoded `engine === "mssql"` check.

**Verification procedure:**
1. New connection → Engine: LanceDB → Local → set a directory with a LanceDB table → Test → ok → Save
2. Connect → object tree lists tables (no schemas/procs) → open one → the vector column shows `vector[dim]`; the grid is read-only; cells show `vec[dim] […]`
3. The "+" new-query button is present for a local LanceDB connection and absent for a Cloud one (BASED-LANCE-SQL-GATING)
4. Open the Capi rail → "find rows similar to X" → the agent calls `vector_search`/`hybrid_search` and renders results (needs a healthy model backend)

### BASED-CAPABILITIES-WIRE: Real EngineCapabilities exposed end-to-end
**Applies to:** based (core, ui)
**Test category:** manual

`GET /api/session/state` and `POST /api/session/connect`'s responses both carry `capabilities: EngineCapabilities | null` (the live adapter's `{sql, search, write, orderedBrowse}` — see BASED-TABLE-ORDERBY for `orderedBrowse` — or `null` when disconnected). The frontend store keeps a `capabilities` field set from every connect response and resets it to `null` on disconnect; `TableDetailsView`'s SQL-tab gate, `TableDataGrid`'s Browse/Search toggle, `TabStrip`'s "+" new-query button, and the store's `newQueryTab` guard all read it instead of hand-rolling `engineOf(conn) === "mssql"`. (Capabilities may be **dynamic per config**: the Lance adapter reports `sql: true` locally and `false` on Cloud.)

**Verification procedure:**
1. Connect to a SQL Server connection → the SQL tab is visible, no Search toggle appears in the Data tab
2. Connect to a LanceDB Cloud connection → the SQL tab is hidden, a Browse/Search toggle appears in the Data tab; a local LanceDB connection shows both
3. Disconnect → reconnecting to either engine re-derives the gating correctly (no stale capabilities from the prior connection)

### BASED-LANCE-EMBED-PROFILES: Named, user-configured embedding profiles
**Applies to:** based (core, ui)
**Test category:** manual

Users configure one or more named embedding profiles (`name`, `baseUrl`, `model`, optional API key) pointing at any OpenAI-compatible `/v1/embeddings` endpoint (LM Studio, OpenAI, etc.), CRUD'd via `GET/POST /api/embedding-profiles` and `DELETE /api/embedding-profiles/:id`, persisted in `embedding_profiles` (metadata) + Credential Manager (API key, keyed by profile id, `embed:` prefix). A search picks one via `embeddingProfileId`.

**Verification procedure:**
1. Settings (gear icon) → Search tab → Embedding profiles → Add → name it, point `baseUrl` at a running LM Studio embeddings endpoint, set the model id → Save
2. The profile appears in the Data tab's Search toolbar's embedding-profile dropdown for a LanceDB table
3. Editing the profile with a blank API key field keeps the previously stored key; Delete removes it from both the list and Credential Manager

### BASED-LANCE-RERANK-PROFILES: Named, user-configured reranker profiles
**Applies to:** based (core, ui)
**Test category:** manual

Users configure one or more named reranker profiles (`name`, `baseUrl`, optional `model`, optional API key, optional `api`, optional `instruction`), CRUD'd via `GET/POST /api/reranker-profiles` and `DELETE /api/reranker-profiles/:id`, persisted the same way as embedding profiles (`reranker_profiles` table + Credential Manager `rerank:` prefix). `api` selects the endpoint shape: `"rerank"` (default, and what legacy api-less rows mean) is a generic Cohere/TEI-shape rerank endpoint (`POST {baseUrl}/rerank {query, documents, top_n?} -> [{index, relevance_score}]`); `"openai"` is an OpenAI-compatible chat-completions endpoint scored via yes/no logprobs (BASED-LANCE-RERANK-OPENAI), for which the profile form requires `model` and offers the `instruction` override. A search picks a profile via `rerankerProfileId` plus optional `rerankerOptions` (`topN`, `temperature`).

**Verification procedure:**
1. Settings → Search tab → Reranker profiles → Add a profile pointing at a running rerank server → Save
2. Run a search in the Data tab with that reranker selected → results are reordered/truncated by `_rerank_score` instead of the native distance/relevance score
3. Add a second profile with API = "OpenAI chat completions (yes/no logprobs)", Base URL = an LM Studio `…/v1` running a non-thinking Qwen3-Reranker GGUF, Model = its LM Studio identifier → run the same search with this profile → rows carry `_rerank_score` in (0,1) and the order changes vs. the native score
4. Editing either profile with a blank API key keeps the stored key; a legacy profile (saved before `api` existed) still calls `POST {baseUrl}/rerank`
5. With a reranker selected, the search toolbar shows a "Rerank col" picker listing the table's string columns (default "auto" = the content-column heuristic); picking one sends it as `rerankTextColumn` and the rerank documents come from that column

### BASED-LANCE-RERANK-OPENAI: OpenAI chat-completions scoring mode (yes/no logprobs)
**Applies to:** based (core)
**Test category:** integration

When a resolved reranker profile has `api: "openai"`, the rerank step scores each candidate with one `POST {baseUrl}/chat/completions` request instead of a single `/rerank` call — the Qwen3-Reranker scheme: the model judges yes/no and relevance is the two-token softmax over the yes/no logprobs of the first generated token. Requests carry the Qwen judge system prompt, a user message `<Instruct>: {instruction}\n<Query>: {query}\n<Document>: {document}` (instruction defaults to "Given a web search query, retrieve relevant passages that answer the query", overridable per profile), `model`, `max_tokens: 1`, `temperature: 0`, `logprobs: true`, `top_logprobs: 20`, and `authorization: Bearer` when the profile has a key. Calls are bounded to 8 concurrent. The result shape is identical to the `rerank` api (same `RerankResult[]`, same `_rerank_score` pipeline); `rerankerOptions.topN` is applied based-side (sort desc, slice) mirroring Cohere `top_n`; `rerankerOptions.temperature` is a documented no-op in this mode. Transient per-document failures (5xx, network error, or a 200 response missing `logprobs` — all observed intermittently from LM Studio under concurrent load) get one retry after a short backoff; if the retry also fails transiently, that document scores 0 and the search still completes. 4xx responses are misconfiguration and fail the rerank immediately, with any HTML error body stripped to text and truncated before it reaches the error message (both api paths).

**Acceptance criteria:**
- One chat-completions request per candidate document, each with the prompt/body shape above; results reorder by `_rerank_score`
- Score = `pYes / (pYes + pNo)`, summing probability over all case/whitespace token variants of "yes"/"no" in `top_logprobs`; "no" absent from the returned top-k → score falls back to raw `pYes`; neither present → that document scores 0
- `rerankerOptions.topN` truncates the scored set to the top N even when `keepSize` is larger
- A missing-logprobs or 5xx response for a single document is retried once, then degrades that document to score 0 without aborting the search; healthy documents are not retried
- Only when **no** document could be scored does the search fail: a server that never returns logprobs → descriptive error mentioning logprobs support
- Every document scoring neither yes nor no (e.g. a thinking-enabled chat template emitting `<think>`) → descriptive error suggesting a non-thinking template
- A 4xx response fails immediately (no retry/degrade) on both api paths, with HTML error bodies reduced to their text in the message

### BASED-LANCE-RERANK-PIPELINE: External rerank is a separate, optional step from LanceDB's internal RRF
**Applies to:** based (core)
**Test category:** integration

`search()`'s reranker profile step is a based-side, always-optional, always-external post-processing pass — distinct from the `RRFReranker` LanceDB's own `hybrid` mode uses internally to fuse vector+FTS candidates (which is never itself user-configured). When a reranker profile is given: build one "document" string per candidate — from `rerankTextColumn` when supplied, else a heuristic: a conventionally-named content column (`text`, `content`, `body`, `document`, `chunk`, `passage`, `summary`, `description`, `message`, case-insensitive) if present, else the string column with the longest values across the sampled candidates (so an id/ref column that happens to sort first can't win), else the first non-vector column. Document text is capped at 6000 characters before sending (over-long documents overflow small local rerankers' context windows, which then silently return no logprobs). POST the documents to the profile's rerank endpoint, attach the returned scores as `_rerank_score`, and resort/truncate by that score — for any of the three search modes, not just hybrid.

**Acceptance criteria:**
- A reranker profile applied to a plain `text` or `vector` search (not just `hybrid`) reorders results by `_rerank_score`
- With no reranker profile, `hybrid` mode still fuses vector+FTS via LanceDB's internal RRF exactly as before
- The rerank HTTP call handles both `{results:[...]}` (Cohere) and a bare-array response shape, and both `relevance_score`/`score` field names
- A table whose first string column is an id/ref still sends the conventionally-named content column (e.g. `text`) as document text; with no conventional name, the string column with the longest sampled values wins; explicit `rerankTextColumn` always overrides the heuristic
- Documents sent to the rerank endpoint are truncated to 6000 characters

### BASED-LANCE-SEARCH-KNOBS: Vector-query tuning knobs end-to-end
**Applies to:** based (core)
**Test category:** integration

`LanceSearchRequest` gains the Lance SDK's vector-query tuning knobs — `distanceType`
(`l2|cosine|dot`), `nprobes`, `refineFactor`, `ef`, `postfilter`, `bypassVectorIndex`,
`distanceRangeLower`/`distanceRangeUpper` — applied by the adapter (`applyVectorKnobs`) in the
vector branch and in the hybrid branch (after `.nearestTo`, before the RRF `.rerank`). They are
vector/hybrid-only: any of them combined with `mode: "text"` throws a descriptive error before
querying. The HTTP route (`POST /api/session/lance-search`) forwards them via its existing spread.
The agent search tools split their option fields: `vector_search`/`hybrid_search` expose all eight
plus `rerankTopN`/`rerankTemperature`/`rerankTextColumn` (mapped to the adapter's existing
`rerankerOptions`/`rerankTextColumn`); `text_search` exposes the rerank fields but none of the
vector knobs (schema-level omission beats a runtime error). Deliberately not exposed:
`fastSearch()` (silently drops unindexed rows — a recall footgun), `minimumNprobes`/
`maximumNprobes` (near-duplicates of `nprobes`), `explainPlan()` (a diagnostic, not a search
parameter — future work).

**Acceptance criteria:**
- `distanceRangeLower`/`Upper` bound results on the seeded (unindexed → exact search) table; `postfilter: true` with a selective `where` returns no more rows than the prefiltered equivalent
- `nprobes`/`ef`/`refineFactor`/`bypassVectorIndex` on an unindexed table do not error (flat-search no-ops)
- Any vector-only knob with `mode: "text"` errors descriptively without querying
- Agent `vector_search` forwards `rerankTopN` to the rerank endpoint as `top_n` (observed by a fake rerank server)
- `text_search`'s input schema contains no vector-knob fields

### BASED-LANCE-VECTOR-METRIC: Vector index metric surfaced on columns
**Applies to:** based (core)
**Test category:** integration

`getTableColumns` populates `TableColumn.vectorMetric` for an ANN-indexed vector column from
`Table.listIndices()` + `indexStats().distanceType` (normalized to `l2|cosine|dot`; anything else
or an unindexed column stays `null`). The lookup is memoized per `${schema}/${table}` for the
connection's lifetime (cleared on `disconnect()`) — `getTableColumns` runs on every page read and
search, and index metadata doesn't churn mid-session. Any introspection failure degrades to
`null`, never an error.

**Acceptance criteria:**
- An indexed vector column reports the index's metric; unindexed columns report `null` *(test creates a small IVF index; self-skips if index training fails on the small fixture)*
- A second `getTableColumns` call for the same table does not re-run the index introspection (memoized)

### BASED-LANCE-SEARCH-UI: Data tab Browse/Search toggle and controls
**Applies to:** based (ui)
**Test category:** manual

For a LanceDB table (gated on `capabilities.search`, BASED-CAPABILITIES-WIRE), the Data tab's toolbar gains a Browse/Search toggle. Search mode replaces the browse toolbar with: a mode selector (text/vector/hybrid), a query text input, an embedding-profile picker (hidden in text mode), a reranker-profile picker with `top_n`/`temperature` inputs, `sampleSize`/`keepSize`/`floor`/`delta` number inputs, a `where` prefilter text input, and Run/Clear buttons. Results render read-only through the same grid component used for browsing, by normalizing the `SearchRows` response into a `TablePage`-shaped value (every column comes back `isPrimaryKey: false`, so the grid's existing PK-based edit gate makes results read-only with no additional logic).

**Verification procedure:**
1. Open a LanceDB table's Data tab → click Search → the browse toolbar is replaced by search controls
2. Pick vector mode, enter a query, pick an embedding profile, Run → results render in the grid, read-only
3. Switch to Browse → the original paginated rows reappear unaffected
4. Set `floor`/`delta`/`sampleSize`/`keepSize` and rerun → the result count and order change accordingly

### BASED-LANCE-SEARCH-PROFILES-UI: Search tab in the settings popover
**Applies to:** based (ui)
**Test category:** manual

The settings popover (gear icon in the left rail, `ThemePicker`) has four tabs — General, Theme, Search,
Agent (`BASED-AI-PROVIDER-PROFILES`) — at a fixed width/height (480×560) that does not change when
switching tabs; a tab whose content is taller than that scrolls internally. The Search tab lists
embedding and reranker profiles with inline Add/Edit/Delete forms (`name`/`baseUrl`/`model`/API key,
blank key on edit = keep stored).

**Verification procedure:**
1. Click the gear icon → Search tab → Add an embedding profile and a reranker profile
2. Both appear in the Data tab's Search toolbar dropdowns for a LanceDB table
3. Edit a profile leaving the API key blank → the previously stored key is preserved (verified by the search still authenticating successfully)
4. Switch between General/Theme/Search/Agent repeatedly → the popover's width and height never change; a tab whose content overflows the fixed height scrolls internally instead of resizing the popover

### BASED-LANCE-FOLDER-BROWSE: native folder picker for the local directory path
**Applies to:** based
**Test category:** manual

The LanceDB connection dialog's Local-mode directory-path field has a Browse button that opens a native OS folder picker and fills the field with the chosen path, instead of requiring the path to be typed by hand. Not shown in Cloud mode (the field there is a `db://slug` URI, not a filesystem path).

**Verification procedure:**
1. New connection → Engine: LanceDB → Mode: Local → click Browse next to the directory-path field
2. A native folder-picker dialog opens; selecting a folder fills the directory-path field with its full path
3. Switch Mode to Cloud → the Browse button is gone; the field is a plain URI text input

### BASED-LANCE-BASEFOLDER: base-folder auto-detect, flattened into the explorer
**Applies to:** based (core)
**Test category:** integration

On a local connect, if the target directory has no LanceDB tables directly but contains subdirectories that are themselves valid LanceDB databases (each opens successfully and has at least one table), `based` treats it as a base folder: every such subdirectory is opened, and their tables are flattened into `listObjects()` with `schema` set to the owning subfolder's name — reusing the existing schema field/filter rather than adding a new UI concept. `listSchemas()` lists the subfolder names, so the Object Explorer's existing schema filter selects one folder's tables. If neither the directory itself nor any subdirectory is a valid LanceDB database, `connect()` throws a descriptive error.

**Acceptance criteria:**
- A directory with tables at its top level behaves exactly as before (single database); `listSchemas()` returns `[]`.
- A directory with 2 subfolders, each a valid LanceDB directory with one table, connects successfully; `listSchemas()` returns both subfolder names; `listObjects()` returns both tables with `schema` set to their owning subfolder.
- `getTableColumns`/`readTablePage` given a `schema` route to that subfolder's table.
- `vectorSearch`/`textSearch`/`hybridSearch` given a table name that's unique across subfolders resolve it automatically; a name present in zero subfolders throws a "not found" error; a name present in more than one subfolder throws an "ambiguous" error naming the conflicting folders.
- A directory with no LanceDB tables anywhere (not at the top level, not in any subfolder) makes `connect()` throw a descriptive error rather than silently connecting to nothing.

### BASED-LANCE-EMBED-COMPUTE: based-side embeddings
**Applies to:** based (core)
**Test category:** integration

`based` computes query embeddings itself rather than relying on LanceDB's native registered-embedding-function mechanism (which requires per-table setup outside based on a per-table basis). When `search()` is called in `vector`/`hybrid` mode with a `query` string and no raw `vector`, and an `embeddingProfile` is resolved (from a user-configured `EmbeddingProfile`, BASED-LANCE-EMBED-PROFILES), `embedQuery()` calls the profile's OpenAI-compatible `/v1/embeddings` endpoint via `@ai-sdk/openai-compatible`'s `embeddingModel()` + `ai`'s `embed()`, and the resulting vector is passed to LanceDB's `vectorSearch`/`nearestTo`. With no embedding profile and no raw vector, the call errors with a message pointing at the alternatives (supply a vector, use `text_search`, or configure a profile).

**Acceptance criteria:**
- `vector`/`hybrid` mode with `query` + a resolved embedding profile computes a vector and returns results ranked by it
- `vector`/`hybrid` mode with `query` and no embedding profile and no raw `vector` throws a descriptive error rather than silently misusing the text as a vector

## Lance SQL + LSP (Phase 4)

Local LanceDB connections get a real SQL query tab — an embedded DuckDB (`@duckdb/node-api`) with the `lance` **core extension** scanning the connection's `.lance` storage directly via `ATTACH … (TYPE lance)` (pushdown, no materialization through JS; also exposes `lance_vector_search(path, column, vector, k, …)`/`lance_fts()` as SQL functions). Both editors gain real Language-Server-Protocol intelligence over a WebSocket transport: an in-house DuckDB language server (no LSP exists anywhere for the DuckDB/DataFusion dialect) and, for SQL Server, the external `sqls` server. Engine-specific native deps (`mssql`, `@lancedb/lancedb`, `@duckdb/node-api`) load lazily at connection time.

### BASED-LAZY-ENGINES: Engine deps load on demand
**Applies to:** based (core)
**Test category:** integration

Importing `@based/core` shall evaluate no engine module: `mssql`/tedious, `@lancedb/lancedb`, and `@duckdb/node-api` load only when a connection of that engine is used. `createAdapter` is async and dynamic-imports the adapter per engine branch; the barrel re-exports no concrete adapter class (tests import them via the `@based/core/mssql` / `@based/core/lancedb` / `@based/core/lancedb-sql` subpath exports).

**Acceptance criteria:**
- A fresh process that imports `@based/core` has no mssql/tedious, `@lancedb`, or `@duckdb` module in `require.cache`
- `createAdapter` resolves the MSSQL class for `engine: "mssql"` and for an engine-less legacy config, and the LanceDB class for `engine: "lancedb"`
- The full suite stays green

### BASED-LANCE-SQL: DuckDB-backed SQL for local LanceDB
**Applies to:** based (core)
**Test category:** integration

`LanceDbAdapter.capabilities` becomes dynamic: `sql: true` for local configs, `false` for Cloud (`db://`) — the lance extension reads storage, not the cloud API. Local `execute()` delegates to a per-adapter `LanceSqlBridge` (`core/src/db/lanceSql.ts`), created lazily on first SQL/LSP use (connecting/browsing never pays DuckDB startup or needs network): dynamic-import `@duckdb/node-api` → in-memory instance → `INSTALL lance; LOAD lance;` (downloads from extensions.duckdb.org into `%USERPROFILE%\.duckdb` on first ever use; failure becomes a descriptive error chunk naming the download, retried on the next run, never cached) → `ATTACH` the local dir (single-db mode gets `USE db` re-applied per query connection — USE is session-scoped while ATTACH is instance-scoped; base-folder mode attaches each subfolder as a namespace matching the explorer's schema names, double-quoted, names containing `"` rejected). Statements are split via `extractStatements` and streamed per result set through the standard `QueryChunk` contract; each query runs on its own connection so `cancel()` (flag + `interrupt()`) only aborts that query. Row cap: unlike MSSQL (which keeps counting the true total), scanning stops once the cap is exceeded — `truncated: true`, `rowCount` = rows seen. Value mapping: fixed-size FLOAT/DOUBLE arrays (Lance vectors) → the `{$:"vec",dim,preview}` wire form; BigInt → number when safe else string; blobs → `{$:"bin"}`; timestamps/decimals via their faithful string forms; lists/structs → JSON summaries.

**Acceptance criteria:**
- Local adapter `capabilities.sql === true`; cloud `false`, and cloud `execute()` emits a graceful error chunk
- `execute("SELECT …")` against a temp-seeded dir emits `resultset`/`rows`/`resultsetEnd`/`done` with correct rows; multi-statement scripts emit one result set each
- Base-folder mode: each subfolder is an attached namespace; a cross-namespace JOIN works
- Vector columns serialize as `{$:"vec", dim, preview}`
- `rowCap` truncates with `truncated: true`
- `cancel()` on a long scan yields `status: "cancelled"` (best-effort)
- A bridge boot failure (e.g. an unattachable folder name; the INSTALL-offline variant carries the same error copy but needs a blocked network — verified manually) emits a descriptive error chunk, and the next run retries the boot

### BASED-LANCE-SQL-PLAN: Actual execution plan for local LanceDB SQL
**Applies to:** based (core), based (ui)
**Test category:** integration

When `execute()` is called with `capturePlan`, the Lance bridge enables DuckDB JSON profiling (`SET enable_profiling='json'` + `profiling_mode='standard'` + `profiling_output=<temp file>`) and runs each statement **materialized** (`runAndReadAll`, not the streaming path): DuckDB only flushes the profile for a fully-executed pipeline, and a streamed non-blocking plan (e.g. a bare scan) never finalizes. After the statement executes (results still emitted, capped for display), the bridge reads the flushed profile and emits one `{type:"plan", format:"duckdb-json", json}` chunk **per statement** carrying the trimmed operator tree (`operator_type`, `operator_cardinality`, `operator_timing`, `extra_info`). The `plan` `QueryChunk` is a discriminated union keyed by `format` — `"showplan-xml"` (MSSQL) vs `"duckdb-json"` — and the shared UI `PlanView` graph renders both by parsing to a common `PlanOperator` tree (DuckDB self-timing is accumulated into `estimatedTotalSubtreeCost` so the existing cost% layout math holds). A metadata-only query (e.g. `count(*)`, `max(id)`) executes no pipeline, writes no profile, and emits no plan (skipped silently); the temp profile file is removed when the run ends. Capture settings can never leak between queries — each `execute()` uses its own connection, closed on completion.

**Acceptance criteria:**
- `capturePlan:true` on a pipeline SELECT (scan/aggregate) → exactly one `{type:"plan",format:"duckdb-json"}` chunk whose JSON parses to a non-empty operator tree naming the scanned table; the normal resultset is unaffected (no extra "Results" tab)
- A 2-statement pipeline script with `capturePlan:true` → one plan chunk per statement
- `capturePlan:false` → zero plan chunks
- (unit) `parseDuckPlanJson` maps `operator_type`→humanized `physicalOp`, `operator_cardinality`→`actualRows`, `extra_info` Table/Filters/Estimated Cardinality, and sets cumulative subtree cost so layout cost% recovers each operator's self-timing share

### BASED-LANCE-SQL-STATS: Client statistics for local LanceDB SQL
**Applies to:** based (core)
**Test category:** integration

When `execute()` is called with `captureStats`, the bridge surfaces the same DuckDB profile's summary as an ordinary `{type:"message"}` chunk in the Output pane — total latency (ms), CPU time, rows returned, rows scanned, peak memory — mirroring how MSSQL client statistics arrive as messages (BASED-CLIENT-STATS). As with the plan, a metadata-only query yields no profile and thus no statistics message.

**Acceptance criteria:**
- `captureStats:true` on a pipeline SELECT → a message chunk containing recognizable text (`Client statistics`, `latency`, `rows returned`, `rows scanned`)
- `captureStats:false` → no client-statistics message

### BASED-LANCE-SQL-GATING: Capability-driven SQL affordances
**Applies to:** based (ui)
**Test category:** manual

TabStrip's "+" new-query button and the store's `newQueryTab` guard key off `capabilities.sql` (amends BASED-CAPABILITIES-WIRE's reader list); the LeftRail schema filter also shows for base-folder Lance connections (subfolders populate `schemas`) while the database selector stays MSSQL-only; the connection dialog's engine copy is mode-aware (Local: has a SQL editor via DuckDB; Cloud: search only); `ensureSqlView`'s generated `SELECT` uses engine-appropriate quoting (`[s].[t]` for T-SQL; `"folder".main."table"` / bare name for Lance).

**Verification procedure:**
1. Connect a local base-folder Lance dir → "+" appears → new query tab → run a cross-folder JOIN → grid shows rows; vector cells render as `vec[dim] […]`
2. Open a table → SQL sub-view → the generated SELECT uses double-quoted `folder.main.table` (no `[dbo]`), and runs
3. Connect LanceDB Cloud → no "+" button, no SQL sub-view (BASED-LANCE-UI)
4. Offline first-use: block network on a machine without a cached lance extension → running SQL shows the descriptive extension-download error in the Output pane; browse/search unaffected

### BASED-LSP-TRANSPORT: WebSocket LSP endpoint
**Applies to:** based (core)
**Test category:** integration

`/api/lsp` upgrades to a WebSocket (token via query param; `authorized()` applies) carrying LSP JSON-RPC, one message per text frame. One live connection per session id; the backend is chosen by the session's engine at upgrade time and torn down on session disconnect/close/server stop and on connection switch. Upgrades are refused (409) for un-connected sessions or engines without `capabilities.sql`. Backends are dynamic-imported per engine. Known Bun workarounds (Windows, Bun 1.3.14): session teardown uses `ws.terminate()` (a server-initiated graceful close wedges `server.stop(force)`), and `RunningServer.stop` bounds `server.stop(true)` with a 2s race after the LSP settle delay.

**Acceptance criteria:**
- Bad token and un-connected sid upgrades are refused (the client's socket errors, never opens)
- A connected LanceDB session upgrades; `initialize` returns completion+hover capabilities
- Disconnecting the session closes the socket server-side
- `startServer().stop()` completes (no hang) after LSP sockets have existed

### BASED-LSP-DUCKDB: In-house Lance/DuckDB language server
**Applies to:** based (core)
**Test category:** integration

No language server exists for the DuckDB/DataFusion SQL dialect, so core implements one (`core/src/lsp/duckdbLsp.ts`): full-document sync, UTF-16 positions, completion (trigger chars `.`, `"`, space) and hover, sourced from the session's `LanceSqlBridge` DuckDB instance — `sql_auto_complete()` (the `autocomplete` extension, installed lazily; catalog-only fallback when unavailable) merged with `duckdb_tables()`/`duckdb_columns()`/`duckdb_functions()` (~5s cache) and a keyword list. Completions therefore see the exact attached Lance catalog. Hover describes tables (with column lists), columns (vector columns called out with dimension), and functions. No diagnostics in v1 (no safe parse-only API); the `publishDiagnostics` wire path exists client-side.

**Acceptance criteria:**
- Completion after `SELECT * FROM ` includes the seeded Lance table (and namespaces in base-folder mode)
- Column completions after `table.`
- Hover on a table/column returns type info; vector columns mention "vector"
- Requests for unknown methods get JSON-RPC error responses, not silence

### BASED-LSP-MSSQL: sqls language server for SQL Server — SUPERSEDED
**Superseded by BASED-LSP-MSSQL-NATIVE** (2026-07-25). The external `sqls` binary bridge
(sql-login-only — Entra/token auth was inexpressible as a go-mssqldb DSN — Windows-only download
via System32 tar.exe, password-embedding DSN, child-process respawn machinery) is deleted; MSSQL
sessions now get the in-house catalog-driven server, which serves **every** auth type by reusing
the session's live authenticated adapter pool. See the STS feasibility memo
(`.claude/plans/sts-intellisense-feasibility.md`) for why porting SqlToolsService's IntelliSense
was rejected (its resolver/binder is a closed-source SMO binary, not in the repo).

### BASED-LSP-MSSQL-NATIVE: In-house MSSQL language server
**Applies to:** based (core)
**Test category:** integration (JSON-RPC against the dev DB via azure-cli auth — the thing sqls
could never test) + unit (pure context/alias helpers) + manual (editor procedure)

MSSQL sessions get LSP from an in-house server (`core/src/lsp/mssqlLsp.ts`) mirroring the DuckDB
server's shape: full-document sync, UTF-16 positions, completion (trigger chars `.`, `[`, space)
and hover, **no diagnostics v1** (duckdb precedent; the client degrades gracefully). Data comes
from the session's **live authenticated adapter** — `listObjects()` plus a new bulk
`listAllColumns()` (one `sys.columns` join across all user tables, ~5s cache) — so every auth
type works, including Entra (the adapter already handles token refresh), and no external binary,
download, or DSN exists. Completion context is deliberately heuristic (sqls-grade, not a parser),
implemented as exported pure functions: after `FROM`/`JOIN`/`APPLY`/`UPDATE`/`INTO`/`DELETE FROM`
→ objects (schema-qualified; `dbo` members also offered bare); after `schema.` → that schema's
objects; after `alias.` or `table.` → that object's columns (alias resolution by regex over the
whole document, bracket-quoted names included); after `EXEC`/`EXECUTE` → procedures; otherwise →
T-SQL keywords + objects + columns of objects referenced in the document. Hover: table/view →
markdown column list (PK-flagged); column → type + owning table. Crash/HTTP failures degrade to
keyword-only completions, never an error to the client.

**Acceptance criteria:**
- (integration) Against the dev DB via **azure-cli** auth: `initialize` advertises
  completion+hover; after `SELECT * FROM ` completions include a known table; `alias.` after
  `FROM <table> t` completes that table's columns; hover on the table returns markdown naming a
  known column; unknown methods get JSON-RPC errors, not silence
- (unit) The pure helpers: context detection for FROM/JOIN/EXEC/schema-dot/alias-dot; alias
  resolution handles `AS` and bare aliases, bracketed identifiers, and multiple FROM/JOIN clauses
- (manual) An Entra connection now gets schema-aware completions in the editor — previously the
  degraded word-based path; a sql-login connection behaves identically (one code path)

### BASED-LSP-UI: Thin Monaco LSP client
**Applies to:** based (ui)
**Test category:** manual

The UI keeps plain `monaco-editor` (no monaco-languageclient/@codingame migration). `ui/src/lsp/`: `client.ts` (JSON-RPC over the `/api/lsp` WebSocket, initialize handshake, 10s request timeouts), `manager.ts` (opens/replaces/disposes the window's one client as `(status, capabilities.sql, activeConnectionId)` change; mirrors **all** query-tab Monaco models as LSP documents — didOpen on create/ready, 250ms-debounced full-text didChange, didClose on dispose, re-didOpen on reconnect; exponential backoff 1s→16s while the store still wants LSP), `providers.ts` (completion + hover providers registered once for language `"sql"`, LSP↔Monaco kind/range/0-vs-1-based mapping; `publishDiagnostics` → `setModelMarkers`). The Vite dev proxy tunnels the socket (`ws: true`). Graceful degradation is a hard requirement: server down / refused upgrade / dead backend / request timeout → providers return empty and the editor behaves exactly as pre-LSP.

**Verification procedure:**
1. Local Lance connection → query tab → typing `SELECT * FROM ` offers the connection's tables; hover a column shows its type
2. Switch to a SQL Server connection → the socket reconnects and the sqls backend serves completions (sql-login)
3. Stop the core server → editor keeps working with Monaco's built-in suggestions; restart → completions come back (backoff reconnect)
4. LanceDB Cloud connection → no LSP socket is opened; editor unaffected

### BASED-LANCE-AGENT-SQL: Agent run_query on local Lance
**Applies to:** based (core)
**Test category:** integration

The LanceDB agent surface gains `run_query`: read-only DuckDB SQL over the attached Lance tables, gated by `isReadOnly` and, at execute time, by `capabilities.sql` (cloud sessions get a graceful error pointing at the search tools). Reuses the engine-agnostic `collectQuery` with `AGENT_ROW_CAP`; reads are audited. `LANCE_PERSONA` explains the DuckDB dialect, `folder.main.table` qualification, and that search tools remain the primary path. `run_mutation` still does not exist for Lance (`capabilities.write` false). The shared `get_schema` tool's default-schema fallback keys off the **engine** (`"dbo"` only for mssql), not `capabilities.sql`.

**Acceptance criteria:**
- The Lance surface contains `run_query` and no `run_mutation`
- `run_query` executes a SELECT against a live seeded table and returns result sets; a mutating statement is refused
- Reads appear in the audit log
- `get_schema` with a bare table name on a base-folder connection searches subfolders (never guesses `dbo`)

## Embeddings visualization — the Atlas view (Phase 5)

An interactive scatter of a LanceDB table's vector space: full-precision vectors stream to the
client once, dimensionality reduction and clustering run in a web worker, and deck.gl renders the
layout live as UMAP converges. Home repo: based. Plan: `plans/lancedb-embeddings-viz.md` (archived
on completion).

### BASED-EMBED-WIRE: Binary vector-sample wire format
**Applies to:** based (core)
**Test category:** unit

`encodeVectorSample`/`decodeVectorSample` (core/src/db/vectorWire.ts) carry a `VectorSampleResult` as `[u32 LE headerLen][JSON header, space-padded to 4-byte alignment][raw float32 block]`. The alignment guarantee lets the client construct a `Float32Array` view directly over the response buffer without copying.

**Acceptance criteria:**
- encode → decode round-trips all header fields and the exact float block
- The float block offset (`4 + headerLen`) is always a multiple of 4, across header lengths and multibyte UTF-8 content
- An empty sample (count 0) survives the round trip

### BASED-EMBED-VECTORS: Full-precision vector sample endpoint
**Applies to:** based (core)
**Test category:** integration

`LanceDbAdapter.readVectorSample(schema, table, {column, limit, textCap?})` returns raw n×dim vectors — the only read path that bypasses the `{$:"vec"}` preview cap — plus the table's non-vector cells (strings capped at `textCap`, default 2000). `GET /api/session/table-vectors?schema&table&column&limit` serves it as the BASED-EMBED-WIRE binary (octet-stream); engines without `readVectorSample` get a 400. The requested limit is clamped by the adapter row cap, a 128MB vector-byte budget, and the table size; when the table exceeds the effective limit, evenly-strided chunks sample across insert order and `sampled:true` is set. Rows with null or wrong-dimension vectors are skipped. A non-vector column name is rejected.

**Acceptance criteria:**
- Full-precision vectors (components past the 8-float preview) with correct `dim`/`count`/`totalRows`, non-vector cells aligned row-for-row with the float block
- `limit < totalRows` → `sampled:true` and coverage past the first `limit` rows of insert order
- Adapter `rowCap` clamps the request
- Non-vector column → error mentioning "vector"
- `textCap` truncates long text cells

### BASED-EMBED-PIPELINE: Client-side reduction/cluster pipeline
**Applies to:** based (ui)
**Test category:** unit

`ui/src/embeddings/pipeline.ts` is the pure, DOM-free math core (seeded mulberry32 RNG, Johnson-Lindenstrauss random projection, exact PCA via subspace iteration, k-means++ with Calinski-Harabasz auto-k, TF-IDF cluster terms, cosine kNN, aspect-preserving position normalization), all over flat Float32Arrays. The worker (`worker.ts`) composes them: project→PCA→UMAP (epoch-streamed via umap-js)→cluster→TF-IDF, with generation-token cancellation. Same table + same seed ⇒ identical layout.

**Acceptance criteria:**
- PCA recovers a planted dominant axis (|dot| > 0.99) and orders components by variance
- k-means auto-k finds k=3 on three separated blobs; labels partition blob membership
- Deterministic under a fixed seed; n<8 degrades to a single cluster
- TF-IDF surfaces distinctive per-cluster terms, skipping stopwords; null docs tolerated
- cosine kNN returns known neighbours in order, excluding the query row
- normalizePositions maps into a centered [-extent, extent] box

### BASED-EMBED-LABELS-AI: AI cluster naming
**Applies to:** based (core)
**Test category:** unit + integration

`POST /api/session/label-clusters` names clusters via the active AI profile's model in ONE `generateText` call (not the agent loop). Input is clamped server-side (≤24 clusters × ≤10 samples × ≤300 chars — truncated, never rejected; `clampClusters`). `buildLabelPrompt` renders id + TF-IDF hint + numbered samples; `parseLabelResponse` extracts the first JSON array from the reply (fences/prose tolerated) and falls back per-cluster to the hint. Empty cluster list → 400; model resolution failure → 400; 60s timeout. The UI keeps TF-IDF labels on any failure.

**Acceptance criteria:**
- Prompt lists every cluster with id, hint, samples; clamp limits enforced
- Clean, fenced, and partially-garbage JSON replies all parse; unknown ids dropped; missing ids fall back to hints
- Endpoint: empty clusters → 400; missing auth → 401; live naming (self-skips when the AI server is unreachable) returns a non-empty label per id

### BASED-EMBED-UI: The Embeddings sub-view
**Applies to:** based (ui)
**Test category:** manual

A fourth sub-view button, "Embeddings", appears on table tabs only when the engine is search-capable AND the table has a vector column. It renders a deck.gl scatter (ScatterplotLayer/Orthographic in 2D, PointCloudLayer/Orbit in 3D) themed from the live CSS variables, with: live epoch-streamed layout ("galaxy condensing"), cluster tints + legend chips (click dims a cluster), numbered callout-badge cluster labels tethered to their centroids by leader lines, always full-strength at any zoom (TF-IDF terms in legend tooltips; AI names on demand replace the numbers), hover tooltip, click → point details panel (a resizable side panel with the row cells + Find similar via client-side cosine kNN, neighbours ringed and the rest dimmed), lasso selection (2D) → ResultGrid panel with a Cell viewer tab (double-click/Enter on a cell), and a points/vector-column/text-column/seed toolbar. Layout state lives in a per-tab engine registry: switching sub-views mid-run does not kill the worker; closing the tab does.

**Verification procedure:**
1. Connect to a LanceDB database with an embeddings table (vector column + a text column); open the table → an "Embeddings" button appears beside Details/Data/SQL (absent on MSSQL tables and vector-less Lance tables).
2. Open it → vectors fetch and the layout animates from noise into structure; the toolbar shows "N rows" (or "N of M rows" with sampling) and epoch progress while running.
3. Toggle 3D → the same layout becomes an orbitable point cloud; drag rotates; toggle back.
4. After clustering: points tint by cluster; numbered callout badges point at each centroid and legend-chip tooltips show the TF-IDF terms; click a legend chip → that cluster dims; zoom in → labels stay fully legible (the "labels" toggle hides them).
5. Hover a point → tooltip with the text snippet and cluster name. Click → right panel opens with the row's cells; drag the panel's left edge to resize it; "Find similar" rings its nearest neighbours and dims the rest; "Clear similar" restores.
6. Lasso (2D only): arm the Lasso button, drag a loop → bottom panel shows the enclosed rows in a grid with a Cell viewer pane underneath; click a cell → the pane shows its full value while the grid stays in view; drag the pane closed, then double-click (or Enter on) a cell → the pane re-expands; close the Selection tab to clear.
7. "AI label" (requires a reachable AI profile) → clusters rename to short model-generated names; on failure an inline error shows and TF-IDF labels stay.
8. Switch to Data and back mid-layout → the run continues (no restart). Close the tab → the worker terminates (no orphan in devtools).
9. Switch among a dark, midtone, and light theme → canvas background, point tints, labels, and legend recolor live.
10. Tiny table (<50 rows) → instant PCA layout with a "PCA (too few rows for UMAP)" note.

Record: PASS/FAIL + date below.
- 2026-07-25 PASS (automated Playwright pass against the dev app, steps 1-6 + 10-equivalent: 3-cluster fixture laid out, labels/legend/tooltip/click-details/find-similar/lasso-grid/2D-3D all verified by screenshot; found and fixed ortho depth-clipping and a lasso pointer-event crash). Steps 7 (AI label — LM Studio was down) and 8-9 (worker survival, theme sweep) pending a human pass.

## Windows packaging & file association

### BASED-PACKAGE-WIN: Packaged app bundle is self-contained
**Applies to:** based (shell)
**Test category:** manual

The electrobun bundle includes the built UI (`build.copy` maps `../ui/dist` → `ui/dist`, landing
at `Resources/app/ui/dist`), and the shell locates it bundle-relative to `process.argv0`
(`findUiDist` in `shell/src/bun/index.ts`) — cwd is unreliable (the launcher chdirs to `bin`;
file-association launches inherit Explorer's cwd). An installed app serves the real UI with no
repo checkout present.

**Verification procedure:**
1. Build + install via `scripts/package-win.ps1` → run from the Start Menu shortcut on a path
   with no repo → the full UI renders (not the bare core page).

- 2026-07-25 PASS (installed via silent Setup; core server on the installed app returned the
  built `ui/dist` index.html).

### BASED-INSTALLER-WIN: Windows installer
**Applies to:** based (repo `scripts/`)
**Test category:** manual

`scripts/package-win.ps1` produces `dist/based-<version>-Setup.exe` (Inno Setup; version read
from `shell/electrobun.config.ts`). It builds the UI, runs `electrobun build --env=stable`,
extracts the stable `tar.zst` (the runnable tree ships inside the self-extractor package),
compiles `scripts/win/based-open.cs` into the bundle with the .NET Framework `csc`
(`/target:winexe`), and hands the tree to `scripts/installer.iss`. The installer is per-user
(`PrivilegesRequired=lowest`, no UAC), installs to `{localappdata}\Programs\based`, creates a
Start Menu shortcut (desktop shortcut as an unchecked task), and registers an Apps & Features
uninstall entry. Uninstall removes the install dir (including runtime logs), shortcuts, and all
registry keys written at install; user data in `%APPDATA%\based` (app.db, agent.db) and
Credential Manager secrets are left in place.

**Verification procedure:**
1. `pwsh scripts/package-win.ps1` (needs Inno Setup 6: `winget install JRSoftware.InnoSetup`) →
   `dist/based-<version>-Setup.exe`.
2. Install → app in Start Menu, entry in Settings → Apps; launch works.
3. Uninstall → install dir + registry keys gone; `%APPDATA%\based` still present.

- 2026-07-25 PASS (steps 1–2: built and silent-installed 0.1.0; uninstall entry present in
  registry. Step 3 pending a human pass).

### BASED-SQL-ASSOC-WIN: .sql "Open with" registration
**Applies to:** based (installer)
**Test category:** manual

The installer registers based as an *available* handler for `.sql` — never overwriting the
user's existing default. All under HKCU: ProgID `based.sql` (friendly name, `DefaultIcon` →
`{app}\icon.ico`, open verb `"{app}\bin\based-open.exe" "%1"`),
`Software\Classes\.sql\OpenWithProgids\based.sql`, and Default Programs registration
(`Software\based\Capabilities` with `FileAssociations: .sql=based.sql`, plus
`Software\RegisteredApplications\based`). The open verb routes through `based-open.exe` because
electrobun's `launcher.exe` (1.18.1) does not forward argv to the bun process: the stub appends
each path to `<dataDir>/pending-open.txt` and starts the launcher with `BASED_STUB_OPEN=1`.

**Verification procedure:**
1. Right-click a `.sql` → Open with → based is listed and opens the file; the previous default
   app is unchanged.
2. Settings → Default apps → based offers `.sql`.
3. Uninstall → based gone from Open with and Default apps.

- 2026-07-25 PASS (registry verified post-install: `based.sql` ProgID + open command,
  OpenWithProgids alongside VSCode/SSMS entries untouched, RegisteredApplications set. Explorer
  UI + uninstall sweep pending a human pass).

### BASED-OPEN-SQL-ARGV: Opening a .sql path at launch
**Applies to:** based (shell + ui)
**Test category:** manual

A launch asked to open files (direct argv paths, or lines in `<dataDir>/pending-open.txt`
written by `based-open.exe`) opens one window per file with `open=<path>` in the URL hash; the
UI (BASED-FILE-OPEN-SQL's `openSqlFile`) loads it into a query tab — titled by file name,
`filePath` set — as soon as the window has a connected session (fresh windows wait for the
user's first connect; restored windows fire right after restore). File-open windows are
additive to BASED-WINDOW-RESTORE. If an instance is already running, the second launch forwards
each path to the primary over the single-instance control server (`POST /open-file`) and exits;
a stub-spawned launch that finds nothing pending (another instance consumed it) exits without
opening a blank window when the primary is alive.

**Verification procedure:**
1. App not running: double-click a `.sql` → app starts, window opens; after connecting, the tab
   shows the file's content and name.
2. App running: double-click another `.sql` → a new window in the same instance (no second
   process); no blank extra windows on rapid multi-double-click.

- 2026-07-25 PASS (installed build: stub → pending-open.txt consumed → window per file; second
  stub launch forwarded to the running primary — secondary exited 0, window count went 2→3 on
  one process. In-tab content rendering after connect pending a human pass).
