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

**Verification procedure:** create a connection with auth type "Entra ID (interactive)", Test Connection → browser opens → sign in → dialog reports success. (Spike 3 script `spikes/03-entra-interactive/spike.mjs` is the standalone equivalent.)

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

### BASED-RECONNECT-RETRY: Token-expiry / dropped-connection retry
**Applies to:** based (core)
**Test category:** unit

When connect/execute fails with a retryable condition (expired Entra token, closed/reset socket), the adapter shall re-mint the token, rebuild the pool, emit a "reconnecting" status, and retry exactly once; a second failure propagates the error.

**Acceptance criteria:**
- Fake pool that fails once with token-expiry then succeeds → operation succeeds, status callback saw `reconnecting`, token minted twice
- Fake pool that always fails → error propagates after exactly 2 attempts
- Non-retryable error (syntax) → no retry, 1 attempt

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

SQL tabs (connection id, title, content, optional file path, order) shall persist automatically so a restart restores each connection's tab set.

**Acceptance criteria:**
- Upsert 2 tabs for a connection → list for that connection returns both in order with content intact after store reopen
- Delete removes a tab; tabs are scoped per connection id

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

A result set shall export to a valid `.xlsx` (header row + data rows) that round-trips through a reader with values intact; "Open in Excel" writes to a temp file and shell-opens it.

**Acceptance criteria:**
- Export 2×2 result → reading the file back yields the same header and cell values
- NULL cells are empty; numbers stay numeric

---

## Agent / AI (Phase 2 — Margin Chat)

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

### BASED-AGENT-THREADS: Per-connection thread persistence
**Applies to:** based (core)
**Test category:** integration

Chat threads persist via Mastra Memory (LibSQLStore, its own `agent.db`), keyed by connection id (resourceId), so a thread's history survives a restart.

**Acceptance criteria:**
- Memory tables live in `agent.db`, not the bun:sqlite `app.db`
- A run with a stable `threadId`/`resourceId` accumulates history in memory

**Verification (this pass):** memory is wired and its store initialises to `agent.db`; multi-turn recall across restart is documented for manual confirmation once a healthy model backend is available (see plan).

---

## UI (manual verification — procedures are the artifact)

### BASED-UI-LAYOUT: Ledger layout
**Applies to:** based (ui)
**Test category:** manual

Three-region workbench: left rail (connection selector, database selector, schema dropdown, object explorer), center tabbed work area, right rail hosting Margin Chat (Phase 2; a "connect to chat" placeholder until a connection is active).

**Verification procedure:** launch app → left rail and center area render; right rail toggle exists and expands/collapses; with a connection active the rail shows Margin Chat.

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

Collapsible accordion grouped by type — Tables, Views, Stored Procedures, Functions — each header showing a count; collapsed groups hide members. Double-clicking a table/view opens a table-details tab (Name, Data Type, Size/Precision/Scale, Nullable, Key) sourced from the same introspection endpoint as everything else.

**Verification procedure:** connect to dev DB → four groups with counts; collapse/expand works; double-click a table → details tab shows its columns with PK marked.

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

Sub-tabs per result set for multi-statement batches. Toolbar: Excel-style grid / plain-text toggle; row-count + execution-time stats; copy cell/row/selection; export CSV/XLSX; "Open in Excel". Grid renders NULL, binary, XML, geography safely (placeholder/summary, no crash); truncation notice at the row cap.

**Verification procedure:**
1. Run `SELECT 1 AS a; SELECT 2 AS b GO SELECT 3` → 3 sub-tabs, each with stats
2. Toggle grid/text views
3. Run a query with NULL, varbinary, and XML columns → placeholders render
4. Copy a cell and a row-range → clipboard contents match; export CSV and XLSX → files open; "Open in Excel" launches Excel
5. Row-cap notice appears for a >50k-row query

### BASED-UI-OUTPUT: Output pane & connection state
**Applies to:** based (ui)
**Test category:** manual

Errors (syntax, permissions, timeout) appear as readable text in the Output pane; a dropped connection or expired token shows a visible "reconnecting…" state (status strip), never a silent hang.

**Verification procedure:**
1. Run `SELECT FROM` → syntax error text in Output, tab flips to Output pane
2. Run `SELECT 1/0` → divide-by-zero message
3. Leave the app idle past token expiry (~1 h) then run a query → status shows reconnecting, query then succeeds

### BASED-CHAT-UI: Margin Chat panel
**Applies to:** based (ui)
**Test category:** manual

The right rail hosts the AG-UI chat (`useAgent`/`AgentProvider`), Streamdown-rendered assistant markdown with Shiki SQL highlighting; each SQL block offers **Insert into editor** and **Run**; `run_mutation` renders an approval card whose Approve calls the gated endpoint. Run errors surface in the rail; a ⚙ panel edits base URL / model / key.

**Verification procedure (requires a healthy model backend — LM Studio engine on the configured host):**
1. Connect to a DB → open the margin rail → ask "what tables are there?" → answer streams
2. Ask for SQL → a highlighted SQL block appears with Insert / Run → Run opens a results tab
3. Ask for an update → approval card renders; Reject = nothing runs; Approve = runs via the endpoint and an audit row appears
4. Kill the app mid-thread, reopen, same connection → prior turns still shown

**Status note:** endpoint wiring, streaming plumbing, and the RUN_ERROR path are verified live (RUN_STARTED streamed; a model-load failure surfaced cleanly). A successful token stream is pending a healthy LM Studio engine on the host.
