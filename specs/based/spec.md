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

Tabs of every kind — query (content, optional file path), table/view (schema, table, object type, current sub-view), and routine (schema, name, routine type) — shall persist automatically, scoped by connection id and kind-specific metadata, so a restart restores each connection's full tab set.

**Acceptance criteria:**
- Upsert one tab of each kind (query, table, routine) for a connection, each with its kind-specific `meta` → list for that connection returns all three in order with `kind` and `meta` intact after store reopen
- Delete removes a tab; tabs are scoped per connection id

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

## Table data (browse + edit) — Phase 3

### BASED-TABLE-BROWSE: Paginated table data read
**Applies to:** based (core)
**Test category:** integration

The adapter shall read a page of a table's rows ordered by a stable key, capped by the row cap, returning columns (with PK flags) and the page rows.

**Acceptance criteria:**
- A known table returns ≤ pageSize rows for `{offset:0, limit:N}`; a second page (`offset:N`) returns different rows
- Ordering is deterministic across page calls (PK if present, else first column)
- Column metadata marks the PK column(s)

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

## Agent / AI (Phase 2 — Ask Capi)

### BASED-AI-PROVIDER: AI provider configuration & model resolution
**Applies to:** based (core)
**Test category:** integration

Provider config (kind ∈ {openai-compatible, openai, azure-openai, anthropic}, base URL, default model, optional deployment) persists in the local store; the API key lives in Windows Credential Manager, never the store. A resolver turns the active config into an AI SDK `LanguageModel`. The out-of-box default targets a local LM Studio OpenAI-compatible server.

**Acceptance criteria:**
- Save config → read back identical fields; the stored record contains no key material
- `setAiKey`/`getAiKey`/`deleteAiKey` round-trip through Credential Manager
- The `openai-compatible` resolver returns a model for a reachable base URL

**Implementation note (no spec impact):** `openai` / `azure-openai` / `anthropic` branches are stubbed pending the settings screen; any provider reachable via an OpenAI-compatible gateway works today. A single `zod@3.25.76` override reconciles the AI SDK's `zod/v4` subpath imports.

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

### BASED-AGENT-THREADS: Per-connection thread persistence
**Applies to:** based (core)
**Test category:** integration

Chat threads persist via Mastra Memory (LibSQLStore, its own `agent.db`), keyed by connection id (resourceId), so a thread's history survives a restart.

**Acceptance criteria:**
- Memory tables live in `agent.db`, not the bun:sqlite `app.db`
- A run with a stable `threadId`/`resourceId` accumulates history in memory

**Verification (this pass):** memory is wired and its store initialises to `agent.db`; multi-turn recall across restart is documented for manual confirmation once a healthy model backend is available (see plan).

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

**Acceptance criteria:**
- Fresh store → `GET` returns exactly one set, `{ id: "default", editable: false, core: GENERIC_CORE, mssqlPersona: MSSQL_PERSONA, lancePersona: LANCE_PERSONA }`
- `POST` with no `id` creates a custom set (`editable: true`); a subsequent `GET` (after store reopen) still returns it
- `POST` with a matching `id` updates that set in place rather than duplicating it
- `POST`/`DELETE` targeting `id: "default"` → 400, no change
- Activating a set persists across a `GET`; deleting the active custom set falls back `activeId` to `"default"`
- Activating an unknown id → 400

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

The gear icon next to Ask Capi opens, alongside the AI-provider fields, an "Agent instructions"
section: a set picker (Default + any custom sets) and three collapsible boxes — Core (shared), SQL
Server persona, LanceDB persona — editable only when the selected set isn't Default. Duplicate clones
the selected set into a new editable one; Save persists edits; Delete removes a custom set.

**Acceptance criteria:**
- Default's three boxes render read-only with a note explaining why; Duplicate creates an editable copy
- Editing a custom set's boxes and clicking Save persists the change across a reload
- Switching the active set persists; deleting a custom set falls back the selection to Default
- A chat turn's behavior reflects whichever set is currently active

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

### BASED-UI-TABS: SQL tabs
**Applies to:** based (ui)
**Test category:** manual

Connection-scoped multi-tabs; auto-persisted across restarts; explicit Save/Save-As to `.sql` (Ctrl+S); F5 / Ctrl+Enter run; Cancel toolbar button + Ctrl+Break while running; each tab = three vertically stacked, independently resizable panes (editor → results → output), output collapsible.

**Verification procedure:**
1. Open 2 tabs, type SQL, close app, reopen → both tabs restored with content
2. Ctrl+S → native save dialog → `.sql` written; tab title shows file name
3. F5 runs; run `WAITFOR DELAY '00:00:30'` → Cancel button (and Ctrl+Break) stops it with "cancelled" in Output
4. Drag both pane dividers; collapse/expand Output

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
**Applies to:** based (ui)
**Test category:** manual

The based server keeps each window's session (active connection, adapter, tabs context) in memory; a server restart or crash wipes it while the browser tab stays open. The UI shall detect this — a `connection-status` SSE snapshot for a different/blank session arriving while the window still believes it's connected — and automatically re-establish the session (re-`connect()` to the same connection/database) with bounded exponential backoff, showing "reconnecting…" in the status strip, with open tabs/schema-filter/active-tab preserved throughout. If the backoff cap is exhausted the status settles on "disconnected" with a clear banner, and a **Reconnect** button appears in the status strip to retry on demand; the button never appears before a connection has actually been established (no connection picked yet).

**Verification procedure:**
1. Connect, open a few tabs. Kill and restart the based server process. Within the backoff window, status strip shows "reconnecting…" then "connected" again with no manual action — tabs/schema filter/active tab unchanged.
2. Same scenario, but leave the server down past the backoff cap → status settles on "disconnected" with a banner, and a Reconnect button appears in the status strip.
3. Bring the server back up, click Reconnect → status returns to "connected", tabs preserved.
4. Fresh boot with no connection ever made → Reconnect button never appears.

### BASED-CHAT-UI: Ask Capi panel
**Applies to:** based (ui)
**Test category:** manual

The right rail hosts the AG-UI chat (`useAgent`/`AgentProvider`), Streamdown-rendered assistant markdown with Shiki SQL highlighting; each SQL block offers **Insert into editor** and **Run**, labeled with the block's leading `--` purpose comment plus its first SQL line (falling back to "sql N" when no comment is present — see `BASED-CHAT-SQL-LABELS`); `run_mutation` renders an approval card whose Approve calls the gated endpoint. Run errors surface in the rail; a ⚙ panel edits base URL / model / key.

**Verification procedure (requires a healthy model backend — LM Studio engine on the configured host):**
1. Connect to a DB → open the Capi rail → ask "what tables are there?" → answer streams
2. Ask for SQL → a highlighted SQL block appears with Insert / Run, labeled with the agent's purpose comment and the first statement line → Run opens a results tab
3. Ask for an update → approval card renders; Reject = nothing runs; Approve = runs via the endpoint and an audit row appears
4. Kill the app mid-thread, reopen, same connection → prior turns still shown

**Status note:** endpoint wiring, streaming plumbing, and the RUN_ERROR path are verified live (RUN_STARTED streamed; a model-load failure surfaced cleanly). A successful token stream is pending a healthy LM Studio engine on the host.

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

`ConnectionConfig` carries an optional `engine` discriminator; `engineOf(cfg)` defaults an absent value to `"mssql"` so every legacy config stays valid with no migration. `createAdapter(cfg, getSecret, opts)` returns a `DatabaseAdapter` chosen by engine; `testConnection` is engine-agnostic (builds the adapter, runs its `probe()`). Session/tool code holds the interface, not a concrete class.

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

The adapter shall support nearest-neighbour vector search (`.nearestTo`/`.vectorSearch`, raw vector or a text query when the table has a registered embedding function), full-text search over an FTS index (`.fullTextSearch`), and hybrid search (both, reranked with reciprocal rank fusion). Score columns (`_distance`/`_relevance_score`) come back as ordinary numeric columns.

**Acceptance criteria:**
- Vector search for a row's own vector returns that row first, with a distance column
- Text search returns rows containing the keyword
- Hybrid search returns reranked rows with a relevance/score column

### BASED-LANCE-AGENT-SURFACE: Per-engine agent tools + persona + skills
**Applies to:** based (core)
**Test category:** unit + integration

The agent surface is a property of the engine. `agentSurfaceFor(engine, deps)` returns the engine's tools, persona fragment, and skill tags. SQL Server exposes `get_schema`/`sample_rows`/`run_query`; LanceDB exposes `get_schema`/`sample_rows`/`vector_search`/`text_search`/`hybrid_search`. The system prompt is a generic core + the engine persona + the engine-filtered skill catalog. `buildAgent` selects the surface by the session connection's engine.

**Acceptance criteria:**
- The MSSQL surface contains `run_query` and no `vector_search`; the LanceDB surface contains `vector_search`/`text_search`/`hybrid_search` and no `run_query` — the two toolsets do not match
- The LanceDB surface carries `skillTags: ["lancedb"]`; `lance-search` appears only in a LanceDB catalog
- The `vector_search` tool runs end-to-end against a live LanceDB table

### BASED-LANCE-UI: Engine selector, vector display, read-only browse, SQL gating
**Applies to:** based (ui)
**Test category:** manual

The connection dialog gains an Engine selector (SQL Server / LanceDB); LanceDB shows a Cloud/Local mode with URI/region/API-key or a directory path (SQL fields hidden). Vector columns render as `vector[dim] type`; vector cells render as `vec[dim] [v0, v1, …]`. LanceDB tables (no PK) browse read-only, and the SQL editor / new-query affordance is hidden for LanceDB connections.

**Verification procedure:**
1. New connection → Engine: LanceDB → Local → set a directory with a LanceDB table → Test → ok → Save
2. Connect → object tree lists tables (no schemas/procs) → open one → the vector column shows `vector[dim]`; the grid is read-only; cells show `vec[dim] […]`
3. The "+" new-query button is absent for the LanceDB connection
4. Open the Capi rail → "find rows similar to X" → the agent calls `vector_search`/`hybrid_search` and renders results (needs a healthy model backend)

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

### BASED-LANCE-EMBED-COMPUTE: based-side embeddings (future work — not built)
**Applies to:** based (core)
**Test category:** manual

When a table lacks a registered embedding function, `based` could embed a text query itself via the configured `@ai-sdk/openai-compatible` provider and pass the raw vector to search. Deferred to keep v1 free of AI-provider coupling; text→vector currently relies on LanceDB's registered embedding functions or a caller-supplied vector.
