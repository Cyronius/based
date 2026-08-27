# based — canonical spec

Requirement prefix: `BASED`. Home repo: `based`.
Architecture reference: [.claude/plans/feasibility-and-architecture.md](../../.claude/plans/feasibility-and-architecture.md).

Test infrastructure: `bun test` from `specs/` (`bun test` is the doctrine deviation recorded in the Phase 1 plan — app runtime is Bun). Integration tests target a real Azure SQL dev DB via AzureCliCredential and self-skip when unavailable.

---

## Connections & auth

### BASED-CONN-STORE: Connection metadata persistence
**Applies to:** based (core)
**Test category:** integration

Connections (name, server, initial database, auth type, options) shall persist in the local SQLite store across restarts. Secrets are never written to this store. LanceDB connections additionally persist `defaultEmbeddingProfileId` / `defaultRerankerProfileId` (BASED-LANCE-CONN-DEFAULT-PROFILES); both are optional, so configs saved before they existed load unchanged.

**Acceptance criteria:**
- Create → list returns the connection with identical fields; reopening the store still returns it
- Update changes fields in place (same id); delete removes the row
- The stored record contains no password/client-secret material
- The two search-profile ids round-trip, can be cleared back to `null`, and read as absent on a config saved without them

### BASED-SECRET-STORE: Secrets in Windows Credential Manager
**Applies to:** based (core)
**Test category:** integration

SQL-login passwords and service-principal client secrets shall be stored in Windows Credential Manager keyed by connection id, retrievable by the core process, and deleted when the connection is deleted.

Secrets shall be stored as UTF-8 **bytes**, not as a keyring "password". Credential Manager caps a credential blob at 2560 bytes, and the password API encodes to UTF-16 first, halving the usable room to ~1280 characters — below a 2048-bit PKCS#8 PEM (1704 characters), which made key-pair auth impossible to save. A secret exceeding the cap shall be refused with a message naming the limit, not with the driver's own error. Blobs written by the earlier password path shall still read back, and shall be upgraded in place on their next write; nothing is rewritten in bulk.

**Acceptance criteria:**
- `setSecret(id, s)` → `getSecret(id)` returns `s`
- `deleteSecret(id)` → `getSecret(id)` returns null
- Deleting a connection through the connections API removes its secret
- A 1704-character (2048-bit PEM sized) secret round-trips; multi-byte characters survive and are charged by byte
- A secret over the cap throws a message naming the limit, and stores nothing
- A credential written by the legacy password path still reads back, and reads back correctly after being rewritten

**Implementation note (packaging, no spec impact):** `@napi-rs/keyring`'s loader reassigns `require = createRequire(__filename)` so it resolves its native `.node` binding relative to its own package when run unbundled (validated directly under Bun). Bun's bundler inlines `__filename` as the store path and lets that reassignment clobber the bundle-global `require` (`import.meta.require`), so the platform binary — which the bundler copies next to the output `index.js` — is resolved against the wrong directory and fails to load as a misleading "Cannot find native binding". Fixed in [shell-tauri/bundle-core.ts](../../shell-tauri/bundle-core.ts) with a `Bun.build` `onLoad` plugin that strips the reassignment for the packaged core bundle only (core's direct-Bun path and these tests are unaffected). Upstream this is a Bun bundler bug with napi-rs loaders that reassign `require`; the plugin is a rebuild-surviving workaround. If keyring loading breaks again after a Bun upgrade, re-check that plugin.

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

### BASED-ENGINE-REGISTRY: One descriptor per engine; no call site branches on engine identity
**Applies to:** based (core)
**Test category:** unit

Every engine-varying behaviour shall resolve through a registry of engine descriptors (`core/src/engines/`), keyed by `DbEngine` and typed `Record<DbEngine, EngineDescriptor>` so that registering a new engine id without a descriptor is a compile error. A descriptor supplies: the wire-serialisable `profile` (BASED-ENGINE-PROFILE-WIRE), a `SqlDialect`, a lazy `loadAdapter` (BASED-LAZY-ENGINES), an optional lazy `loadLsp`, a `persona`, a `briefing(caps)`, an `agentProse` bundle, optional engine-only `tools`, optional `skillTags`, and optional `lspKeywords`.

No consumer shall select behaviour by comparing an engine id. In particular the agent surface, the LSP backend, the adapter factory, the persona resolver, and the generated tool prose all read the descriptor. The prohibited shape is a two-armed conditional whose `else` names a specific engine (`engine === "mssql" ? … : <LanceDB>`), because it is not a compile error for a third engine and silently mis-routes it.

**Acceptance criteria:**
- Every id in `ENGINE_IDS` has a descriptor whose `profile.id` and `defaultCapabilities.engine` equal that id
- Every descriptor supplies a non-empty persona, briefing, and dialect name, and `agentProse.namespaceDefault === profile.namespace.default`
- Every `FieldSpec.visibleWhen` targets a field the engine declares (or `authType`), and every auth value it gates on exists in `profile.authModes`
- An engine whose `defaultCapabilities.indexIntrospect` is true also supplies `agentProse.indexes`
- For every engine, the assembled surface omits exactly the tools whose capability is absent (`run_query`↔`sql`, `count_rows`↔`countRows`, `take_rows`↔`takeByKey`, `get_indexes`↔`indexIntrospect`, `vector_search`↔`search`)
- A stored instruction set with no persona for an engine resolves to that engine's own built-in persona, never another engine's

### BASED-ENGINE-PROFILE-WIRE: The UI renders engines from served profiles, not a mirrored list
**Applies to:** based (core, ui)
**Test category:** integration

`GET /api/engines` shall return each engine's `EngineProfile`: id, label, `fields` (a `FieldSpec[]` describing the connection form), `authModes`, `namespace` (key, default, object nouns, tree grouping), `subtitleField`, identifier `quote` characters, and `defaultCapabilities`. The webview shall enumerate no engines of its own: the connection dialog renders from `fields` by `kind` alone, and `DbEngine`/`AuthType`/`ConnectionVariant` are opaque strings in `ui/src/api/types.ts`.

Field kinds are a closed set: `text`, `password`, `select`, `checkbox`, `directory`, `file`, `embedding-profile`, `reranker-profile`. Required-field validation, conditional visibility (`visibleWhen`), defaults, help text and per-auth-mode notes all come from the profile.

**Acceptance criteria:**
- `engineProfiles()` round-trips through `JSON.stringify`/`parse` unchanged (no functions or class instances leak into the wire half)
- Every profile's `subtitleField` names a field the engine declares
- Every profile's `quote.open`/`close`/`escape` are non-empty, and `dialect.escapeIdent("x")` equals `open + "x" + close`
- Adding an engine requires no change under `ui/src`

### BASED-CONN-SETTINGS-BAG: Engine-specific connection fields live in one bag, migrated lazily
**Applies to:** based (core)
**Test category:** unit

`ConnectionConfig` shall keep only cross-engine fields at the top level (`id`, `name`, `database`, `authType`, `engine`, `defaultEmbeddingProfileId`, `defaultRerankerProfileId`, `createdAt`, `updatedAt`) and carry every engine-specific field in `settings: Record<string, unknown>`, addressed by the key its `FieldSpec` declares.

Migration shall be lazy: `ConnectionStore.list()`/`get()` lift a legacy row's top-level fields into `settings` on read, and `save()` writes the new shape. No bulk rewrite is performed. `settingStr`/`settingBool` shall additionally fall back to a legacy top-level field of the same name, so a config that never passed through the store still resolves.

**Acceptance criteria:**
- A row written in the legacy flat shape reads back with `server`/`encrypt`/… under `settings` and absent from the top level, and with `database`/`authType`/`engine` unchanged
- `migrateConnection` is idempotent, and an explicit `settings` value wins over a stale top-level sibling
- A row with no engine-specific fields migrates to `settings: {}`, never `undefined`
- `settingStr` returns `undefined` for a blank string and for a non-string value; `settingBool` returns the caller's declared default when the key is absent

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

Tabs of every kind — query (content, optional file path), table/view (schema, table, object type, current sub-view), routine (schema, name, routine type), diagram (schema scope), and docs (no metadata) — shall persist automatically, scoped by connection id and kind-specific metadata, so a restart restores each connection's full tab set. Persistence is a per-connection **replace**: saving a connection's tabs mirrors the currently-open set, pruning any previously-persisted tab (of any kind) that is no longer open, so restore never accumulates tabs beyond what was open at exit. The store treats `kind` and `meta` as opaque pass-through values; only the UI interprets them.

**Acceptance criteria:**
- Upsert one tab of each kind (query, table, routine, diagram, docs) for a connection, each with its kind-specific `meta` → list for that connection returns all five in order with `kind` and `meta` intact after store reopen
- Delete removes a tab; tabs are scoped per connection id
- `replaceForConnection(connId, subset)` prunes persisted tabs absent from `subset` (of any kind) and keeps those present, in order; an empty array clears the connection; other connections are untouched; result survives store reopen

### BASED-WINDOW-RESTORE: Per-window session restore
**Applies to:** based (core, ui, shell)
**Test category:** manual

On launch, the app shall reopen one native window per window that was still open when it last exited (cleanly or via kill), each reconnecting to its last connection and restoring its active tab and schema filter. A window that was closed cleanly before the app exited shall not be reopened. Each window's state (connection id, active tab id, schema filter) is keyed by the same per-window session id (`sid`) the backend already uses to give each window an independent DB session — the shell reuses a window's prior `sid` across restarts instead of minting a fresh one, so window state and DB session share one durable key.

**Acceptance criteria (`WindowStateStore`, integration-tested):**
- Save connection/active-tab/schema-filter/capi-thread (BASED-CHAT-HISTORY-PICKER) for a sid → get returns it; `list()` returns all rows; survives store reopen
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

App-wide user preferences (the active theme id; `fontScale`, the app-wide text-size multiplier, see BASED-UI-FONT-ZOOM; and `rowPageSize` — the Table Data view's rows-per-page *and* the tab bar's ad-hoc query fetch-size cap, see BASED-UI-EXEC-PLAN) shall persist server-side in a single-row `app_settings` table so they survive restart. `GET /api/settings` returns the stored settings merged over defaults (`theme: "ledger"`, `rowPageSize: 500` out of the box); `POST /api/settings` accepts a partial patch, merges it over the current value, persists it, and returns the full settings.

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
- Switching to a theme whose mono font this window has never rendered (so the webfont downloads only on the swap) leaves the editor caret exactly at the end of typed text, not a fraction of a character to its left — see BASED-EDITOR-CARET-METRICS

### BASED-UI-FONT-ZOOM: App-wide text zoom from the wheel and the keyboard
**Applies to:** based (ui)
**Test category:** manual

The app-wide font size is one setting (`fontScale`, persisted per BASED-SETTINGS) applied by writing
`--font-scale` onto `<html>`; every `--fs-*` size and the Monaco editor's `fontSize` derive from it.
Three inputs shall drive that one setting, all clamped to 85%–200% in 5% steps: the Font size slider
in the settings popover's General tab, `Ctrl`+wheel anywhere in the window, and `Ctrl+=` / `Ctrl+-`
(with `Ctrl+0` resetting to 100%).

`Ctrl`+wheel is handled on `window` in the capture phase with `passive: false`. Both matter: capture
puts the app ahead of Monaco, the Glide grids and every scroll container, so the gesture zooms rather
than scrolling whatever sits under the cursor; `passive: false` makes `preventDefault()` effective,
without which the host webview also runs its own page zoom and the two compound. Wheel distance is
accumulated (~100px per step) rather than stepped per event, so a trackpad's stream of small deltas
moves the scale at the same rate as a mouse's discrete notches.

A view that owns the wheel itself opts out by carrying `data-wheel-zoom="own"`. The embeddings atlas
canvas (BASED-EMBED-UI) is the one such view: deck.gl zooms the plot on wheel, and a trackpad
pinch reaches the page as Ctrl+wheel, so without the opt-out pinching the plot would resize the app
instead of zooming the plot.

The server write is debounced (~400ms trailing) — a wheel gesture or a slider drag is dozens of
events, and each one would otherwise be its own `POST /api/settings`. The visual change is immediate
regardless; only persistence trails.

**Verification procedure:**
1. `Ctrl`+scroll up over the object explorer, the Monaco editor, and a result grid in turn → text
   grows everywhere on each gesture; nothing under the cursor scrolls
2. Open Settings → General while zooming → the percentage readout tracks live and lands on whole 5%
   values (95%, 100%, 105%…), never 115.00000000000001%
3. `Ctrl`+scroll past either end → stops at 85% / 200%
4. In the packaged Tauri shell: only text size changes — the window chrome and layout do not scale,
   which is the tell that the webview's native zoom is not also firing
5. Release `Ctrl` and scroll → normal scrolling everywhere
6. `Ctrl+=` / `Ctrl+-` step the same 5%; `Ctrl+0` returns to 100%
7. On the Embeddings sub-view, a trackpad pinch (or `Ctrl`+wheel) over the plot zooms the *plot* and
   leaves the app's text size alone — the `data-wheel-zoom="own"` opt-out
8. Zoom, restart the app → the size is still in effect, painted correctly on first frame (no flash
   of the previous size)

### BASED-EDITOR-CARET-METRICS: The caret stays glued to the text when a webfont arrives late
**Applies to:** based (ui)
**Test category:** unit

Monaco caches one character width per font and paints the caret at `column × charWidth`. It takes that measurement synchronously — at editor creation, and again whenever `fontFamily` changes — so a mono webfont that is still downloading is measured as its *fallback*, and Monaco never corrects itself once the real font swaps in. The caret then drifts a fraction of a character per column: typed letters appear to land *after* the caret, and `End`/`Home` do not help, because the model position was always right — only the painting is wrong. Themes carry their own mono font (BASED-THEME), so every theme swap to a not-yet-rendered font re-opens this window.

The UI shall force `monaco.editor.remeasureFonts()` at every moment those metrics can go stale, via `ui/src/fontMetrics.ts`:

1. **Explicitly**, wherever an editor is pointed at a font stack — creation, theme swap, font-size change. The exact font is awaited through `FontFaceSet.load()` first, then one remeasure is issued. Idempotent per (family, size), so re-renders cost nothing.
2. **Defensively**, whenever *any* font finishes loading on the page (`FontFaceSet` `loadingdone`), coalesced to one remeasure per flush. This is the safety net: it holds even if a future call site forgets step 1, and it covers fonts pulled in by something other than the editor.

A stack with no downloadable family (`ui-monospace, monospace`) needs neither — the fallback Monaco measured is the final font.

**Acceptance criteria:**
- `primaryFamily("'Fragment Mono', ui-monospace, monospace")` → `"Fragment Mono"`; `primaryFamily("ui-monospace, monospace")` → `null`
- `fontSpec(stack, 13)` → `13px "Fragment Mono"`; a generic-only stack → `null`
- `ensure(stack, px)` requests exactly that font, then remeasures once; a second `ensure` with the same family+size remeasures no further; a different family, or the same family at a new size, remeasures again
- A generic-only stack issues no load and no remeasure; a *failed* load still remeasures once rather than throwing
- A burst of `loadingdone` events coalesces into one remeasure; the next burst measures again
- `dispose()` unsubscribes, and a remeasure already in flight is dropped
- Regression check (the shape that keeps recurring): with a `select` typed in the editor, the caret's x-offset from the start of the line stays within ~1px of the rendered text's width, both at boot and after switching to a theme whose mono font was never rendered before. Measured pre-fix at −9.7px of drift over 6 characters (Monaco 10.83px/char vs the real 12.45px/char) on the Cathode theme.

### BASED-EDITOR-VIM: Vim keymap for the query editor
**Applies to:** based (ui, core)
**Test category:** manual (the `editorKeymap` persistence half rides the BASED-SETTINGS integration test)

Settings → General shall offer an **Editor keymap** choice of `default` or `vim`, persisted through `POST /api/settings` like any other app setting and defaulting to `default`. With `vim`, the query editor gains modal editing (motions, operators, registers, search, `.` repeat) and a block caret in normal mode; the implementation loads on demand, so the keymap costs nothing when it is off.

The mode indicator and the `:` / `/` command line shall render in the app's existing bottom status bar — not in a second bar of the editor's own — and inherit the active theme. The mode reads as a word ("Normal", "Insert", "Visual line") rather than vim's shouted `--INSERT--`, per the project's no-uppercase-labels rule.

`:w` writes the tab through the app's own save path, `:q` closes the tab, and `:wq` does both. The app's existing shortcuts (F5, Ctrl+Enter, Ctrl+S, Ctrl+Shift+S, Ctrl+O) keep working in every vim mode. `Ctrl+W` stays bound to the app's close-tab, shadowing vim's window prefix — harmless with a single editor.

**Acceptance criteria:**
- Editor keymap = Vim → the editor starts in normal mode with a block caret; `hjkl`, `dd`, `ciw`, `/pattern` + `n`, `V`+`y`+`p`, `u`, and `.` all behave as in vim
- The mode word appears in the bottom status bar (not a second bar); typing `:` opens a command input inline in that bar that is legible on both a dark and a light theme
- `:w` clears the tab's dirty marker; `:q` closes the tab; `:q!` closes it without saving
- F5 / Ctrl+Enter run the query and Ctrl+S saves, from both normal and insert mode
- Switching query tabs keeps vim attached with no doubled keystrokes; switching back to Default leaves no stale mode text in the status bar and preserves the buffer and undo history
- The choice survives an app restart (loaded from `/api/settings`)

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

### BASED-SAVE-FILE-WRITER: Document file writer
**Applies to:** based (core)
**Test category:** unit

`core/src/files/saveFile.ts` writes a *document* (as opposed to `exportData`'s *data*) to a target
directory. `sanitizeSaveFileName(name, defaultExt?)` accepts only a bare file name whose extension
is on `SAVE_FILE_EXTENSIONS` — `html, htm, md, markdown, txt, sql, json, csv, tsv, xml, yaml, yml,
svg, log`. This is a whitelist, not a blacklist: the caller is the model, so the guard has to be
"only these document types" rather than "not these bad ones". `defaultExt` fills a missing
extension but never replaces a present valid one. `resolveDownloadDir(override?)` resolves to the
user's Downloads folder, falling back to the temp dir. `writeTextFileUnique(dir, name, content)`
never overwrites — an existing name gets `-2`, `-3`, … — and returns the path actually written plus
its UTF-8 byte length. (`exportData` may overwrite because its default names are timestamped; a
model-chosen `report.html` is a plausible collision with a file the user already had.)

**Acceptance criteria:**
- `a/b.txt`, `a\b.txt`, `../b.txt`, `..secret.txt`, `"   "`, `""` → throws
- `evil.exe`, `run.ps1`, `go.bat`, `x.js`, `x.vbs`, `s.lnk`, `k.reg`, `noextension`, `archive.tar.gz` → throws
- `report.html` → `report.html`; `  Notes.MD  ` → `Notes.MD` (case preserved)
- `("notes", "md")` → `notes.md`; `("notes.txt", "md")` → `notes.txt`; `("notes.exe", "md")` → throws
- Writing `report.html` three times into one directory yields `report.html`, `report-2.html`, `report-3.html`, each with its own content
- `bytes` is the UTF-8 byte length, not the character count (`"café — ok"`)

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
server-computed CREATE script (exactly how views already show their definition), with a copy icon
button beside its label that writes the full CREATE statement to the clipboard and flashes a ✓
confirmation. A **Script ▾**
dropdown sits next to the Details/Data/SQL sub-tab buttons (tables/views) and in the routine tab
header (procedures/functions), offering the SSMS-parity action set per object type (no ALTER for
tables; SELECT for tables/views; INSERT for tables only); each action opens the generated script
in a new query tab (not run) via `POST /api/session/script`.

**Verification procedure:**
1. Open a table with an FK, an index, a default and a check constraint → Details shows all four
   sections with correct metadata, plus its CREATE DDL block
2. A plain table shows only its columns table + DDL (no empty sections)
3. Click the copy icon next to the DDL label → it flashes ✓ for ~1.5s and pasting elsewhere yields
   the full CREATE statement verbatim
4. Script ▾ → "Script as create" opens `Script: schema.table` as a new query tab containing
   runnable CREATE DDL; "drop and create" contains DROP + GO + CREATE
5. A view's Script menu offers alter (rewritten from its definition); a procedure tab's header
   Script menu works the same
6. On a LanceDB connection no Script dropdown appears and Details renders exactly as before

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

Provider config (kind ∈ {openai-compatible, openai, azure-openai, anthropic}, base URL, default model, optional deployment) persists in the local store; the API key lives in Windows Credential Manager, never the store. A resolver turns the active config into an AI SDK `LanguageModel`. There is no built-in default — a fresh install has no configured provider until the user adds one.

**Acceptance criteria:**
- Save config → read back identical fields; the stored record contains no key material
- No config saved yet → the store's read returns `null`, not a hardcoded default
- `setAiKey`/`getAiKey`/`deleteAiKey` round-trip through Credential Manager
- The `openai-compatible` resolver returns a model for a reachable base URL

**Implementation note (no spec impact):** the `openai` / `azure-openai` / `anthropic` branches are wired natively — see BASED-AI-PROVIDER-WIRED. A single `zod@3.25.76` override reconciles the AI SDK's `zod/v4` subpath imports.

### BASED-AGENT-RUNQUERY: Read-only `run_query` tool with row cap
**Applies to:** based (core)
**Test category:** unit

The agent `run_query` tool executes only read-only statements. A pure classifier (`isReadOnly`) decides read-only vs. mutating; non-read statements are refused without touching the DB. Forwarded rows are capped (agent default 1,000) and marked truncated past the cap; the model sees at most `TOOL_PREVIEW_ROWS` (50) of them, size-bounded by BASED-AGENT-TOOL-PAYLOAD-CAP under one budget shared by every result set in the call.

**Acceptance criteria:**
- `SELECT`/leading-CTE → read-only; `INSERT`/`UPDATE`/`DELETE`/`DROP`/`TRUNCATE`/`EXEC`/`MERGE`/`SELECT…INTO` → not (case/whitespace/comment/string-literal insensitive)
- `run_query` on a mutating statement returns `{ refused: true }` and never calls the adapter

### BASED-AGENT-SCHEMA-CTX: Schema-only context tools
**Applies to:** based (core)
**Test category:** integration

`list_objects()` returns every object (namespace-qualified) and `describe_table({ table, … })`
returns one table's columns — the same introspection the explorer uses — and neither ever returns row
data. These replace the former single `get_schema` tool, whose two responsibilities (enumerate vs
describe) shared one name and one argument list; `describe_table` also absorbed `script_object`
(BASED-SCRIPT-OBJECT), so a table's columns, its DDL, and its pyarrow snippet are `format` values of
one tool rather than the same information under two names.

**Acceptance criteria:**
- `list_objects()` returns a non-empty object list, each with schema/name/type
- `describe_table({ table })` returns that table's columns and no rows
- `describe_table` on a table/namespace that doesn't resolve returns `{ error, validNames }` — never
  an empty column list presented as a real answer (SQL catalogs report a wrong schema as zero rows,
  so the tool confirms existence via `listObjects()` before trusting an empty result)

### BASED-AGENT-SAMPLE: quick row peek — SUPERSEDED by BASED-AGENT-READ-ROWS
**Applies to:** based (core)
**Test category:** integration

`sample_rows` no longer exists as a separate tool. An unordered peek is `read_table` with a small
`limit` and no filter, so the two were merged: keeping both meant two tools that returned rows while
each described itself as "the only tool that returns raw rows", and the agent acted on whichever
description it had read most recently. Superseded by BASED-AGENT-READ-ROWS.

### BASED-AGENT-READ-ROWS: `read_table` paging tool
**Applies to:** based (core)
**Test category:** unit

One tool for "give me rows", under one name on every engine: `read_table({ table, <namespace>?,
offset?, limit?, columns? })` pages through a table via the adapter's `readTablePage`, so the agent
never pulls a whole table at once. `limit` clamps to 1–200 (default 100); the result carries
`{ columns, rows, orderBy, offset, returned, hasMore }` where `hasMore` is the
`returned === limit` heuristic (`TablePage` has no total; call `count_rows` when the scale
matters). It absorbed the former `sample_rows` — a peek is a small page with no filter.

Its filtering parameters are generated from the connection's capabilities and a parameter the engine
cannot honour is **absent**, not accepted-then-refused (BASED-AGENT-SURFACE-VARIANT): engines with
`structuredFilters` (SQL Server) expose `orderBy: [{column, dir}]` and
`filters: [{column, op, value?}]`, passed to `readTablePage`'s validated, parameterized path
(BASED-TABLE-ORDERBY); engines with `wherePredicate` (LanceDB) expose a free-text `where`
predicate instead (BASED-LANCE-SCAN). Every call is audited as a read, with the predicate in the
audit line.

**Acceptance criteria:**
- `limit: 500` clamps to 200; omitted limit reads 100; `offset` forwards verbatim
- A full page reports `hasMore: true`; a short page reports `hasMore: false`
- A small `limit` with no filter reproduces the old `sample_rows` peek
- The namespace defaults to `dbo` on mssql and `""` on lancedb
- `orderBy`/`filters` forward to the adapter on a `structuredFilters` engine, and are **not present
  in the tool's schema at all** on an engine without it
- `where` forwards to the adapter on a `wherePredicate` engine and appears in the audit line
- `columns` projects the returned page
- Every engine surface contains `read_table`; each call writes an audit row
- The page is size-bounded before it reaches the model (BASED-AGENT-TOOL-PAYLOAD-CAP); `hasMore`
  still reflects the adapter's page, so rows dropped to fit the budget are never mistaken for the
  end of the table

### BASED-AGENT-TOOL-PAYLOAD-CAP: Row payloads are bounded by size, not only by row count
**Applies to:** based (core)
**Test category:** unit

Every tool that returns rows to the model bounds the **size** of what it returns, not only the
number of rows. A row cap alone is not a bound: 50 rows of a column holding 21,000-character
conversation logs is roughly a quarter of a million tokens from one tool call, enough to overrun a
262K-token window outright — and, because the result is persisted to the thread, to keep overrunning
it on every later turn (BASED-AGENT-CONTEXT-RECOVERY).

Two limits, applied in `boundRows` (`core/src/agent/toolPayload.ts`) by `run_query`, `read_table`,
`take_rows`, and the LanceDB search tools:

- **`TOOL_CELL_CAP` (300 characters per cell)** — a longer string value is cut and marked with `…`.
  Matches the cap the UI half has always applied to the frontend tools (`ui/src/agent/tabContext.ts`).
- **`TOOL_PAYLOAD_CAP` (100,000 characters per tool call)** — rows stop being added once the budget
  is spent. One budget covers a whole call, so a `run_query` returning several result sets cannot
  spend the cap once per set. The first row of a set always goes through even if it alone exceeds
  the budget: a set with no rows tells the model nothing about the shape of what it asked for, and
  the row is cell-capped anyway.

Vector and binary cells need no handling here — the adapters already summarize them on the wire as
`{$:"vec"}` / `{$:"bin"}` (BASED-LANCE-WIRE).

Truncation is always **declared**. A result that was cut carries `truncated: true` and a `note`
naming what was cut (cells, rows, or both) and what to do instead (fewer/narrower columns, or
`export_data` for the full values). A silently clipped value is worse than a missing one: the model
quotes it back as the complete value.

**Acceptance criteria:**
- A 21,000-character cell returns at 301 characters, ending in `…`, with `cellsTruncated: 1`
- A value exactly at `TOOL_CELL_CAP` is untouched; one character longer is cut
- Narrow rows pass through byte-for-byte with `truncated: false` and no `note`
- `{$:"vec"}` / `{$:"bin"}` cells pass through unchanged
- With the budget exhausted, later rows are dropped and counted in `droppedForSize`
- A budget shared across two result sets is spent once, not once per set
- A single row larger than the whole budget is still returned
- The `note` names cell truncation and row dropping independently, and only when each occurred

### BASED-SCRIPT-OBJECT: Agent `describe_table` tool
**Applies to:** based (core)
**Test category:** unit + integration

`describe_table({ table, <namespace>?, format? })` returns schema and DDL/description text — never
executes it (execution stays on the BASED-AGENT-MUTATION-GATE approval path). It replaces the former
`script_object`, whose name was SSMS heritage that said nothing about what it returned and which,
on LanceDB, duplicated `get_schema({table})` in a second format. One tool, engine-shaped `format`:

- `"columns"` (default, every engine) — the column list with types, nullability, key/FK metadata,
  and for vector columns the dimension, element type, and index metric.
- mssql (`capabilities.script`) — `"ddl"` resolves the object's type via `listObjects()` and routes
  through the existing scripter (BASED-SCRIPT-TSQL): tables via `getTableDetails` +
  `scriptObject({kind:"table"})`, views/procedures/functions via `getObjectDefinition` +
  `scriptObject({kind:"module"})`. `"drop"`, `"drop-create"`, `"alter"`, `"select"` and
  `"insert"` map onto the scripter's remaining actions, with its invalid-combo errors surfaced as
  tool errors, not throws.
- lancedb — `"pyarrow"` returns a readable schema description (`describeLanceSchema`, a pure
  function) plus a `pa.schema` snippet, Lance tooling being Python-first.

Unknown objects return `{ error, validNames }`, mirroring `load_skill`. Calls are audited as reads.

**Acceptance criteria:**
- The `format` enum offers `ddl` (and the other scripter actions) only on mssql and `pyarrow` only
  on lancedb; `columns` is available on both
- mssql: `format: "ddl"` round-trips a table to a `CREATE TABLE` containing its PK; a view returns
  its `CREATE VIEW` text; `format: "alter"` on a table returns an error object (no throw)
- lancedb: `format: "columns"` names every column and flags the vector one; `format: "pyarrow"`
  renders it as `vector[dim]` and includes a `pa.schema` snippet
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

### BASED-AGENT-SAVE-FILE: Agent `save_file` tool
**Applies to:** based (core)
**Test category:** unit + integration

A `save_file({ content, fileName, openAfter? })` tool writes a document the agent authored — a
standalone HTML report, a `.sql` script, a markdown write-up, plain notes — to a real file and
returns `{ path, bytes, fileName }`, so a long document is delivered as a file instead of a wall of
text the user has to hand-select out of the chat rail. It is present on **every** engine and
variant, capability-free: it touches the filesystem, not the database.

Name and extension go through `sanitizeSaveFileName` (BASED-SAVE-FILE-WRITER) and the write through
`writeTextFileUnique`, so an unlisted or executable extension is refused and an existing file is
never overwritten. `content` over `MAX_SAVE_FILE_BYTES` (5 MB) or empty is refused. The file lands
in the user's Downloads folder (fallback: temp dir; `ToolDeps.exportDir` overrides it for tests) —
no dialog can pop mid-run, same as BASED-AGENT-EXPORT. `openAfter` shell-opens the result. Failures
return `{ error }`; every call audits as a read. The tool is named in the generated capability
briefing for both engines.

**Acceptance criteria:**
- Writing `<!doctype html>…` as `orders.html` puts the exact bytes at `<dir>/orders.html` and returns that path with the UTF-8 byte count
- Saving `notes.md` twice yields `notes.md` and `notes-2.md`; the first file's content is unchanged
- `../escape.txt`, `sub/dir.txt`, `..\up.txt` → `{ error }` and the directory stays empty
- `setup.ps1` → `{ error }` containing "Unsupported file type"; nothing written
- Content over `MAX_SAVE_FILE_BYTES`, and empty content → `{ error }`; nothing written
- `save_file` is in the tool surface of all four connection variants

### BASED-AGENT-TRANSCRIPT: Agent `save_chat_transcript` tool + markdown formatter
**Applies to:** based (core)
**Test category:** unit + integration

`transcriptMarkdown(messages, { title?, generatedAt? })` renders AG-UI messages as a markdown
document: an `# ` title (default `based — chat transcript`), a generated-at line, then `## You` /
`## Capi` sections in conversation order. Assistant prose passes through verbatim so fenced code and
` ```mermaid ` blocks survive. **Prose only** — `role: "tool"` and `role: "system"` messages and
tool-call payloads are not rendered; a transcript is what the conversation *said*, and the mechanics
are already in the audit log. Consecutive same-role turns merge under one heading, and a turn with
no text (an assistant turn that is only tool calls) produces no heading.

It lives in core, not the UI, because two paths produce a transcript and must produce the *same*
document: this tool, and the chat rail's download button (BASED-CHAT-TRANSCRIPT-UI).

`save_chat_transcript({ fileName?, title?, openAfter? })` writes that markdown to the Downloads
folder and returns `{ path, bytes, messageCount, note }`. The messages come from agent memory via
`ToolDeps.recallThread(threadId, connectionId)` — the same reader the history-restore route uses —
never from the model: re-emitting a whole thread through tool-call arguments would cost as many
tokens as the thread and would paraphrase rather than reproduce it. `fileName` defaults to
`based-chat-<yyyymmddhhmmss>.md` and a bare name gets `.md` appended.

Like `delegate` (BASED-AGENT-DELEGATE), its presence tracks the **run**, not the connection: it is
built only when `recallThread` is on the deps, and a subagent's deps carry none — so the tool is
absent from a child's surface rather than present-and-refusing. Mastra flushes a turn to `agent.db`
after the run, so the file covers the conversation through the user's current message but not the
reply being composed; the returned `note` says so, and the UI button has no such gap.

**Acceptance criteria:**
- Three turns render as `## You` / `## Capi` / `## You` with the header and generated-at line above them
- A fenced `sql`/`mermaid` block in an assistant message appears byte-identical in the output
- A thread containing system + tool messages yields exactly `["## You", "## Capi"]` headings and none of their content
- An assistant message carrying only `toolCalls` adds no heading; two consecutive assistant messages share one
- `[]` → header and generated-at line only; `title` replaces the default heading
- The tool is absent on all four variants by default and present on all four once `recallThread` is injected
- Recall is called with the run's `threadId` and the connection id; the written file starts `# <title>` and contains both turns
- No `fileName` → a path matching `based-chat-<14 digits>.md`; `orders-chat` → `orders-chat.md`
- A throwing `recallThread` → `{ error }` with its message; nothing written

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

The agent has no server tool that executes DML/DDL. Mutations run only through
`POST /api/agent/mutation`, which requires `approved: true` **and** `capabilities.write`, and
audits the SQL before executing. The frontend reaches it only after the user approves the
`run_mutation` card, and only offers that card on a connection that can accept writes
(BASED-AGENT-SURFACE-VARIANT).

The capability check is server-side because "read-only" was previously enforced only by the frontend
not offering the tool — which it did offer, unconditionally. Every sibling write path (CSV import,
grid commit) already checked `capabilities.write`; this one did not, so on a **local** LanceDB
connection an approved mutation reached the DuckDB/Lance bridge. Consent is not capability: the user
approving a statement does not make the connection able to run it.

**Acceptance criteria:**
- Mutation-exec with `approved` absent/false → 400, nothing runs, no audit row
- With `approved: true` → runs and writes an audit row with `approved`
- With `approved: true` on a connection whose `capabilities.write` is false → 400 with a
  read-only message, nothing runs
- `run_query` (the only agent-callable exec tool) rejects mutations, so the model cannot self-execute DML
- `run_mutation` and `import_csv` are absent from the frontend tool map on a non-writable connection

**Design constraint for the LanceDB write surface:** `run_mutation` takes a
SQL string, and Lance's write operations — `merge_insert`, `add_columns` with expressions,
`alter_columns`, predicate `delete` — are SDK API calls, not DDL. They cannot be expressed through
this tool and need their own proposal tools with their own approval cards. `run_mutation`'s
generality is real only where SQL is the write interface. First realization: `create_table`
(BASED-AGENT-LANCE-CREATE).

**Security posture (no spec impact):** `approved` is a UX gate suited to a personal tool; the real
enforcement is the capability check plus the fact that DML has no agent-reachable exec tool.

### BASED-AGENT-AUDIT: Audit log of agent SQL
**Applies to:** based (core)
**Test category:** integration

Every SQL the agent causes to run (reads via `run_query`/`read_table`/`count_rows`/`take_rows`, approved mutations) appends an audit row (connection, database, kind read|mutation, sql, approved, started-at, status, error), retrievable most-recent-first. Row data is never recorded.

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

The agent is built with a default step budget of 30 (`defaultOptions.maxSteps`) so multi-step tool runs (e.g. schema audits) are not cut off by Mastra's implicit 5-step default, which ends a run immediately after tool results with no final assistant text. (The AG-UI bridge passes no `maxSteps`/`stopWhen` of its own, so the agent-config default is what governs the loop.) The budget is profile-overridable (`BASED-AI-PROFILE-STEPCAP`). A run that genuinely exhausts it still ends tool-calls-last without a summary at the protocol level; the chat UI turns that ending into a "keep going?" prompt (`BASED-AGENT-CONTINUE-PROMPT`).

**Acceptance criteria:**
- `buildAgent(...)` yields an agent whose resolved default options have `maxSteps` of 30 (assert via `agent.getDefaultOptions(...)`)
- Manual: "audit my tables" against the dev DB streams tool calls and ends with a final assistant text message before `RUN_FINISHED`

### BASED-AGENT-CONTEXT-RECOVERY: A context-window overflow does not end the conversation
**Applies to:** based (core)
**Test category:** integration

When the provider rejects a request because it does not fit the model's context window, the run
sheds the payload it choked on and retries instead of failing. Without this, an overflow is
terminal in the worst way: the oversized tool result is already written to the tab's thread, so it
replays on every following turn and even a one-row follow-up query fails identically. The
conversation is unusable until it is thrown away.

`contextRecoveryProcessor` (`core/src/agent/contextRecovery.ts`) is registered as an
`errorProcessor` on every agent `buildAgent` produces, parent and subagent alike:

1. **Recognize.** `isContextOverflowError` matches how each backend phrases it — LM Studio /
   llama.cpp `exceed_context_size_error`, OpenAI `context_length_exceeded` / "maximum context
   length", Anthropic "prompt is too long" — across an error's `message`, `responseBody`, `data`,
   and `cause`. Anything else is passed straight through: a real failure (bad SQL, dead connection,
   revoked key) must never become a retry loop.
2. **Shed.** The single largest tool result in the message list is replaced with a stub saying it
   was dropped and what to do instead. It is rewritten through `MessageList.updateToolInvocation`,
   which re-persists the message — so the stored thread is healed, not just the current attempt.
   Removing the message instead would orphan its tool call and get the retry rejected on other
   grounds. A result under 1,000 characters is not worth shedding; with nothing to shed, no retry.
3. **Bound.** At most `CONTEXT_RECOVERY_MAX_ATTEMPTS` (3) sheds per run.

Two further bounds sit behind it: agent memory recalls at most `MEMORY_LAST_MESSAGES` (40) messages,
so an unbounded history cannot replay a bad payload forever; and an overflow that survives all of
the above reaches the client as a plain-language `RUN_ERROR` ("start a new chat, or switch to a
profile with a larger context") rather than raw provider JSON.

**Acceptance criteria:**
- Each provider's overflow phrasing is recognized, including when wrapped in a `cause`; a 401, an
  `ECONNREFUSED`, and an invalid-object-name error are not
- Shedding replaces the largest tool result only, leaves the others intact, and calls
  `updateToolInvocation` for the shed one
- A second shed takes the next-biggest result, never the stub written by the first
- With no result over 1,000 characters, the processor returns `retry: false`
- At `retryCount >= maxAttempts`, the processor returns `retry: false`
- End to end: a run whose model returns a tool call, then rejects the request with a real LM Studio
  overflow 400, completes — the retried request carries the stub and is smaller than the rejected one
- The same holds on `agent.stream()`, which is the path the AG-UI endpoint actually runs
- A non-overflow provider failure still fails, with exactly one model call

### BASED-AGENT-DELEGATE: Handing tasks to subagents
**Applies to:** based (core)
**Test category:** unit

The agent can hand self-contained investigation tasks to subagents with a `delegate` tool, taking a `goal` string and 1–4 `tasks` (`{ name, instructions }`), and getting back one bounded result per task. The point is context, not concurrency: a subagent spends its own context on `describe_table`/`read_table`/`run_query` and returns only a summary, so the schema dumps never enter the parent's thread. Independent tasks run concurrently up to `SUBAGENT_CONCURRENCY`, which equals `DELEGATE_MAX_TASKS` so a fan-out is never artificially serialized — how parallel a run is becomes the model's choice of task count rather than a second hidden limit. No provider kind is treated specially; a backend configured for less parallelism than it is sent simply queues the surplus.

Delegation is a property of the **run**, not the connection: the tool is registered iff `ToolDeps.runSubagent` is supplied, on every engine and variant. The deps handed to a subagent omit it, so a subagent has no `delegate` tool — recursion is prevented structurally, not by a runtime check. A subagent also gets no memory and no parent messages, and none of the frontend tools (`show_results`, `list_tabs`, `get_tab`, `open_query_tab`, `run_mutation`, `import_csv`), which are unreachable from the server. The capability briefing states this; the persona does not, since a forked persona would go stale.

**Acceptance criteria:**
- `agentSurfaceFor(caps, deps)` includes `delegate` when `deps.runSubagent` is set and omits it when not, for both mssql and LanceDB capabilities
- The briefing gains the delegation paragraph only when `deps.runSubagent` is set
- `delegate` rejects an empty `tasks` array and more than `DELEGATE_MAX_TASKS` (4) tasks at the schema level
- Calling `delegate` invokes the runner once with the `goal` and every task, and returns `{ results, totalMs }`
- A runner honouring `concurrency: 1` never has two tasks in flight at once; with `concurrency: 3` and three tasks, all three overlap
- The deps a subagent is built with have no `runSubagent`, so `sharedTools` yields no `delegate` for it

### BASED-AGENT-DELEGATE-REPORT: Subagent result contract
**Applies to:** based (core)
**Test category:** unit

A subagent reports through a `report_findings` tool — available only inside a delegated run, never on the parent's surface — carrying a prose `summary`, optional `artifacts` (`label` plus any of `sql`, `objects`, `sample`, `note`) and optional `confidence`. Reporting through a tool call rather than structured output is deliberate: structured-output mode is unreliable against local OpenAI-compatible backends and interacts badly with tool loops.

Artifacts are how a result stays actionable without moving data: a `sql` artifact is a query the subagent actually ran and validated, which the parent can pass to `show_results` so rows reach a grid without passing through anyone's context.

The runner applies the caps regardless of what the model sends — a schema is a request, not a guarantee. Each task's outcome is independent: one failing or timing out never fails its siblings.

**Acceptance criteria:**
- `report_findings` args become the result's `summary`/`artifacts`/`confidence`
- A run that never calls `report_findings` falls back to the final assistant text with `artifacts: []`, status `ok`
- `summary` is truncated to `SUBAGENT_SUMMARY_CAP` (4,000 chars) and each artifact's `sample` to `SUBAGENT_SAMPLE_ROWS` (5 rows), even when the model exceeds them
- A task whose run throws yields `status: "error"` with the message in `error`; a task that exceeds the timeout yields `status: "timeout"`; sibling tasks still return `status: "ok"`
- A task that reported and then failed still hands its summary up

### BASED-AGENT-DELEGATE-ISOLATION: A delegated run leaves no trace in the parent thread
**Applies to:** based (core)
**Test category:** integration

A subagent is built without memory, so nothing it does is written to the tab's thread and there is nothing to clean up. It receives only the goal and its own brief — no parent conversation history. Its SQL is still audited under the same connection, tagged with a leading `-- subagent: <name>` comment (`AuditEntry` has no tag column, and a SQL comment is valid and legible in the History panel). The fan-out itself records one structured `delegate(goal, N task(s))` audit line.

**Acceptance criteria:**
- Thread messages recalled via `GET /api/agent/threads/:id/messages` are unchanged in count across a delegated run
- Every audit row a subagent's tools produce begins `-- subagent: <task name>` and carries the parent's connection id
- One `delegate(…)` audit row is written per `delegate` call, status `error` only when every task failed

### BASED-AGENT-THREADS: Durable per-connection conversations, one active per window
**Applies to:** based (core, ui)
**Test category:** integration + unit

Chat threads persist via Mastra Memory (LibSQLStore, its own `agent.db`) as **durable
per-connection conversation records**: each conversation gets a client-minted `chat:{uuid}`
thread id (`newChatThreadId()`), and `resourceId` stays the connection id. Threads persisted
under this format are live, so the format is not safe to change. Legacy `tab:`/`conn:` threads
from the per-tab era remain in `agent.db` unreferenced (no migration).

**The window shows one active conversation per connection** via a pointer map
(`store.capiThreads`): switching tabs never changes the visible conversation; switching
connections switches to that connection's active thread and back losslessly. Every successful
connect ensures a pointer exists (minting a fresh id when there is none) and mirrors the current
connection's pointer into `window_state.capi_thread_id`, so a restored window (same sid,
BASED-WINDOW-RESTORE) reopens the same conversation and a connection switch never leaves the
persisted pointer aimed at another connection's thread. Tab awareness comes from the per-send
workspace snapshot and the tab tools, not from thread identity (BASED-AGENT-TAB-CONTEXT,
BASED-AGENT-TAB-TOOLS).

**Lifecycle:** "New chat" mints a fresh id and moves the pointer — nothing is deleted; the old
conversation becomes history (BASED-CHAT-HISTORY-PICKER). A thread only materializes server-side
on its first message, so abandoned New chats leave no empty threads. Window close keeps threads
(history outlives the window); **deleting a connection sweeps its threads** (list by resourceId →
delete each, best-effort).

**Endpoints:** `GET /api/agent/threads/:threadId/messages?resourceId=…` returns the thread's
history as AG-UI messages via `Memory.recall` + a defensive mapper (`mapDbMessagesToAgui`:
user/assistant text, assistant `tool-invocation` parts as `toolCalls` plus one synthetic
`role:"tool"` message per resolved invocation, id-prefixed `hist_` so the client can exclude them
from outbound sends; unknown parts/roles are skipped). Unknown thread → `[]`, never an error. It
does not require a live DB connection. `DELETE /api/agent/threads/:threadId` removes the thread
(`Memory.deleteThread`) — kept for explicit deletion even though "New chat" no longer calls it.

**Acceptance criteria:**
- Memory tables live in `agent.db`, not the bun:sqlite `app.db`
- A run with a stable `threadId`/`resourceId` accumulates history in memory
- The messages GET returns mapped history for a seeded thread and `[]` for an unknown one; after a DELETE, a subsequent GET returns `[]`
- `mapDbMessagesToAgui` pairs a resolved tool invocation with a synthetic `hist_`-prefixed tool message and skips unknown part types (unit)
- `newChatThreadId()` mints unique `chat:{uuid}` ids (unit)
- `POST /api/session/close` leaves threads intact; `DELETE /api/connections/:id` empties that connection's threads and leaves other connections' threads alone

### BASED-CHAT-HISTORY-PICKER: Chat history list & reactivation
**Applies to:** based (core, ui)
**Test category:** integration + unit (endpoint, titles); manual (picker UI)

A **Chat history** `IconButton` (`HistoryIcon`, a clock) in the Capi header — leftmost of the
trailing group, disabled while streaming — toggles a popover anchored under the header listing the
current connection's **last 15 conversations**, newest first: title plus relative time, the active
conversation tinted brass. Clicking a row moves the window's pointer (`setCapiThread`) to that
thread — the keyed remount plus the message cache / thread-history fetch restore it — and closes
the popover. The popover closes on outside click (excluding the toggle button, marked
`data-history-toggle`) and Escape. An empty history shows "No previous chats on this connection."

**Endpoint:** `GET /api/agent/threads?resourceId=…&limit=15` → `[{ id, title, updatedAt }]` via
`Memory.listThreads`, ordered `updatedAt DESC`, limit clamped to 1–50 (default 15). Memory-only —
no live DB connection required.

**Deterministic titles:** `threadTitle(firstUserMessageText)` (`core/src/agent/threadTitle.ts`) —
whitespace-collapsed first 6 words, hard-capped at 48 chars, `…` marking any dropped tail; blank →
"Untitled chat". At list time, a thread still wearing an unset/Mastra-default title
(`isDerivableTitle`) gets its first user message recalled, the title derived, and cached back via
`saveThread` — **not** `updateThread`, which stamps a fresh `updatedAt` and would re-sort history
by backfill time instead of conversation recency. Titling is deliberately confined to this ONE
seam: a tiny CPU-only titling model is planned as a future (likely config-optional) replacement
and must slot in there without touching anything else.

**Acceptance criteria:**
- `threadTitle`: 6-word cut with ellipsis, 48-char hard cap, whitespace collapse, blank → "Untitled chat"; `isDerivableTitle` true for unset/blank/`New Thread …`, false for real titles (unit)
- The list endpoint returns at most `limit` threads for the resource, newest `updatedAt` first, with derived titles; a second call returns the same titles (cached back onto the thread, order unchanged)

**Manual verification (requires a healthy model backend):**
1. Chat, New chat, chat again → the history button opens a popover listing both conversations, newest first, titled by the first words of each one's first user message; the active one is highlighted
2. Click the older conversation → the rail shows it (reactivated); send a follow-up → it lands in that conversation and it moves to the top of the list
3. Restart the app → the reactivated conversation is the one restored; the picker still lists both
4. While a run is streaming, the history button is disabled
5. On a connection with no prior chats, the popover shows the empty message; Esc and outside-click both close it
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

The agent's system prompt has three layers, and only two of them are user-editable:

| Layer | Source | Editable | Varies by connection |
|---|---|---|---|
| core | `GENERIC_CORE` | ✅ | ✖ |
| **capability briefing** | `mssqlBriefing(caps)` / `lanceBriefing(caps)` | **✖** | **✅** |
| persona | `MSSQL_PERSONA` / `LANCE_PERSONA` | ✅ | ✖ |

The **briefing** states what this connection *is*: which tools exist, whether it accepts writes, how
to qualify a table, which SQL dialect (if any). It is generated per variant by `agentSurfaceFor`,
injected between the core and the persona, and never stored in an instruction set. The **persona**
states how to behave — voice, policy, output conventions — and is deliberately variant-neutral:
every line must be true on every variant of its engine.

That split is what makes a custom instruction set safe. Facts are not opinion: a fact forked into a
fixed string goes stale against the connection, so the agent would confidently describe `run_query`
on a Cloud connection that has none. Because a persona claims nothing about the connection, forking
it costs the user nothing — the briefing is injected regardless.

The core + personas are persisted as named instruction sets. A single virtual `"default"` set always
mirrors the built-in `GENERIC_CORE`/`MSSQL_PERSONA`/`LANCE_PERSONA` constants — it is never persisted
and can be neither edited nor deleted, so it can't drift from the code. `GET /api/agent/instructions`
returns the active id plus every set (default first); `POST /api/agent/instructions` creates
(no `id`) or updates (matching `id`) a custom set; `POST /api/agent/instructions/active` switches the
active set; `DELETE /api/agent/instructions/:id` removes a custom set. All four reject `id: "default"`
(create/update/delete) or an unknown id (activate) with a 400.

Every instructions response additionally carries `briefings: {mssql, lancedb}` and
`briefingIsLive` — the generated half, read-only, so the editor can show what is always injected
alongside whatever the user writes. It is rendered from the **live** connection's capabilities when
one is connected and from the representative variant otherwise. It is never accepted on POST.

Which set the **running agent** uses is not the store's own `activeId` — it is the set the active
AI provider profile links to (`BASED-AI-PROVIDER-PROFILES`). `resolveById(id, engine)` returns a set's
`{core, persona}` for the connected engine, falling back to the `"default"` set when `id` no longer
resolves (e.g. the linked set was deleted). Instruction sets are thus authored/managed here but
*assigned* to an agent from its profile, and remain reusable across profiles.

**Acceptance criteria:**
- Fresh store → `GET` returns exactly one set, `{ id: "default", editable: false, core: GENERIC_CORE, mssqlPersona: MSSQL_PERSONA, lancePersona: LANCE_PERSONA }`
- Every instructions response (GET, save, activate, delete) carries `briefings` for both engines and `briefingIsLive`; a POST that includes a briefing does not persist it
- Each engine's persona is byte-identical across every variant of that engine; each engine's briefing differs across its variants
- No persona mentions `run_query`, `folder.main.table`, `folder`, `take_rows`, or read-only status — those are briefing facts
- The briefing does carry them: cloud says read-only, local names `run_query`, base-folder names `folder.main.table`, mssql names `run_mutation`
- A fully custom persona composed via `buildAgent` replaces the built-in persona **and still contains the connection's briefing**
- `agentInstructions(core, persona)` with no briefing composes core + persona unchanged (previews, tests)
- `POST` with no `id` creates a custom set (`editable: true`); a subsequent `GET` (after store reopen) still returns it
- `POST` with a matching `id` updates that set in place rather than duplicating it
- `POST`/`DELETE` targeting `id: "default"` → 400, no change
- Activating a set persists across a `GET`; deleting the active custom set falls back `activeId` to `"default"`
- Activating an unknown id → 400
- `resolveById(id, engine)` returns that set's `core` + the engine-appropriate persona (`mssqlPersona` for `mssql`, `lancePersona` otherwise) as plain strings; an unresolved `id` returns the `"default"` set's values

### BASED-AGENT-INSTRUCTIONS-COMPOSE: Instruction-set override wiring
**Applies to:** based (core)
**Test category:** unit

`buildAgent` accepts optional `core`/`persona` overrides; when supplied they replace `GENERIC_CORE`
and the engine surface's persona in the composed system prompt (`agentInstructions`).

There is deliberately **no briefing override**. The capability briefing is always the one
`agentSurfaceFor` generated for the live connection, so no user customization — and no stale
persisted set — can leave the agent describing a connection it isn't on
(BASED-AGENT-INSTRUCTIONS). `agentInstructions(core, persona, skillTags?, briefing?)` takes the
briefing last and optional, so callers that compose a preview without a live connection don't have
to fabricate one.

**Acceptance criteria:**
- `buildAgent` with no `core`/`persona` → instructions equal `agentInstructions(GENERIC_CORE, <engine persona>, <tags>, <engine briefing>)` for both `mssql` and `lancedb`
- `buildAgent` with `core`/`persona` overrides → the instructions contain the override text and omit the built-in `GENERIC_CORE`/persona text, **and still contain the connection's briefing**
- `agentInstructions` called without a briefing composes core + persona unchanged

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
collapsible boxes — Core (shared), SQL Server persona, LanceDB persona — open by default, each
persona followed by a collapsed, read-only **capability briefing** box for that engine, labelled
"generated, not editable" (and "this connection" when it was rendered from the live connection
rather than the representative variant). A short note above them says what belongs where: personas
set voice and habits, the briefing states what the connection is and is always injected — so the
user neither restates those facts nor worries about them going stale (BASED-AGENT-INSTRUCTIONS). The
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
- Each persona box is followed by a collapsed, read-only capability-briefing box for that engine; it has no textarea and cannot be edited
- With a LanceDB connection open, the LanceDB briefing box is marked "this connection" and its text matches that connection's variant (no `run_query` line on Cloud)
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

The right rail hosts the AG-UI chat (`useAgent`/`AgentProvider`), Streamdown-rendered assistant markdown with Shiki SQL highlighting; each SQL block offers **Insert into editor** and **Run**, labeled with the block's leading `--` purpose comment plus its first SQL line (falling back to "sql N" when no comment is present — see `BASED-CHAT-SQL-LABELS`); `run_mutation` renders an approval card whose Approve calls the gated endpoint. Run errors surface in the rail — both mid-stream failures (the server's `RUN_ERROR` events) and pre-stream ones (the endpoint answering with an HTTP error — no AI profile configured, session not connected, 500 — or the server being unreachable), which reject `runAgent` before any event arrives; the send path catches these and renders the reason as an error block in the thread (`describeRunError` extracts the server's JSON `error` body from the transport's wrapper; user-initiated Stop is never reported as a failure). A third shape reaches neither path: a run that completes having emitted no text, no tool calls and no `RUN_ERROR`, and therefore never rejects. A provider that answers an unknown path with HTTP 200 and a JSON error body produces exactly this — every layer below reads 200 as success and the response simply carries no choices, so a typo in a profile's base URL renders as silence plus a turn-duration readout. `classifySettledTurn` detects it from the settled transcript and the rail reuses the `BASED-AGENT-CONTINUE-PROMPT` block to report it. Unit coverage: `unit.uiRunError.test.ts`. `CapiAvatar` sits at the bottom-left of the prompt input row, stretched to that row's full height; the send control is an icon button positioned inside the textarea's bottom-right corner (Enter also sends). AI provider setup lives in the settings popover's Agent tab (`BASED-AI-PROVIDER-PROFILES`), not in this rail.

**Verification procedure (requires a healthy model backend — LM Studio engine on the configured host):**
1. Connect to a DB → open the Capi rail → ask "what tables are there?" → answer streams
2. Ask for SQL → a highlighted SQL block appears with Insert / Run, labeled with the agent's purpose comment and the first statement line → Run opens a results tab
3. Ask for an update → approval card renders; Reject = nothing runs; Approve = runs via the endpoint and an audit row appears
4. Kill the app mid-thread, reopen, same connection → the window's prior turns are restored from server memory (per-window restore — BASED-AGENT-THREADS)
5. Capi's avatar renders to the left of the prompt textarea at the textarea's full height; clicking the send icon inside the textarea (or pressing Enter) sends the message; the icon dims while streaming
6. After an answer settles, a subtle wall-clock readout of that turn (send→answer, e.g. `3.1s`) shows at the bottom of the thread; it clears when the next message is sent and is not persisted across reload (front-end only, `performance.now()` bracket around `runAgent`)
7. Ask something that takes several rounds of tool calls ("exercise every query tool and report what breaks") → with the browser console open, no `Encountered two children with the same key` warning and no `Maximum update depth exceeded`; each narration paragraph and each tool card appears exactly once in the transcript. Message ids are not unique — the Mastra bridge pins every post-tool text segment of a run to one `-agui-text` continuation id — so the rail numbers repeated ids into distinct React keys; without that the reconciler mismatches fibers and replays whole blocks on screen
8. With no AI profile configured (Settings → Agent, all profiles removed), send a message → an error block appears in the thread reading "No agent profile configured — add one in Settings → Agent." (not silence, not a raw `HTTP 400: {...}` dump), and the chat stays usable. Same with the model backend down: send → a readable error block, no dead spinner, no unhandled rejection in the console
9. Break the active profile's base URL so it points at a path the backend does not serve but still answers 200 — e.g. `http://localhost:1234/v1a` against LM Studio, which replies `{"error":"Unexpected endpoint or method…"}` with HTTP 200 — then send a message. The console shows `RunStarted` → `RunFinished` with no events between and no `RunError`, and the rail shows the empty-turn prompt (`BASED-AGENT-CONTINUE-PROMPT`) rather than only a duration readout. **Try again** resends the original message. Restore the URL → the same message answers normally

**Status note:** endpoint wiring, streaming plumbing, and the RUN_ERROR path are verified live (RUN_STARTED streamed; a model-load failure surfaced cleanly). A successful token stream is pending a healthy LM Studio engine on the host. The persona instructs the agent that user-facing results live in tabs (`show_results`), not pasted into chat — BASED-AGENT-TAB-TOOLS, BASED-AGENT-SHOW-RESULTS.

### BASED-CHAT-TRANSCRIPT-UI: Download the conversation from the chat header
**Applies to:** based (ui, core)
**Test category:** manual (endpoint: integration)

The Capi header carries a **Download transcript** `IconButton` (`DownloadIcon`) immediately left of
New chat, both in one `ml-auto` group. It posts the live `agent.messages` to
`POST /api/file/save-transcript`, which renders them with `transcriptMarkdown`
(BASED-AGENT-TRANSCRIPT) and writes them to a path from the native Save As dialog (`filterFor("md")`,
default name `based-chat-<yyyymmddhhmmss>.md`); cancelling returns `{ path: null }` and writes
nothing. The active tab's title becomes the document heading. An explicit `path` in the body skips
the dialog — the same escape hatch as `/api/file/save-sql`, and what makes the route testable. A
body without a `messages` array is a 400.

The client posts messages and the **server** formats them, rather than the UI building the markdown
itself: that keeps one transcript format shared with the `save_chat_transcript` tool, so the file
you get from the button and the file you get by asking Capi are the same document. The button is
disabled while streaming and when the thread is empty. It exists because the user should not have
to ask the agent to save their own conversation — and because `agent.messages` already holds the
reply Mastra has not yet flushed to `agent.db`, which the agent-side tool structurally cannot see.

**Acceptance criteria (endpoint):**
- POST with `messages`, `title`, and an explicit `path` writes `# <title>` + `## You` / `## Capi` sections at that path and echoes it
- Tool and system messages in the payload contribute nothing to the file
- POST without a `messages` array → 400

**Verification procedure (UI):**
1. Open the Capi rail on a fresh thread → the download button is present and disabled
2. Ask a question and let it answer → the button enables; it disables again during the next stream
3. Click it → the native Save As dialog opens with a `based-chat-<timestamp>.md` default name
4. Cancel → no file is written and no error appears in the rail
5. Click it again and save → the `.md` contains every turn **including the most recent reply**, with the tab's title as the heading and no tool-call JSON

### BASED-AGENT-TAB-TOOLS: Tab-aware chat — per-window thread, workspace tools, results in tabs
**Applies to:** based (ui)
**Test category:** manual (pure builders: unit)

The chat is window-scoped and tab-aware:

- **Per-window conversation** (BASED-AGENT-THREADS): the rail's chat session is keyed on the
  window's per-connection thread id (`win:{sid}:{connectionId}`). The `useAgent` mount is
  remounted via a React `key` + `initialThreadId` (the client's thread id is fixed at
  construction), so a remount happens only when the pointer moves — a connection switch, "New
  chat", or a history-picker reactivation — never on a tab switch; a module-level per-thread
  message cache makes in-session switches instant, and a cache miss seeds from the thread-history
  endpoint via `setMessages`. Restored synthetic tool messages (`hist_` ids) are excluded from
  outbound sends via `pruneOutboundMessages`. "New chat" mints a fresh thread and moves the
  pointer — the old conversation becomes history (BASED-CHAT-HISTORY-PICKER), nothing is deleted
  and `endSession()` is never called. A pointer move during a streaming run defers the remount
  until the run finishes, with a banner naming what Capi is finishing.
- **Workspace snapshot**: every send carries `forwardedProps.tabContext` built by a pure
  `buildTabContext(state)` — active tab identity/SQL/result summaries + the open-tab list — which
  the server renders into the instructions (BASED-AGENT-TAB-CONTEXT).
- **Frontend tools** (pattern: `run_mutation`): `list_tabs` (active tab id + per-tab
  id/kind/title/result summaries), `get_tab({ tabId, maxRows? })` (a query tab's SQL, output,
  stats, and serialized result rows — default 50, max 200, cells truncated at 300 chars; table/
  routine tabs return columns/definition; unknown id → `{ error, validTabIds }`), and
  `show_results({ sql?, table?, where?, run?, title? })` (BASED-AGENT-SHOW-RESULTS) — with `sql` it
  opens a real query tab via the store, `run !== false` awaits completion (15 s race; on timeout
  reports `status: "running"` while the tab keeps streaming) and returns
  `{ tabId, title, status, durationMs, resultSets, preview }` (10-row preview); with `table` it
  opens that table's pre-filtered Data tab instead. Agent-opened tabs need no thread bookkeeping —
  the window has one conversation per connection regardless of which tab is active.
  Their schemas and the capability policy live in `capiToolDefs` (React-, store- and monaco-free,
  so they are directly assertable); handlers and approval cards compose onto them in `capiTools`.
  The map is filtered per connection by `capiToolsFor` — see BASED-AGENT-SURFACE-VARIANT.

**Verification procedure (requires a healthy model backend):**
1. Chat, then switch tabs (and open/close tabs) → the conversation stays put; the window shows one chat at a time
2. Restart the app, reconnect → the window's active conversation is restored; a second window (Ctrl+N) starts its own fresh conversation on the same connection (its history picker still lists the shared past conversations)
3. New chat → an empty conversation; the previous one is reachable via the history picker (BASED-CHAT-HISTORY-PICKER), not deleted
4. Ask "show me the customers table" → the agent calls `show_results`; a results tab opens with the grid populated; the chat narrates a short summary instead of dumping rows; switching to/from that tab leaves the chat unchanged
5. Switch connections and back → each connection shows its own conversation, restored intact
6. Switch connections while a run is streaming → a banner names the busy connection; when the run ends the rail follows to the new connection's thread
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

Users configure one or more named AI provider profiles (`name`, `kind` — openai-compatible/openai/azure-openai/anthropic —, `baseUrl`, `model`, optional `deployment` for Azure, `instructionSetId`, optional API key) CRUD'd via `GET/POST /api/ai-profiles` and `DELETE /api/ai-profiles/:id`, persisted in `ai_profiles` (metadata) + Credential Manager (API key, keyed by profile id, `ai:` prefix — same convention as `BASED-LANCE-EMBED-PROFILES`). Exactly one profile is active at a time, set via `POST /api/ai-profiles/active` and persisted as `activeAiProfileId` in `AppSettings`; the agent resolves and runs against whichever profile is active. Saving a **new** profile activates it immediately (the user who just entered a model almost certainly wants to talk to it next); editing an existing profile never changes which one is active. Each profile carries an `instructionSetId` linking it to a reusable instruction set (`BASED-AGENT-INSTRUCTIONS`, default `"default"`); the running agent resolves its instructions from the **active profile's** linked set (via `AgentInstructionsStore.resolveById`), so selecting a profile selects both the model and its persona. A link to a set that no longer exists falls back to the `"default"` set at resolve time. A fresh install has zero profiles and no built-in default — the list stays genuinely empty until the user adds one, and invoking the agent with none configured fails cleanly with a "no agent profile configured" error rather than a raw connection error. If a *real* legacy single `ai_config` row exists (pre-profiles installs), it's migrated once on first use into a profile named "Default" (linked to `"default"`) and marked active, carrying over its Credential Manager key. Profiles read from the store without a stored `instructionSetId` (legacy rows) default it to `"default"`.

**Acceptance criteria:**
- A fresh install with no legacy `ai_config` row and no profiles → `GET /api/ai-profiles` returns `[]`
- A real legacy `ai_config` row migrates into a profile named "Default" with `instructionSetId: "default"`, on first read
- Invoking the agent (or `label-clusters`) with zero profiles configured → `400` with an error naming the missing configuration, not a raw fetch/connection error
- A profile saved with an explicit `instructionSetId` persists and round-trips via `GET`
- A profile saved with no `instructionSetId` reads back as `"default"`

**Verification procedure:**
1. Settings (gear icon) → Agent tab → on a fresh install, see an empty list (or the migrated "Default" profile, for an install with pre-existing single-config data) → Add a profile (the form takes over the tab; see `BASED-AGENT-INSTRUCTIONS-UI`) pointing at a local model, choose its Instructions set → Save returns to the list with the new profile already active (✓ next to its name)
2. Click another profile row to mark it active (✓ moves to it) → ask Capi something → the request runs against the newly active profile's endpoint using that profile's linked instruction set; editing a non-active profile and saving does not move the ✓
3. Editing a profile with a blank API key field keeps the previously stored key; deleting a non-active profile removes it from the list and Credential Manager; deleting the active profile clears the active selection
4. Point a profile's Instructions at a custom set, make it active → the agent's behavior reflects that persona; delete that set → the agent falls back to the Default persona instead of erroring
5. With zero profiles configured, ask Capi something → a clear "No agent profile configured — add one in Settings → Agent." message appears in the chat rail instead of a raw error

### BASED-AI-PROVIDER-WIRED: Native openai / azure-openai / anthropic providers
**Applies to:** based (core, ui)
**Test category:** unit (branch resolution); manual (live round-trip)

`resolveModel` shall construct a real AI SDK model for every `ProviderKind`: `openai` via `@ai-sdk/openai` (`createOpenAI`, optional custom base URL), `azure-openai` via `@ai-sdk/azure` (`createAzure` with `baseURL` = the full resource endpoint; the model that runs is the profile's `deployment`, which is required), and `anthropic` via `@ai-sdk/anthropic` (`createAnthropic`, optional custom base URL). These three kinds require a stored API key — a missing key throws an actionable error naming the provider (never the openai-compatible "not-needed" placeholder). The `openai-compatible` branch is unchanged except its provider instance name becomes the stable string `"openai-compatible"` so provider options have a predictable namespace (BASED-AI-PROFILE-PARAMS). All three packages ride the app's `ai@7` generation (`@ai-sdk/provider@4.x`); the Mastra (`ai@6`) transitive copies stay untouched.

**Acceptance criteria:**
- `openai` / `anthropic` with a key → a model whose `modelId` equals the profile's `model`; `azure-openai` → `modelId` equals the profile's `deployment`
- `azure-openai` without `deployment` throws an error mentioning "deployment"
- `openai` / `azure-openai` / `anthropic` with no key throw an error naming the provider kind
- `openai-compatible` with no key still resolves (local LM Studio path unchanged)
- `openai-compatible` with a blank model still resolves, and the outgoing request body carries no `model` key: `stripEmptyModelFromBody` removes an empty/whitespace-only `model` from a JSON body and leaves any other body (non-JSON, or a real model id) untouched. Blank means "the server's loaded/default model" — single-model servers (LM Studio, llama.cpp) only apply their default when the key is *absent*, so `model: ""` must never be sent.

**UI (manual):** the profile form's field requirements are per-kind — base URL required for `openai-compatible` and `azure-openai` (labeled "Endpoint" for Azure, placeholder showing the resource-URL shape), optional for `openai`/`anthropic` (blank = provider default); `deployment` required for `azure-openai`; model required for `openai`/`anthropic` (their APIs reject a request without one), optional for `openai-compatible` (blank = server's loaded model — cloud-style compatible backends like Ollama/vLLM/OpenRouter still need it filled in) and `azure-openai` (the deployment is what runs). A profile pointed at a live provider with a real key streams a chat turn.

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

### BASED-AI-PROFILE-TIMEOUT: Per-profile AI response timeout
**Applies to:** based (core, ui)
**Test category:** unit (resolution); integration (persistence); manual (a stalled model prompts instead of being cut off)

`AiProfile` gains an optional `timeoutSeconds` — the no-activity window for requests made with that profile, configurable per profile in the settings Agent tab. A pure `resolveAiTimeouts(timeoutSeconds)` resolves it into `{ idleMs, runMs }`: `idleMs` is the window in ms, `runMs` is `idleMs × AI_RUN_TIMEOUT_MULTIPLIER` (15) — the wall-clock cap for runs with no user in the loop (each subagent task, `BASED-AGENT-DELEGATE`). Absent, non-finite or non-positive values resolve to `DEFAULT_AI_TIMEOUT_SECONDS` (120 s), so a blank field means "default", never "no timeout". In the chat, `idleMs` drives the ask-to-keep-waiting stall prompt (`BASED-AGENT-CONTINUE-PROMPT`) rather than a kill; the vendored library's own watchdog — whose expiry hard-codes an abort with "The request timed out." — is demoted to a 6 h leak-guard backstop (`WATCHDOG_BACKSTOP_MS` passed as both `idleTimeoutMs` and `safetyTimeoutMs`). The one-shot cluster-labeling call (`BASED-EMBED-LABELS-AI`) still aborts on `idleMs`. The UI resolves the timeout from the **active** profile, falling back to the first profile the same way the server's `activeAiProfile()` does; because the stall timer reads the live value, editing the active profile takes effect without a chat remount.

**Acceptance criteria:**
- `resolveAiTimeouts(1800)` → `{ idleMs: 1_800_000, runMs: 1_800_000 × 15 }`
- `resolveAiTimeouts` of `undefined` / `null` / `0` / a negative / `NaN` / `Infinity` → `idleMs` = `DEFAULT_AI_TIMEOUT_SECONDS × 1000`
- Fractional seconds floor to whole seconds (`90.7` → `90_000` ms)
- `DEFAULT_AI_TIMEOUT_SECONDS` = 120, `AI_RUN_TIMEOUT_MULTIPLIER` = 15
- A profile saved with `timeoutSeconds` round-trips through the ai-profiles API; re-saving without it clears the value (integration)

**UI (manual):** the profile Add/Edit form has a "Response timeout (seconds)" number field with helper text; blank shows the default in the placeholder. Set a small value (e.g. 5) on the active profile, ask Capi something a slow model can't start answering in time → the stall prompt appears (see `BASED-AGENT-CONTINUE-PROMPT`); the run itself is not aborted.

### BASED-AI-PROFILE-STEPCAP: Per-profile tool call limit
**Applies to:** based (core, ui)
**Test category:** unit (buildAgent option); integration (persistence); manual (form field)

`AiProfile` gains an optional `maxToolSteps` — the tool-step budget for one agent run with that profile. `buildAgent` accepts a `maxSteps` option: a finite positive value (floored) becomes `defaultOptions.maxSteps`; absent or invalid falls back to `AGENT_MAX_STEPS` (30, `BASED-AGENT-MULTISTEP`). The chat endpoint passes the active profile's `maxToolSteps` through; subagents keep their own `SUBAGENT_MAX_STEPS`. The UI mirrors the default as `DEFAULT_AGENT_MAX_STEPS` and resolves the active profile's value for the continue prompt's message.

**Acceptance criteria:**
- `buildAgent({ ..., maxSteps: 60 })` → resolved default options have `maxSteps` 60; omitted → 30
- A profile saved with `maxToolSteps` round-trips through the ai-profiles API; re-saving without it clears the value (integration)

**UI (manual):** the profile Add/Edit form gains a "Tool call limit" number field next to Response timeout; blank shows the default (30) in the placeholder.

### BASED-AGENT-CONTINUE-PROMPT: Caps ask to continue instead of killing the run
**Applies to:** based (ui)
**Test category:** manual

No agent run ends the chat silently — every way a turn can settle without an answer surfaces an
in-chat prompt:

- **Stall prompt:** while a run is streaming, a timer of the active profile's `idleMs` resets on any visible progress (streamed text, finalized messages, activity steps). When it lapses, the chat shows "No response from the model for …" with **Keep waiting** (re-arms a fresh window, as if from 0) and **Stop** (`terminateRun()`). Progress arriving while the prompt is up dismisses it automatically.
- **Continue prompt:** a run that ends tool-calls-last with no final assistant text (the shape of an exhausted step budget) shows "Capi stopped without a final answer — it may have hit the tool call limit (N)." with **Keep going** (sends a "Continue." user turn through the normal send path — the fresh run gets a fresh step budget) and **Dismiss**. A model that deliberately ended on a tool call produces the same shape; offering to continue is correct there too.
- **Empty-turn prompt:** a run that settles having produced nothing at all — no text, no tool calls, and neither a `RUN_ERROR` nor a rejection, so no error path fires (see `BASED-CHAT-UI`) — reuses the same block, worded "Capi returned nothing — the model replied with no content. Check the AI profile's base URL and that the model backend is reachable (Settings → Agent)." with **Try again** (resends the user's last message, not a bare "Continue.") and **Dismiss**. Shown only once the send has resolved, since the transcript has this exact shape for an instant between the user's message being appended and streaming starting.

`classifySettledTurn` (`ui/src/agent/runError.ts`) makes the three-way distinction from the settled transcript alone; the component only renders it. Unit coverage: `unit.uiRunError.test.ts`.

**Acceptance criteria (manual, see `specs/based/tests/manual.ui.test.ts`):**
- Response timeout 5 on the active profile → stall prompt after ~5 s of silence; Keep waiting re-arms; Stop aborts; streaming progress auto-dismisses
- Tool call limit 2 → tool-heavy question ends after 2 rounds → continue prompt; Keep going sends "Continue." and the new run has a fresh budget; Dismiss hides the prompt for that ending
- Tool call limit 30 → the same question completes with a final assistant summary and no prompt
- Active profile's base URL pointed at a path the backend does not serve → send → empty-turn prompt, not silence; Try again resends the original message; Dismiss hides it

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

### BASED-UI-SHORTCUTS: Global keyboard shortcuts, discoverable from the UI
**Applies to:** based (ui)
**Test category:** manual

The canonical binding table. The global keydown handler (`App.tsx`) and the per-editor Monaco
registrations (`EditorPane.tsx`) implement it; the help tab (BASED-HELP-DOCS) renders it; adding,
removing, or changing a binding is a spec change to this table.

| Shortcut | Action |
|---|---|
| F5 / Ctrl+Enter | Run the active query tab |
| Ctrl+Break | Cancel the running query |
| Ctrl+S | Save tab to `.sql` (overwrites in place when file-backed) |
| Ctrl+Shift+S | Save to a new `.sql` file |
| Ctrl+O | Open a `.sql` file |
| Ctrl+T | New query tab |
| Ctrl+W | Close the active tab |
| Ctrl+PageUp / Ctrl+PageDown | Previous / next tab |
| Ctrl+J | Toggle the Capi rail |
| Ctrl+N | New window |
| Ctrl+Scroll, Ctrl+= / Ctrl+- | Zoom the app text size in / out |
| Ctrl+0 | Reset the text size to 100% |

**Discoverability rule:** every visible control whose action is also bound to a shortcut
advertises that shortcut in its hover tooltip — e.g. "New query tab (Ctrl+T)", "Run (F5 /
Ctrl+Enter)". Shortcuts with no corresponding control (Ctrl+N, Ctrl+PageUp/PageDown) are
discoverable via the help tab.

The *behavior* behind each binding stays specified by its own requirement (BASED-UI-TABS,
BASED-CANCEL, BASED-FILE-OPEN-SQL, BASED-CHAT-UI, BASED-WINDOW-RESTORE, BASED-UI-FONT-ZOOM…) — this
requirement owns only the key assignments and their discoverability.

**Verification procedure:**
1. Spot-check bindings against the table: Ctrl+T opens a tab, Ctrl+W closes it, Ctrl+J toggles
   the Capi rail, F5 runs, Ctrl+Break cancels
2. Hover the tab-strip `+` and `✕`, the Capi rail collapse/expand toggles, and the query toolbar
   Run/Cancel/Open/Save/Save As → each tooltip names its shortcut
3. Confirm the table here, the tooltips, and the help tab's shortcut list agree

### BASED-HELP-DOCS: In-app help documentation tab
**Applies to:** based (ui + core)
**Test category:** manual

A `?` icon button next to the theme picker in the left-rail header opens the help documentation as
a **tab** (`kind: "docs"`), rendered by the app like any other tab kind. There is at most one help
tab per window: clicking `?` again focuses the existing one rather than opening a second.

The help tab persists with the connection whose tab set it was opened in (BASED-TABSTORE) and
comes back on relaunch — so it is present under the connection where you opened it and absent
under one where you didn't. It carries no metadata and fetches nothing.

It is the one tab that renders with **no connection active** — help matters most before a
connection is set up. In that state the tab strip shows only the help tab and hides its
connection-scoped controls (new query tab, fetch size, plan/statistics capture), since those act on
a session that doesn't exist. A help tab opened with no connection carries forward into the first
connection made from that window (and persists there from then on) rather than being discarded;
switching between two existing connections does not drag it along.

Content, at minimum: the keyboard-shortcut table from BASED-UI-SHORTCUTS, and a vim-mode section
(how to enable the keymap, `:w` / `:q` / `:wq`, and the note that app shortcuts keep working in
every vim mode — see BASED-EDITOR-VIM).

**Verification procedure:**
1. Click `?` → a help tab opens and activates; click `?` again → it focuses, no second tab. Close
   it with `✕` or Ctrl+W like any tab
2. Restart with the help tab open → it comes back on that connection; switch to a connection that
   never had it open → no help tab there
3. With no connection (fresh profile, or after disconnect) → click `?` → the help tab renders; the
   strip shows no `+`, no Rows field, no plan/statistics toggles. Then connect → the help tab is
   still open and stays active
4. The shortcut list matches the BASED-UI-SHORTCUTS table; the vim section matches
   BASED-EDITOR-VIM; no uppercase labels; the page recolors with the app on a theme switch

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

`ConnectionConfig` carries an optional `engine` discriminator; `engineOf(cfg)` defaults an absent value to `"mssql"` so every legacy config stays valid with no migration. `createAdapter(cfg, getSecret, opts)` is **async** (BASED-LAZY-ENGINES: each descriptor's `loadAdapter` dynamic-imports its adapter module) and resolves to a `DatabaseAdapter` chosen by engine; `testConnection` is engine-agnostic (builds the adapter, runs its `probe()`). Session/tool code holds the interface, not a concrete class.

Adapter selection resolves through the engine registry (BASED-ENGINE-REGISTRY) rather than a switch in the factory, so adding an engine adds a descriptor rather than editing this seam.

**Acceptance criteria:**
- A config with no `engine` resolves to the MSSQL adapter; the full existing suite stays green (behaviour-preserving)
- A config with `engine: "lancedb"` resolves to the LanceDB adapter
- A config with `engine: "snowflake"` resolves to the Snowflake adapter

### BASED-LANCE-CONNECT: Cloud + local connect and probe
**Applies to:** based (core)
**Test category:** integration

The LanceDB adapter shall connect file-based (uri = a directory) and cloud (`db://slug` + API key from the secret channel + region), and `probe()` reports ok with a LanceDB server string or an error.

A local directory that exists but contains no entries at all connects as an empty single-db database (the bootstrap path for creating a brand-new database from nothing, BASED-LANCE-CREATE-TABLE). A directory with content but no LanceDB tables anywhere still errors — pointing a connection at an arbitrary populated folder stays a mistake, not an empty database.

**Acceptance criteria:**
- A local dir probe returns `ok: true` with a `serverVersion` matching `/LanceDB/`
- An existing directory with zero entries connects; `listObjects()` returns `[]`
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

### BASED-LANCE-SEARCH-UNIFIED: One search pipeline for vector/keyword/hybrid, with optional rerank and score thresholds
**Applies to:** based (core)
**Test category:** integration

`DatabaseAdapter.search(params: LanceSearchParams)` is the single entry point for vector/text/hybrid search, replacing three separate methods. Pipeline: resolve `vector` from `query` via the selected embedding profile if needed (vector/hybrid modes) → fetch `candidatePool` native candidates for the chosen mode (prefiltered by `where`) → if a reranker profile is given, call it with the candidate documents and keep its scores as `_rerank_score`; otherwise sort by whichever native score column is present (`_distance` ascending, anything else descending) → apply `minScore` (drop results scoring worse than a threshold, direction-aware) and `maxScoreGapFromTop` (drop results trailing the #1 result's score by more than this) against the active score column → truncate to `keepSize` (BASED-SEARCH-PARAM-NAMES). `EngineCapabilities.search` (replacing the old `vectorSearch`/`fullTextSearch`/`hybridSearch` flags) gates whether an engine exposes this at all.

**Acceptance criteria:**
- `search({mode:"vector", vector, candidatePool, keepSize})` returns at most `keepSize` rows sorted by ascending `_distance`
- `maxScoreGapFromTop` drops rows whose `_distance` exceeds the top result's by more than the given gap
- `minScore` drops rows scoring worse than the threshold — for `_distance`, where lower is better, that means an upper bound
- A configured reranker profile reorders and truncates results to `keepSize` by `_rerank_score`, independent of the native score order
- `mssqlAdapter.capabilities.search` is `false`; `lanceAdapter.capabilities.search` is `true`

### BASED-LANCE-AGENT-SURFACE: Per-connection agent tools + persona + skills
**Applies to:** based (core)
**Test category:** unit + integration

The agent surface is a property of the **connection**, not just the engine.
`agentSurfaceFor(capabilities, deps)` takes the live adapter's `EngineCapabilities` — the only thing
that distinguishes cloud from local from base-folder — and returns the tools, persona fragment, and
skill tags for that connection. `buildAgent` passes `requireAdapter(sid).capabilities`; callers with
no live adapter use `defaultCapabilitiesFor(engine)`.

Two rules govern the surface, and they pull in opposite directions on purpose (see
BASED-AGENT-SURFACE-VARIANT for the variant matrix):

1. **Names are stable.** `read_table`, `count_rows`, `describe_table`, `list_objects`,
   `get_indexes`, `run_query`, `export_data`, `get_connection_info` carry the same name on every
   engine. A chat thread stays coherent when the user switches connections mid-conversation, and the
   model never learns three names for one concept.
2. **Availability and parameters vary, and absence is total.** A capability the connection lacks
   means the tool or parameter is omitted from the schema, never present-and-refusing.

Engine-specific tools remain: LanceDB adds `vector_search`/`text_search`/`hybrid_search` (thin
wrappers over the adapter's unified `search()`) plus `list_search_profiles` and `take_rows`.

`agentSurfaceFor` returns `{tools, briefing, persona, skillTags}`. The system prompt composes as
core + **briefing** (generated, not editable) + persona (editable) + the engine-filtered skill
catalog — see BASED-AGENT-INSTRUCTIONS for why those last two are separate.

**Acceptance criteria:**
- Every variant's surface contains `get_connection_info`, `list_objects`, `describe_table`,
  `read_table`, `count_rows`, `get_indexes`, `export_data`, `load_skill`
- The MSSQL surface has no `vector_search`, no `list_search_profiles`, no `take_rows`; the LanceDB
  surfaces have all three
- No variant's backend surface contains `run_mutation`
- The LanceDB surface carries `skillTags: ["lancedb"]`; `lance-search` appears only in a LanceDB catalog
- The `vector_search` tool runs end-to-end against a live LanceDB table
- The search tools accept `embeddingProfileId`/`rerankerProfileId`/`minScore`/`maxScoreGapFromTop`/
  `candidatePool`/`vectorColumn` and pass them through to `search()`; the vector/hybrid tools carry
  the tuning knobs of BASED-LANCE-SEARCH-KNOBS under one nested `tuning` object

### BASED-AGENT-SURFACE-VARIANT: Tools, parameters, and prose generated from capabilities
**Applies to:** based (core, ui)
**Test category:** unit

`EngineCapabilities` gains everything needed to *generate* the surface rather than describe it in
prose the model must evaluate against a variant it cannot see: `engine`, `variant`
(`mssql` | `lancedb-local` | `lancedb-basefolder` | `lancedb-cloud`), `containers` (base-folder
names), `wherePredicate`, `structuredFilters`, `countRows`, `takeByKey`, `indexIntrospect`. It rides
`/api/session/state` and `/api/session/connect` like the rest of BASED-CAPABILITIES-WIRE.

Every tool description and **capability-briefing** line is generated from that object and must be
**unconditionally true for the connection it was generated for** — no "on local connections…", and
no naming a tool the surface lacks (naming it is itself a suggestion). The briefing is the half of
the prompt that adapts; the persona beside it is fixed and variant-neutral, which is what keeps a
user's custom persona from going stale (BASED-AGENT-INSTRUCTIONS). The `schema` parameter, which
meant either a SQL schema or a base-folder name depending on engine, splits: schema-namespaced
engines (mssql, snowflake) take `schema`, base-folder connections take `folder` (whose description
lists the real folder names), and the other two LanceDB variants take neither.

The engine-varying half of that prose is **data on the engine descriptor**, not a conditional at the
tool site (BASED-ENGINE-REGISTRY): `agentProse` supplies the namespace parameter, the object summary,
the `describe_table` formats and description, the `table` parameter text, the `run_query` prose, and
the index prose. Assembly reads the descriptor rather than comparing an engine id, so an engine
without a descriptor is a compile error instead of silently inheriting LanceDB's tools and persona.

The **frontend** tool map is filtered the same way (`capiToolsFor`): `run_mutation` and `import_csv`
are dropped when `!capabilities.write`. This half was previously unfiltered, and the backend surface
test asserting `not.toContain("run_mutation")` passed while the model was being handed it on every
connection — a test covering half a surface is not covering the surface.

**Acceptance criteria:**
- `run_query` is absent on `lancedb-cloud` and present on the other three variants
- `folder` is a parameter only on `lancedb-basefolder`, on the shared tools *and* the search tools
  (a table name present in two folders was previously unreachable, with no way to disambiguate)
- `read_table` exposes `orderBy`/`filters` only where `structuredFilters`, `where` only where
  `wherePredicate`, and never both
- `export_data` exposes a `sql` source only where `caps.sql`
- The shared tool names are identical across engines (no per-engine aliases)
- No briefing, persona, or tool description names a tool absent from its own surface, for any variant
- Only a base-folder session's briefing mentions `folder.main.table`, and it names the real folders
- The frontend map drops `run_mutation`/`import_csv` when `!write` and keeps them when `write`

### BASED-AGENT-CAPABILITY-DISCOVERY: `get_connection_info` tool
**Applies to:** based (core)
**Test category:** unit

A shared `get_connection_info()` tool reports what the connection is and what it can do: engine,
variant, read-only status, each capability flag, which filtering style applies, the folder namespace
and its qualification rule, the row caps, and the connection's default embedding/reranker profiles
with the embedding dimension. On search-capable connections it also states the search pipeline order.

Without it the agent could only infer its column of the capability matrix from the *shape* of other
tools' output, which meant discovering a limit by hitting it: offering a fix on a read-only
connection, or reaching for SQL on Cloud.

**Acceptance criteria:**
- Present on every variant
- Reports `variant`, `readOnly`, and the capability flags matching the live adapter
- Reports the base folders on a base-folder connection and `null` elsewhere
- Reports the default embedding profile's model and dimension when one is configured

### BASED-INDEX-INTROSPECT: Index metadata on every engine that has it
**Applies to:** based (core, ui)
**Test category:** integration + manual

`DatabaseAdapter.getIndexes?(schema, table)` returns `TableIndex[]` wherever
`capabilities.indexIntrospect` is set, surfaced by `GET /api/session/indexes` — deliberately **not**
gated on `capabilities.script` the way `/table-details` is, because LanceDB has no DDL to script but
very much has indexes. `TableIndex` gains optional vector-engine fields: `distanceType`,
`numIndexedRows`, `numUnindexedRows`, `numIndices`.

On LanceDB these come from `listIndices()` + `indexStats()` — the same round-trip `vectorMetricsFor`
already made for BASED-LANCE-VECTOR-METRIC and from which everything except `distanceType` was
discarded. The cache is now keyed on the whole `TableIndex[]`, so the per-column metric lookup and
the index panel share one memoized call. On SQL Server the index recordset inside `getTableDetails`
is extracted into a shared query + assembler, so the Details panel and the standalone route can never
disagree.

The agent gets a `get_indexes` tool. This is what makes "IVF or HNSW?" a lookup instead of a guess:
`nprobes` only applies to an IVF index and `ef` only to HNSW, so without it the agent sets both and
concludes the knob does nothing. An empty result is reported explicitly, with what it means —
`text_search`/`hybrid_search` cannot run at all without a full-text index — and a non-zero
`numUnindexedRows` is surfaced as a warning, being the usual explanation for "search got slow" or
"search can't find a row I just added".

The Details tab renders the panel for **both** engines (it previously lived inside the mssql-only
`DetailSections`), with vector columns shown when the engine is search-capable, and renders
"no indexes" explicitly rather than hiding the section.

**Acceptance criteria:**
- `getIndexes` reports the seeded FTS index's type and row coverage on a live LanceDB table
- A table with no indexes returns `[]`, not an error
- A second call for the same table is served from the memoized result
- `get_indexes` returns a note explaining the search consequence when the list is empty
- `GET /api/session/indexes` answers 200 on LanceDB (an engine with `script: false`)
- mssql `getIndexes` matches the `indexes` array inside `getTableDetails` for the same table

**Verification procedure (UI):**
1. Open a LanceDB table → Details → the Indexes panel lists type / metric / indexed / unindexed
2. A table with no index shows the explicit "None." line naming the search consequence
3. Open a SQL Server table → Details → the existing Indexes section is unchanged
4. Both show the exact row count in the header next to the column count

### BASED-LANCE-SCAN: Filtered scan, counting, and take-by-key
**Applies to:** based (core, ui)
**Test category:** integration

`readTablePage` accepts a `where` predicate on engines with `capabilities.wherePredicate`;
`countRows(schema, table, {where|filters})` and `takeRows(schema, table, {keyColumn, keys, columns})`
join the adapter interface, surfaced as the `count_rows` and `take_rows` agent tools and the
`/api/session/row-count` route.

This closes the sharpest gap on a LanceDB Cloud connection: with no SQL and no structured filters,
"show me rows where source = 'discord'" had no path except abusing `vector_search` with a throwaway
query — which returns ANN-ordered results, not the rows. `hasMore` also told the agent nothing about
scale, so it could not choose between paging and aggregating or tell the user how large an answer was.

`take_rows` escapes its key literals server-side rather than having the agent write them into a
`where`. Lance predicates are DataFusion-flavoured: a double-quoted name parses as a **string
literal**, not an identifier, so the key column goes bare when it is a plain name and backtick-quoted
otherwise.

**Acceptance criteria:**
- `readTablePage` with `where` returns the matching rows in table order
- `countRows` returns the table total and honours the same predicate
- `takeRows` fetches by key; a quote inside a string key is data, never syntax
- An unknown key column is rejected by name; an empty key list is a no-op, not a full scan
- `take_rows` and the search tools size-bound their rows before returning them
  (BASED-AGENT-TOOL-PAYLOAD-CAP) — document chunks are exactly the wide-text case a row cap misses
- `GET /api/session/row-count` and `table-data?where=` honour the predicate over HTTP

### BASED-LANCE-VECTOR-COLUMN: Targeting one of several embeddings
**Applies to:** based (core, ui)
**Test category:** integration

`LanceSearchRequest.vectorColumn` selects which vector column a vector/hybrid search runs against,
applied via the SDK's `.column()`. Without it LanceDB picks a column itself, so a table with two
embeddings was only reachable through whichever one it happened to pick. The dimension guard
(BASED-LANCE-EMBED-DIM-GUARD) checks the **named** column when one is given — otherwise a query
vector sized for one embedding passes because the other column happens to match. The Data tab's
search controls show a column picker when a table has more than one vector column.

**Acceptance criteria:**
- Naming a vector column searches that column (its own nearest neighbour ranks first)
- A vector sized for a different column fails against the named column's dimension
- Naming a non-vector column fails by name, listing the real vector columns

### BASED-LANCE-EMBED-DIM: Embedding profiles learn their own dimension
**Applies to:** based (core)
**Test category:** integration

`EmbeddingProfile` gains an optional `dimension`, back-filled from the first successful embed:
`resolveEmbeddingProfile` wires an `onDimension` callback that `embedQuery` invokes with the real
output size, and `EmbeddingProfileStore.recordDimension` persists it (idempotent, never throwing — a
failed metadata write must not fail a search). `list_search_profiles` reports it.

Before this the agent had to reason across two tools plus knowledge of model dimensions to avoid a
mismatch: `list_search_profiles` gave the model name, `describe_table` gave the column dimension.
The runtime guard (BASED-LANCE-EMBED-DIM-GUARD) remains the backstop — it catches the mismatch this
lets the agent avoid, and a same-dimension mismatch between different models still cannot be caught
by any check.

**Acceptance criteria:**
- A profile used for a search reports its dimension on the next `list_search_profiles`
- A profile never used reports `dimension: null` rather than a guess

### BASED-SEARCH-PARAM-NAMES: Search parameters named for what they do
**Applies to:** based (core, ui)
**Test category:** unit + integration

`sampleSize` → `candidatePool`, `floor` → `minScore`, `delta` → `maxScoreGapFromTop`, everywhere:
wire type, adapter, server route, agent tools, UI controls, skill, tests. A breaking change to
`/api/session/lance-search`.

The old names misdescribed the behaviour rather than the behaviour being wrong. `sampleSize` reads as
row sampling — with `sample_rows` two tools away — but means a candidate over-fetch pool. `floor`
reads as a lower bound while, for `_distance` where lower is better, it correctly functions as an
upper one; the filtering was always direction-aware, so the parameter was used backwards by anyone
who trusted its name. The vector tuning knobs additionally move under one nested `tuning` object:
Mastra's OpenAI schema-compat layer marks every top-level property required with
`anyOf: [..., null]` (it matches on `provider.includes("openai")`, which the default
`openai-compatible` provider satisfies), and a model under that pressure fills plausible values
rather than nulls — so eight flat knobs produced eight spurious values on tables with no index.

Every search tool states the pipeline order verbatim:
`probe (nprobes/ef) → prefilter (where, unless postfilter) → candidatePool → rerank (rerankTopN) →
threshold (minScore/maxScoreGapFromTop) → k`, with `k` clamped to `candidatePool`.

**Acceptance criteria:**
- The search tools offer `candidatePool`/`minScore`/`maxScoreGapFromTop` and none of the old names
- The tuning knobs are absent from the top level and present under `tuning`; `text_search` has no
  `tuning` object at all
- Filtering behaviour is unchanged by the rename (same rows kept for the same thresholds)

### BASED-AGENT-SHOW-RESULTS: `show_results` on every connection
**Applies to:** based (ui)
**Test category:** unit + manual

The frontend `open_query_tab` becomes `show_results`, present on every variant and dispatching on
capability: with `sql` it opens a query tab and runs it; with `table` (and optional `where`) it opens
that table's Data tab through `openTableTabWithQuery`, pre-filtered, with the predicate shown as a
clearable chip so a filtered grid never looks like the whole table.

It must not simply disappear on SQL-less connections. Dropping it there would strip the "rows land in
a real grid, don't paste them into chat" norm from `GENERIC_CORE` exactly where the agent also cannot
aggregate — every Cloud answer would degrade to rows in chat.

**Acceptance criteria:**
- Present on both a writable SQL connection and a read-only SQL-less one
- Accepts both a `sql` source and a `table`+`where` source; neither is required
- `open_query_tab` no longer exists

**Verification procedure:**
1. On a LanceDB Cloud connection ask "show me rows where source = 'discord'" → the rows land in a
   Data-tab grid with a `where …` chip, not in chat
2. Clear the chip → the unfiltered page returns
3. On a SQL connection the same request still opens and runs a query tab

### BASED-LANCE-UI: Engine selector, vector display, read-only browse, SQL gating
**Applies to:** based (ui)
**Test category:** manual

The connection dialog gains an Engine selector (SQL Server / LanceDB); LanceDB shows a Cloud/Local mode with URI/region/API-key or a directory path (SQL fields hidden), plus the connection's embedding/reranker profile pickers (BASED-LANCE-CONN-DEFAULT-PROFILES). Vector columns render as `vector[dim] type`; vector cells render as `vec[dim] [v0, v1, …]`. LanceDB tables (no PK) browse read-only. The SQL editor / new-query affordance is hidden for LanceDB **Cloud** connections only — local connections have a SQL editor via the embedded DuckDB (BASED-LANCE-SQL / BASED-LANCE-SQL-GATING). SQL-tab and Data-tab-search gating are both driven by the real `EngineCapabilities` from the connection response (BASED-CAPABILITIES-WIRE), not a hardcoded `engine === "mssql"` check.

**Verification procedure:**
1. New connection → Engine: LanceDB → Local → set a directory with a LanceDB table → Test → ok → Save
2. Connect → object tree lists tables (no schemas/procs) → open one → the vector column shows `vector[dim]`; the grid is read-only; cells show `vec[dim] […]`
3. The "+" new-query button is present for a local LanceDB connection and absent for a Cloud one (BASED-LANCE-SQL-GATING)
4. Open the Capi rail → "find rows similar to X" → the agent calls `vector_search`/`hybrid_search` with no `embeddingProfileId` (the connection's profile supplies it) and renders results (needs a healthy model backend); "what rerankers do I have?" → it calls `list_search_profiles` and names them without inventing ids

### BASED-CAPABILITIES-WIRE: Real EngineCapabilities exposed end-to-end
**Applies to:** based (core, ui)
**Test category:** manual

`GET /api/session/state` and `POST /api/session/connect`'s responses both carry `capabilities: EngineCapabilities | null` — the live adapter's full capability object, or `null` when disconnected. Alongside `{sql, search, write, orderedBrowse, script, relations}` it carries the fields BASED-AGENT-SURFACE-VARIANT generates the agent surface from (`engine`, `variant`, `containers`, `wherePredicate`, `structuredFilters`, `countRows`, `takeByKey`, `indexIntrospect`), so the UI, the server routes, and the agent all gate on one object rather than three parallel notions of what an engine can do. The frontend store keeps a `capabilities` field set from every connect response and resets it to `null` on disconnect; `TableDetailsView`'s SQL-tab gate and index panel, `TableDataGrid`'s Browse/Search toggle, `TabStrip`'s "+" new-query button, the store's `newQueryTab` guard and its index/row-count fetches, and the frontend agent tool map (`capiToolsFor`) all read it instead of hand-rolling `engineOf(conn) === "mssql"`. (Capabilities may be **dynamic per config**: the Lance adapter reports `sql: true` locally and `false` on Cloud.)

**Verification procedure:**
1. Connect to a SQL Server connection → the SQL tab is visible, no Search toggle appears in the Data tab
2. Connect to a LanceDB Cloud connection → the SQL tab is hidden, a Browse/Search toggle appears in the Data tab; a local LanceDB connection shows both
3. Disconnect → reconnecting to either engine re-derives the gating correctly (no stale capabilities from the prior connection)
4. On a read-only connection, ask the agent to change a row → it says the connection is read-only without proposing a mutation card (BASED-AGENT-SURFACE-VARIANT)

### BASED-LANCE-EMBED-PROFILES: Named, user-configured embedding profiles
**Applies to:** based (core, ui)
**Test category:** manual

Users configure one or more named embedding profiles (`name`, `baseUrl`, `model`, optional API key) pointing at any OpenAI-compatible `/v1/embeddings` endpoint (LM Studio, OpenAI, etc.), CRUD'd via `GET/POST /api/embedding-profiles` and `DELETE /api/embedding-profiles/:id`, persisted in `embedding_profiles` (metadata) + Credential Manager (API key, keyed by profile id, `embed:` prefix). A search picks one via `embeddingProfileId`, or inherits the connection's (BASED-LANCE-CONN-DEFAULT-PROFILES). The Search settings tab is CRUD only — it has no "default" affordance, because the default belongs to a connection. Deleting a profile also clears it from every connection that named it.

**Verification procedure:**
1. Settings (gear icon) → Search tab → Embedding profiles → Add → name it, point `baseUrl` at a running LM Studio embeddings endpoint, set the model id → Save
2. The profile appears in the Data tab's Search toolbar's embedding-profile dropdown for a LanceDB table, and in the connection dialog's "Embedding profile" picker
3. Editing the profile with a blank API key field keeps the previously stored key; Delete removes it from both the list and Credential Manager
4. Delete a profile that a connection used as its default → editing that connection shows "None" for it

### BASED-LANCE-RERANK-PROFILES: Named, user-configured reranker profiles
**Applies to:** based (core, ui)
**Test category:** manual

Users configure one or more named reranker profiles (`name`, `baseUrl`, optional `model`, optional API key, optional `api`, optional `instruction`), CRUD'd via `GET/POST /api/reranker-profiles` and `DELETE /api/reranker-profiles/:id`, persisted the same way as embedding profiles (`reranker_profiles` table + Credential Manager `rerank:` prefix). `api` selects the endpoint shape: `"rerank"` (default, and what legacy api-less rows mean) is a generic Cohere/TEI-shape rerank endpoint (`POST {baseUrl}/rerank {query, documents, top_n?} -> [{index, relevance_score}]`); `"openai"` is an OpenAI-compatible chat-completions endpoint scored via yes/no logprobs (BASED-LANCE-RERANK-OPENAI), for which the profile form requires `model` and offers the `instruction` override. A search picks a profile via `rerankerProfileId` plus optional `rerankerOptions` (`topN`, `temperature`). A connection may name a reranker as its default (BASED-LANCE-CONN-DEFAULT-PROFILES); that seeds the Data tab's picker but is never auto-applied to an agent search. Deleting a profile also clears it from every connection that named it.

**Verification procedure:**
1. Settings → Search tab → Reranker profiles → Add a profile pointing at a running rerank server → Save
2. Run a search in the Data tab with that reranker selected → results are reordered/truncated by `_rerank_score` instead of the native distance/relevance score
3. Add a second profile with API = "OpenAI chat completions (yes/no logprobs)", Base URL = an LM Studio `…/v1` running a non-thinking Qwen3-Reranker GGUF, Model = its LM Studio identifier → run the same search with this profile → rows carry `_rerank_score` in (0,1) and the order changes vs. the native score
4. Editing either profile with a blank API key keeps the stored key; a legacy profile (saved before `api` existed) still calls `POST {baseUrl}/rerank`
5. With a reranker selected, the search toolbar shows a "Rerank col" picker listing the table's string columns (default "auto" = the content-column heuristic); picking one sends it as `rerankTextColumn` and the rerank documents come from that column

### BASED-LANCE-CONN-DEFAULT-PROFILES: Per-connection default search profiles
**Applies to:** based (core, ui)
**Test category:** integration (resolution, persistence, delete sweep, route fallback); manual (connection dialog pickers + prefill, Data-tab preselect)

A LanceDB connection carries an optional default embedding profile and default reranker profile (`ConnectionConfig.defaultEmbeddingProfileId` / `defaultRerankerProfileId`, set in the connection dialog). The scope is deliberately the **connection**, not app-wide settings: which embedding model to use is a property of how that dataset's vectors were built, and a global default would silently reuse one model across datasets built by different pipelines — where a *same-dimension* mismatch returns plausible garbage that no dimension check can catch. There is no app-level default; instead a **new** connection prefills the embedding picker when exactly one embedding profile exists (the single-endpoint case), and never prefills on edit.

Resolution, in both the agent tools and `POST /api/session/lance-search`, is: explicit id from the caller → the connected connection's default → none. The connection is re-read per call, so editing it applies without reconnecting and a mid-session connection switch never carries the previous default over. The two ids fail differently on purpose: an explicit unknown id throws `Unknown embedding profile: <id>` (a caller naming something that doesn't exist, usually the model), while a **dangling** default resolves to no profile so the caller gets the actionable "configure one" guidance. Deleting a profile sweeps it off every connection that named it (`ConnectionStore.clearSearchProfileRefs`).

The embedding default is applied automatically; the reranker default is **not** applied to an agent search — on the `openai` api it costs one chat completion per candidate (up to `candidatePool` per search), so the agent must pass `rerankerProfileId` explicitly (it learns the id from BASED-LANCE-PROFILE-DISCOVERY). The Data tab seeds both of its pickers from the connection's defaults, so an absent id on the route means the user chose "None" and is honored; that panel never re-seeds once the user has touched either dropdown.

**Acceptance criteria:**
- Agent `vector_search` with `query` and no `embeddingProfileId`, connection default set → results ranked by that profile's embedding
- Connection default pointing at a deleted profile → the "no embedding profile" guidance, not `Unknown embedding profile`; an explicitly-passed unknown id still throws by name
- After `DELETE /api/embedding-profiles/:id` (or the reranker equivalent), no connection JSON still names it; other connections' unrelated references are untouched
- Connection reranker set, no `rerankerProfileId` passed → the result carries no `_rerank_score` and the rerank endpoint is never called; passing the id explicitly does rerank
- `POST /api/session/lance-search` with no `embeddingProfileId` embeds via the connected connection's default

**Verification procedure (UI half):**
1. Settings → Search → add one embedding profile → New connection → Engine: LanceDB → the "Embedding profile" picker is prefilled with it; add a second profile and create another connection → no prefill
2. Edit an existing LanceDB connection → pick an embedding profile and a reranker → Save → reopen → both persisted; switch Engine to SQL Server and back → the pickers are absent for SQL Server
3. Connect → open a table with a vector column → Data tab → Search → both dropdowns are seeded from the connection; set the reranker to "Reranker: none" and run → no `_rerank_score` column appears (the connection default does not come back)
4. Edit the connection to a different embedding profile while the Data tab stays open → a fresh search in an untouched panel picks it up without reconnecting

### BASED-LANCE-PROFILE-DISCOVERY: The agent can enumerate search profiles
**Applies to:** based (core)
**Test category:** unit (surface membership) + integration (output shape)

The LanceDB agent surface exposes `list_search_profiles` (no input), returning `{embedding: [{id, name, model, isConnectionDefault}], reranker: [{id, name, model, api, isConnectionDefault}]}`. It exists because profile ids are uuids the model cannot guess and the persona tells it to ask rather than assume a reranker exists — without it, it can do neither. No API key material is returned in any form. Absent from the MSSQL surface (no search there).

**Acceptance criteria:**
- Present in the LanceDB toolset, absent from the MSSQL toolset
- With two embedding profiles and one reranker configured, all three are returned, with the connection's defaults flagged `isConnectionDefault: true` and the others `false`
- The serialized result contains no API key and no `apiKey` field
- A reranker profile saved before `api` existed reports `api: "rerank"`

### BASED-LANCE-EMBED-DIM-GUARD: Query-vector dimension checked against the column
**Applies to:** based (core)
**Test category:** integration

Before querying, `search()` compares the query vector's length against the table's vector columns' `vectorDimension` (already known from BASED-LANCE-BROWSE) and throws if it matches none: `Query vector has N dimensions but the "<col>" column of <table> holds M.`, naming the embedding profile's model when the vector came from one. This replaces LanceDB's own `No vector column found to match with the query vector dimension: N`, which names neither the column nor the model — exactly what you need when a connection's default profile points at the wrong model. Applies equally to a caller-supplied raw vector. A table with no vector column is left to LanceDB (nothing to compare against).

**Acceptance criteria:**
- A raw `vector` whose length matches no vector column throws, naming the column, its dimension, and the produced dimension
- An embedded query of the wrong size additionally names the profile's `model`
- A correctly-sized vector behaves exactly as before
- A table with no vector column produces LanceDB's own error, not the guard's

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

Since BASED-INDEX-INTROSPECT the memoized value is the full `TableIndex[]` rather than a
column→metric map: the same round-trip already fetched `indexType`, `numIndexedRows`, and
`numUnindexedRows` and discarded them. The metric here is derived from that shared cache, so the
per-column lookup and the index panel cost one call between them.

**Acceptance criteria:**
- An indexed vector column reports the index's metric; unindexed columns report `null` *(test creates a small IVF index; self-skips if index training fails on the small fixture)*
- A second `getTableColumns` call for the same table does not re-run the index introspection (memoized)

### BASED-LANCE-SEARCH-UI: Data tab Browse/Search toggle and controls
**Applies to:** based (ui)
**Test category:** manual

For a LanceDB table (gated on `capabilities.search`, BASED-CAPABILITIES-WIRE), the Data tab's toolbar gains a Browse/Search toggle. Search mode replaces the browse toolbar with: a mode selector (text/vector/hybrid), a query text input, an embedding-profile picker (hidden in text mode), a reranker-profile picker with `top_n`/`temperature` inputs, `pool`/`keep`/`min score`/`max gap` number inputs (BASED-SEARCH-PARAM-NAMES), a vector-column picker on tables with more than one embedding (BASED-LANCE-VECTOR-COLUMN), a `where` prefilter text input, and Run/Clear buttons. Results render read-only through the same grid component used for browsing, by normalizing the `SearchRows` response into a `TablePage`-shaped value (every column comes back `isPrimaryKey: false`, so the grid's existing PK-based edit gate makes results read-only with no additional logic).

**Verification procedure:**
1. Open a LanceDB table's Data tab → click Search → the browse toolbar is replaced by search controls
2. Pick vector mode, enter a query, pick an embedding profile, Run → results render in the grid, read-only
3. Switch to Browse → the original paginated rows reappear unaffected
4. Set `min score`/`max gap`/`pool`/`keep` and rerun → the result count and order change accordingly

### BASED-LANCE-SEARCH-PROFILES-UI: Search tab in the settings popover
**Applies to:** based (ui)
**Test category:** manual

The settings popover (gear icon in the left rail, `ThemePicker`) has four tabs — General, Theme, Search,
Agent (`BASED-AI-PROVIDER-PROFILES`) — at a fixed width/height (480×560) that does not change when
switching tabs; a tab whose content is taller than that scrolls internally. The Search tab lists
embedding and reranker profiles with inline Add/Edit/Delete forms (`name`/`baseUrl`/`model`/API key,
blank key on edit = keep stored). The tab is CRUD only — it carries no active/default marker (unlike
the Agent tab's profiles), just a line pointing at the connection dialog as where a profile is chosen
for use (BASED-LANCE-CONN-DEFAULT-PROFILES).

**Verification procedure:**
1. Click the gear icon → Search tab → Add an embedding profile and a reranker profile
2. Both appear in the Data tab's Search toolbar dropdowns for a LanceDB table, and in the connection dialog's profile pickers; no row in the Search tab is clickable-to-activate
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
- A non-empty directory with no LanceDB tables anywhere (not at the top level, not in any subfolder) makes `connect()` throw a descriptive error rather than silently connecting to nothing. (A truly empty directory instead bootstraps as an empty database — BASED-LANCE-CONNECT.)

### BASED-LANCE-EMBED-COMPUTE: based-side embeddings
**Applies to:** based (core)
**Test category:** integration

`based` computes query embeddings itself rather than relying on LanceDB's native registered-embedding-function mechanism (which requires per-table setup outside based on a per-table basis). When `search()` is called in `vector`/`hybrid` mode with a `query` string and no raw `vector`, and an `embeddingProfile` is resolved (from a user-configured `EmbeddingProfile`, BASED-LANCE-EMBED-PROFILES), `embedQuery()` calls the profile's OpenAI-compatible `/v1/embeddings` endpoint via `@ai-sdk/openai-compatible`'s `embeddingModel()` + `ai`'s `embed()`, and the resulting vector is passed to LanceDB's `vectorSearch`/`nearestTo`. With no embedding profile (neither named by the caller nor inherited from the connection, BASED-LANCE-CONN-DEFAULT-PROFILES) and no raw vector, the call errors with a message pointing at the alternatives (set the connection's profile, pass a profile id, or supply a vector). The table's columns are read *before* embedding so the produced vector can be dimension-checked (BASED-LANCE-EMBED-DIM-GUARD).

**Acceptance criteria:**
- `vector`/`hybrid` mode with `query` + a resolved embedding profile computes a vector and returns results ranked by it
- `vector`/`hybrid` mode with `query`, no embedding profile, no connection default, and no raw `vector` throws a descriptive error rather than silently misusing the text as a vector

### BASED-LANCE-CREATE-TABLE: Create an empty LanceDB table (and database)
**Applies to:** based (core)
**Test category:** unit + integration

`EngineCapabilities` gains `createTable: boolean` — true on local LanceDB connections (`!isCloud()`), false on cloud (untestable here; the SDK supports it) and on SQL engines (they create tables through `run_mutation` DDL). It is deliberately **not** `write`: rows stay read-only on Lance connections, and flipping `write` would switch on `run_mutation`/`import_csv`/grid-edit, none of which Lance can honour.

`LanceDbAdapter.createTable({name, folder?, columns})` creates an **empty** table via the SDK's `createEmptyTable` with an explicit schema — never from seed rows (row inference maps every JS number to Float64 and errors on dates, and with no delete in this build a junk seed row would be permanent). The schema is built by a pure `buildLanceSchema(columns)` (`core/src/db/lanceSchema.ts`) that maps a closed column-spec set — `string | int | float | bool | date | vector(dim)` — to a *structural* `SchemaLike` (string type names plus `{typeId: 16, listSize: dim}` for vectors), keeping the adapter free of an `apache-arrow` import. Validation: at least one column, unique identifier-charset names, vector `dim` 1–8192 required iff type is vector. `date` maps to `datemillisecond` (the SDK's sanitizer has no timestamp string name).

Targeting: single-db connections create at the root; base-folder connections create in the named `folder` — an existing subfolder, or a **new** one (creating a database), guarded against Lance's reserved directory names and `.lance` suffixes. Creation uses `mode: "create"` so an existing table name errors rather than overwriting. After a create, the adapter updates its base-folder snapshot and closes the DuckDB SQL bridge so the next SQL/LSP call re-attaches (a new folder needs a new ATTACH). Known limitation: other windows' sessions keep a stale explorer snapshot until they reconnect. Concurrent creates from another process surface as the SDK's commit-conflict error, passed through.

`POST /api/session/create-table` runs it for the dialog (rejected with 400 when `capabilities.createTable` is false) and records a history row.

**Acceptance criteria:**
- `buildLanceSchema` maps each supported type to the expected Arrow type name and a vector spec to `FixedSizeList[dim]<Float32>`; duplicate/invalid names, empty columns, and missing/out-of-range `dim` throw
- Creating a table with scalar + vector columns in a temp dir yields an empty table whose `getTableColumns` reports the vector column with the right dimension; `listObjects()` includes it without reconnecting
- Creating the same name again errors (no overwrite)
- On a base-folder connection, creating into a new folder name creates the folder-database and `listSchemas()`/`listObjects()` include it
- `/api/session/create-table` on an engine without `createTable` → 400
- The DuckDB bridge sees the new table on the next SQL call (bridge reset)

### BASED-LANCE-CREATE-TABLE-UI: New Table dialog and entry points
**Applies to:** based (ui)
**Test category:** manual

A New Table dialog (table name; target folder on base-folder connections — an existing folder or a new name; column rows with name + type from the supported set and a dimension for vectors) posts to `/api/session/create-table` and refreshes the explorer on success. Entry points, both gated on `capabilities.createTable`: a "+" icon button in the Object Explorer's Tables group header, and a "New table…" item in the connection row's context menu (LeftRail) for the active, connected connection.

**Verification (manual):**
1. Connect to a local LanceDB directory; the Tables group header shows a "+" button and right-clicking the active connection row offers "New table…"
2. Create a table with a string column and a vector(4) column → it appears in the explorer without reconnecting; its Data tab opens empty
3. On a base-folder connection, type a new folder name → the folder appears as a schema and the table under it
4. On SQL Server / Snowflake / (future) Lance cloud connections, neither entry point renders

### BASED-AGENT-LANCE-CREATE: create_table proposal tool
**Applies to:** based (core + ui)
**Test category:** unit + integration

The first realization of BASED-AGENT-MUTATION-GATE's "future LanceDB write surface" note: Lance writes are SDK calls, not SQL, so table creation gets its own proposal tool with its own approval card rather than riding `run_mutation`. The same three layers apply:
1. The frontend `create_table` tool (name, folder, columns, reason) is offered only when `capabilities.createTable` is true — `filterToolsByCapabilities` becomes a per-tool required-capability map (`run_mutation`/`import_csv` → `write`, `create_table` → `createTable`)
2. The approval card previews the table name, target folder, and column list; only the user's Approve sends the request
3. `POST /api/agent/create-table` re-checks `approved === true` **and** `capabilities.createTable` server-side, and writes an audit row (kind `mutation`, `approved: true`, a `create table` summary as the sql text) before reporting the outcome

The Lance briefing replaces its flat "read-only, no tool to propose changes" line, when `createTable` is true, with one that stays unconditionally true: rows remain read-only, but `create_table` can propose a new empty table for user approval.

**Acceptance criteria:**
- `create_table` present in the frontend tool map iff `capabilities.createTable`; `run_mutation`/`import_csv` still absent on non-writable connections
- `/api/agent/create-table` without `approved: true` → 400, nothing created, no audit row
- With `approved: true` on a capability-less engine → 400
- With `approved: true` on local Lance → creates the table and writes an audit row with `approved`
- The briefing mentions `create_table` iff the capability is true

## Snowflake engine

### BASED-SNOWFLAKE-ENGINE: Snowflake as a registered engine
**Applies to:** based (core)
**Test category:** integration
**External tests:** requires a live Snowflake account; the suite self-skips when unreachable

`engine: "snowflake"` shall resolve to `SnowflakeAdapter` through the engine registry, with capabilities `{ sql, write, orderedBrowse, script, relations }` true and `{ search, wherePredicate, takeByKey, indexIntrospect }` false.

`indexIntrospect: false` is normative, not an omission: Snowflake has no user-defined indexes, so `get_indexes` shall be **absent** from the agent surface rather than present and answering a question the engine cannot answer. The agent's briefing shall say so and shall not suggest adding an index.

Catalog introspection reads `INFORMATION_SCHEMA` (`SCHEMATA`, `TABLES`, `VIEWS`, `FUNCTIONS`, `PROCEDURES`, `COLUMNS`) plus `SHOW PRIMARY KEYS` / `SHOW IMPORTED KEYS` for constraint-to-column membership. Snowflake's `INFORMATION_SCHEMA` has no `ROUTINES` view (functions and procedures are separate views) and no `KEY_COLUMN_USAGE` (`TABLE_CONSTRAINTS` names constraints but never their columns), so key membership must come from `SHOW`, whose result columns are lower-case and which accepts no binds. Because Snowflake stores unquoted identifiers upper-cased, a caller-supplied name shall be resolved to the stored form before being quoted into any subsequent statement; names shall not be blanket-normalised, which would break genuinely lower-case quoted objects. Paging is `LIMIT … OFFSET …`; counting is `COUNT(*)`. There is no `GO` separator, so `execute()` sends the editor text as one statement (`splitBatches` is not used).

**Acceptance criteria:**
- `probe()` returns `ok` with a `serverVersion` matching `/Snowflake/` and the current user as `identity`
- `listObjects()` returns tables, views, procedures and functions with their schema names; `INFORMATION_SCHEMA` is excluded
- `getTableColumns` reports PK and FK membership; `getRelations` returns FK edges for the ER diagram
- `readTablePage` honours `orderBy` and structured `filters`; `countRows` honours the same filters
- `execute()` streams `resultset`/`rows`/`resultsetEnd`/`done`, and `cancel()` yields `status: "cancelled"`
- `runCommands` commits all-or-nothing and rolls back on error
- A table name in the wrong case still resolves; a genuinely lower-case quoted name is not folded

### BASED-SNOWFLAKE-AUTH: Password, key-pair, and external-browser SSO
**Applies to:** based (core)
**Test category:** integration (password); manual (key-pair, SSO)

The adapter shall authenticate itself rather than through `entra.ts`, which is Azure-only and returns `null` for all three Snowflake auth types. `snowflake-password` → `authenticator: "SNOWFLAKE"` with the password from the connection's secret slot; `snowflake-keypair` → `"SNOWFLAKE_JWT"` with a private-key PEM and optional passphrase; `snowflake-oauth` → `"EXTERNALBROWSER"`, storing no secret.

Because the connection secret channel holds one string per connection id, key-pair auth shall store a JSON blob (`{"key":…,"pass":…}`) in that slot. A plain-string secret in a key-pair connection shall be read as the key with no passphrase rather than failing the connection.

An auth mode may declare `secretMultiline`, and the connection dialog shall then render its secret as a textarea rather than a masked `<input>`. This is a correctness requirement, not cosmetics: a PEM spans lines, and a single-line input drops newlines on paste — silently mangling the key instead of rejecting it. Key-pair is the only such mode today. Key-pair auth is also the supported answer to Snowflake's account-level MFA policy, which rejects password sign-in for service users.

`*.snowflakecomputing.com` is a wildcard onto Snowflake's shared load balancer, so a wrong account identifier resolves in DNS and completes a TLS handshake before the balancer 404s — the driver reports that as a bare `Request to Snowflake failed.` (`401002`), which reads like a network fault. That case shall be reported as an unrecognised account identifier instead, naming the region/cloud form a legacy locator needs; a bare locator only works in AWS us-west-2.

Opening a connection shall settle within a bounded time: on expiry the attempt is torn down and reported as an error rather than left pending. The driver cannot provide this — its `timeout` option bounds one HTTP request, and `retryTimeout` is clamped to `Math.max(300, yours)` and so cannot be lowered — so the bound is the adapter's. `snowflake-oauth` gets a longer bound than the other two because external-browser SSO legitimately blocks on a human.

**Acceptance criteria:**
- Password: `probe()` succeeds against a live account with env-supplied credentials
- `decodeKeyPairSecret` parses the blob, and falls back to `{ key: raw }` for a bare PEM
- `probe()` against an unreachable account returns `{ ok: false }` with a non-empty error well inside the driver's own 300 s retry budget — it never hangs
- A 404 from the login endpoint (`401002` + HTTP 404) is reported as an unrecognised account identifier naming the required region/cloud form, not as the driver's bare "Request to Snowflake failed."; a `390100` credential rejection keeps its own message
- **Manual (key-pair):** configure a key-pair connection; the secret input is a multi-line textarea, a pasted PEM keeps its line breaks, Test connection → succeeds; the keyring holds one entry for the connection
- **Manual (SSO):** choose "SSO (external browser)", Test connection → the system browser opens, and after login the test reports the Snowflake identity; no secret input is shown for this mode

**Implementation note (runtime workaround, no spec impact):** `snowflake-sdk` 3.1.0 runs cloud-platform detection at module load (`telemetry/platform_detection.js` — a `Promise.all` over 11 detectors) and `services/sf.js` awaits it before building the login payload. One detector, `hasAwsIdentity`, calls `@aws-sdk/client-sts` `STSClient.send()`, which under Bun never settles and ignores its abort signal; the `Promise.all` therefore never resolves, the login POST is never sent, and `connectAsync` hangs forever with no error and no log after `authentication successful using: SNOWFLAKE` — a line the driver emits *before* any network call, which makes the failure read as a success. Measured on Bun 1.3.14: `getDetectedPlatforms()` never resolves; under Node 24 the same import resolves in ~1 s, and a full `connectAsync` errors in 1.6 s. The SDK already has an `isBun` branch in that file, but it covers only the `fetch` detectors, not the AWS one. Fixed by setting `SNOWFLAKE_DISABLE_PLATFORM_DETECTION` (the detected value is telemetry only, `CLIENT_ENVIRONMENT.PLATFORM`). The driver reads it at module-load time, and **Bun does not guarantee that a side-effect `import` ordered above `import snowflake from "snowflake-sdk"` is evaluated first** — verified: it is not — so the adapter imports the driver for its *types* only and loads its value through a single lazy `loadSdk()` that sets the variable first. That laziness is load-bearing, not a style choice. Retire the workaround once Bun settles or aborts that STS call, or once the SDK's `isBun` branch covers the AWS path.

### BASED-SNOWFLAKE-SCRIPT: Object DDL comes from GET_DDL
**Applies to:** based (core)
**Test category:** integration

An adapter may implement `scriptObject(input, action)`. When present, both scripting call sites (the `describe_table` tool and `POST /api/session/script`) shall prefer it over the pure T-SQL scripter, which stays pure and unmodified.

Snowflake's implementation shall use `GET_DDL` for `create` (and, with `CREATE` rewritten to `CREATE OR REPLACE`, for a module's `alter`), and generate `drop`, `select` and `insert` templates itself. `describe_table` shall not offer an `alter` format on Snowflake.

**Acceptance criteria:**
- `describe_table(format: "ddl")` on a Snowflake table returns Snowflake `GET_DDL` output, not bracket-quoted T-SQL
- The `format` enum on a Snowflake connection contains `ddl` and does not contain `alter`
- An engine with no `scriptObject` still routes through the T-SQL scripter unchanged

### BASED-SNOWFLAKE-DML: Dialect-aware edit commands
**Applies to:** based (core)
**Test category:** unit

`buildEditCommands(change, dialect)` shall emit the connection dialect's identifier quoting and bind placeholders; the server passes the live adapter's dialect. The identifier guard (a strict safe-charset regex that throws before emitting anything) is dialect-independent and shall remain in force.

On a dialect with positional binds, the order of `params` **is** the bind order, so within one command params shall be pushed in the order their placeholders appear — UPDATE therefore emits SET params before WHERE params. On a dialect without `INSERT … DEFAULT VALUES`, an all-defaults insert shall be refused with a clear error rather than emitted as invalid SQL.

**Acceptance criteria:**
- T-SQL output is byte-for-byte unchanged: `UPDATE [S].[T] SET [C]=@p0 WHERE [K]=@k0`
- Snowflake output is `UPDATE "S"."T" SET "C"=? WHERE "K"=?` with params ordered `[setValue, keyValue]`
- A table or column name carrying `;`, a bracket, or a quote throws `Invalid identifier` on every dialect
- An empty insert throws on Snowflake and emits `DEFAULT VALUES` on T-SQL
- Update/delete without a primary key throw before emitting any command

## Lance SQL + LSP (Phase 4)

Local LanceDB connections get a real SQL query tab — an embedded DuckDB (`@duckdb/node-api`) with the `lance` **core extension** scanning the connection's `.lance` storage directly via `ATTACH … (TYPE lance)` (pushdown, no materialization through JS; also exposes `lance_vector_search(path, column, vector, k, …)`/`lance_fts()` as SQL functions). Both editors gain real Language-Server-Protocol intelligence over a WebSocket transport: an in-house DuckDB language server (no LSP exists anywhere for the DuckDB/DataFusion dialect) and, for SQL Server, the external `sqls` server. Engine-specific native deps (`mssql`, `@lancedb/lancedb`, `@duckdb/node-api`) load lazily at connection time.

### BASED-LAZY-ENGINES: Engine deps load on demand
**Applies to:** based (core)
**Test category:** integration

Importing `@based/core` shall evaluate no engine module: `mssql`/tedious, `@lancedb/lancedb`, `@duckdb/node-api`, and `snowflake-sdk` load only when a connection of that engine is used. `createAdapter` is async and resolves through the registry, whose descriptors hold `loadAdapter`/`loadLsp` **loaders** — importing `core/src/engines/registry` must therefore stay free of native stacks. The barrel re-exports no concrete adapter class (tests import them via the `@based/core/mssql` / `@based/core/lancedb` / `@based/core/lancedb-sql` / `@based/core/snowflake` subpath exports).

**Acceptance criteria:**
- A fresh process that imports `@based/core` has no mssql/tedious, `@lancedb`, `@duckdb`, or `snowflake-sdk` module in `require.cache`
- `createAdapter` resolves the MSSQL class for `engine: "mssql"` and for an engine-less legacy config, the LanceDB class for `engine: "lancedb"`, and the Snowflake class for `engine: "snowflake"`
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

The UI keeps plain `monaco-editor` (no monaco-languageclient/@codingame migration). `ui/src/lsp/`: `client.ts` (JSON-RPC over the `/api/lsp` WebSocket, initialize handshake, 10s request timeouts), `manager.ts` (opens/replaces/disposes the window's one client as `(status, capabilities.sql, activeConnectionId)` change; mirrors **all** query-tab Monaco models as LSP documents — didOpen on create/ready, 250ms-debounced full-text didChange (flushed immediately before completion/hover requests so the server never classifies against a pre-keystroke document — e.g. typing `schema.` must not complete against `schema` and insert a doubled `schema.schema.` prefix), didClose on dispose, re-didOpen on reconnect; exponential backoff 1s→16s while the store still wants LSP), `providers.ts` (completion + hover providers registered once for language `"sql"`, LSP↔Monaco kind/range/0-vs-1-based mapping; `publishDiagnostics` → `setModelMarkers`). The Vite dev proxy tunnels the socket (`ws: true`). Graceful degradation is a hard requirement: server down / refused upgrade / dead backend / request timeout → providers return empty and the editor behaves exactly as pre-LSP.

**Verification procedure:**
1. Local Lance connection → query tab → typing `SELECT * FROM ` offers the connection's tables; hover a column shows its type
2. Switch to a SQL Server connection → the socket reconnects and the sqls backend serves completions (sql-login)
3. Stop the core server → editor keeps working with Monaco's built-in suggestions; restart → completions come back (backoff reconnect)
4. LanceDB Cloud connection → no LSP socket is opened; editor unaffected
5. SQL Server connection → type `select * from <schema>.<partial>` quickly (within the didChange debounce) and accept a table suggestion → the bare table name is inserted after the dot, never a doubled `<schema>.<schema>.` prefix

### BASED-LANCE-AGENT-SQL: Agent run_query on local Lance
**Applies to:** based (core)
**Test category:** integration

The LanceDB agent surface gains `run_query`: read-only DuckDB SQL over the attached Lance tables, gated by `isReadOnly` and, at execute time, by `capabilities.sql` (cloud sessions get a graceful error pointing at the search tools). Reuses the engine-agnostic `collectQuery` with `AGENT_ROW_CAP`; reads are audited. The generated persona explains the DuckDB dialect and that search tools remain the primary path, and mentions `folder.main.table` qualification only on a base-folder connection; on a Cloud connection `run_query` is absent from the surface entirely rather than error-gated (BASED-AGENT-SURFACE-VARIANT). `run_mutation` still does not exist for Lance (`capabilities.write` false). The shared tools' default-namespace fallback keys off the **engine** (`"dbo"` only for mssql), not `capabilities.sql`.

**Acceptance criteria:**
- The Lance surface contains `run_query` and no `run_mutation`
- `run_query` executes a SELECT against a live seeded table and returns result sets; a mutating statement is refused
- Reads appear in the audit log
- `describe_table` with a bare table name on a base-folder connection searches subfolders (never guesses `dbo`), and accepts an explicit `folder` to disambiguate

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

## Packaging, platform paths & file association

### BASED-PLATFORM-PATHS: Per-platform application-data root
**Applies to:** based (core + shell-tauri)
**Test category:** unit

`appDataRoot(platform?, env?)` in `core/src/storage/db.ts` resolves the OS's per-user
application-data root: `%APPDATA%` on Windows, `~/Library/Application Support` on macOS (falling
back to `homedir()` when `HOME` is unset). `dataDir()` appends `based` to it and creates the
directory, unless `BASED_DATA_DIR` overrides the whole path — which `core/src/dev.ts` uses to point
dev sessions at a `based-dev` sibling so they never pollute the real `app.db`/`agent.db`. There is
no Linux branch; a Linux port would add XDG here.

Both parameters are injectable specifically so each platform's branch is testable from either build
host — the packaged app only ever exercises one of them.

`data_dir()` in `shell-tauri/src/main.rs` **mirrors this function in Rust** and must be changed with
it. The shell reads `pending-open.txt` from the directory core writes it to, so a drift between the
two implementations silently breaks opening a `.sql` file at launch (BASED-OPEN-SQL-ARGV) rather
than failing loudly.

**Acceptance criteria:**
- `appDataRoot("darwin", { HOME: "/Users/ada" })` → path segments `Users/ada/Library/Application Support`
- `appDataRoot("win32", { APPDATA: "C:\\Users\\ada\\AppData\\Roaming" })` → that value verbatim
- `appDataRoot("win32", {})` → `"."` (never a darwin path)
- `appDataRoot("darwin", {})` → still ends in `Library/Application Support`
- `BASED_DATA_DIR` set → `dataDir()` returns it exactly, and the directory exists afterwards

### BASED-PACKAGE-WIN: Packaged app bundle is self-contained
**Applies to:** based (shell-tauri)
**Test category:** manual

`shell-tauri/bundle-core.ts` builds the self-contained core bundle (`dist-core/{core,ui,bun}`:
the bundled core entry with its native addons and companion `duckdb.dll`, the built `ui/dist`,
and the `bun.exe` runtime), which `tauri.conf.json` maps into the app's resources. Installed,
those land beside `based-shell.exe` (`resource_dir()` = the exe dir), and `spawn_core()` in
`shell-tauri/src/main.rs` runs `<resources>/bun/bun.exe <resources>/core/index.js` with cwd set
to the resource dir — no repo checkout, PATH bun, or Explorer cwd involved. The bundler plugins
(keyring createRequire fix, libsql/duckdb native-require pinning) each address a real
packaged-only failure — none reproduces under `bun run`.

**Verification procedure:**
1. Build + install via `scripts/package-win.ps1` → run from the Start Menu shortcut on a path
   with no repo → the full UI renders (not the bare core page).
2. In the installed app, run a query on a LanceDB connection (exercises the DuckDB native
   stack). It must return results — not "LoadLibrary failed: The specified module could not
   be found." (`duckdb.node` is a thin shim linked against a companion `duckdb.dll`;
   `bundle-core.ts` ships the DLL beside the bundled `.node`.)

- 2026-07-25 PASS (electrobun-era bundle; superseded by the Tauri packaging below).
- 2026-07-31 PASS (Tauri spike: NSIS-installed build launched the bundled core and served the
  built UI; child-core handshake + LanceDB/DuckDB verified in the spike scorecard).
- Tauri + Inno packaging pass pending a human run of the procedure above.

### BASED-INSTALLER-WIN: Windows installer
**Applies to:** based (repo `scripts/`)
**Test category:** manual

`scripts/package-win.ps1` produces `dist/based-<version>-Setup.exe` (Inno Setup; version read
from `shell-tauri/tauri.conf.json` — the single source of truth, which
`scripts/bump-version.ps1` keeps in step with `shell-tauri/Cargo.toml` and the generated
`core/src/version.ts`). It builds the UI, runs `shell-tauri/bundle-core.ts`, builds the Tauri
shell with `tauri build --no-bundle` (Tauri's own NSIS bundler is not used for release), stages
`based-shell.exe` + the `core`/`ui`/`bun` resource dirs + `icon.ico`, and hands that tree to
`scripts/installer.iss`. The installer is per-user (`PrivilegesRequired=lowest`, no UAC),
installs to `{localappdata}\Programs\based`, creates a Start Menu shortcut (desktop shortcut as
an unchecked task), and registers an Apps & Features uninstall entry. The Inno `AppId` is
unchanged from the electrobun era, so installing over an old electrobun install upgrades it in
place — one Apps & Features entry — and an `[InstallDelete]` rule removes the stale
`bin`/`Resources` launcher tree at install time. Uninstall removes the install dir (including
runtime logs), shortcuts, and all registry keys written at install; user data in
`%APPDATA%\based` (app.db, agent.db) and Credential Manager secrets are left in place.

**Verification procedure:**
1. `pwsh scripts/package-win.ps1` (needs Inno Setup 6 + the Rust toolchain) →
   `dist/based-<version>-Setup.exe`.
2. Install → app in Start Menu, entry in Settings → Apps; launch shows the Tauri shell.
3. On a machine with an old electrobun install: install → still exactly one "based" entry;
   `{localappdata}\Programs\based\bin\launcher.exe` gone.
4. Uninstall → install dir + registry keys gone; `%APPDATA%\based` still present.

- 2026-07-25 PASS (electrobun-era installer, steps 1–2; superseded by the Tauri packaging).
- Tauri-based installer pass pending a human run of the procedure above.

### BASED-SQL-ASSOC-WIN: .sql "Open with" registration
**Applies to:** based (installer)
**Test category:** manual

The installer registers based as an *available* handler for `.sql` — never overwriting the
user's existing default. All under HKCU: ProgID `based.sql` (friendly name, `DefaultIcon` →
`{app}\icon.ico`, open verb `"{app}\based-shell.exe" "%1"`),
`Software\Classes\.sql\OpenWithProgids\based.sql`, and Default Programs registration
(`Software\based\Capabilities` with `FileAssociations: .sql=based.sql`, plus
`Software\RegisteredApplications\based`). The open verb targets the app exe directly: Tauri's
exe receives argv (and the single-instance plugin forwards a second launch's argv to the
primary), so the electrobun-era `based-open.exe` stub is gone; the shell still consumes
`<dataDir>/pending-open.txt` so a stale stub-written registration keeps working across the
upgrade (BASED-OPEN-SQL-ARGV).

**Verification procedure:**
1. Right-click a `.sql` → Open with → based is listed and opens the file; the previous default
   app is unchanged.
2. Settings → Default apps → based offers `.sql`.
3. Uninstall → based gone from Open with and Default apps.

- 2026-07-25 PASS (electrobun-era stub registration; superseded by the direct-exe verb).
- Direct `based-shell.exe` verb pass pending a human run of the procedure above.

### BASED-OPEN-SQL-ARGV: Opening .sql paths at launch
**Applies to:** based (shell + ui)
**Test category:** manual

File-open requests — direct argv paths, argv forwarded by the Tauri single-instance plugin from
a second launch (relative paths resolved against the secondary's cwd; the secondary exits), and
leftover lines in `<dataDir>/pending-open.txt` from an electrobun-era stub registration —
coalesce in the shell into one batch: Windows Explorer launches one process per selected file,
so the shell accumulates arriving file lists until ~300ms of silence, then dedupes and
dispatches the batch once. A batch opens **at most one window**: per BASED-SQL-OPEN-TARGET it
either lands as tabs in the last-focused window, or opens ONE new window carrying every path as
a repeated `open=<path>` URL-hash param. The UI opens each `open=` path (BASED-FILE-OPEN-SQL's
`openSqlFile`) into a query tab — titled by file name, `filePath` set — as soon as the window
has a connected session (fresh windows wait for the user's first connect; restored windows fire
right after restore); duplicates dedupe per window by `filePath`. File-open windows are additive
to BASED-WINDOW-RESTORE. A second launch with no files still opens a plain window immediately.

**Verification procedure:**
1. App not running: multi-select 3 `.sql` files → Enter → app starts with ONE window carrying
   them; after connecting, three tabs show the files' content and names.
2. App running (new-window mode): multi-select 3 `.sql` files → Enter → ONE new window in the
   same instance with three tabs; no blank extra windows.
3. App running (current-window mode): double-click a `.sql` → it opens as a tab in the
   last-focused window, which comes to the front.

- 2026-07-25 PASS (electrobun-era stub flow; superseded by native argv).
- 2026-07-31 PASS (Tauri spike: argv path opened a window per file; single-instance plugin
  forwarded a second launch's argv to the primary; superseded by batched at-most-one-window
  dispatch).
- Batched dispatch pass pending a human run of the procedure above.

### BASED-SQL-OPEN-TARGET: Where an OS file-open lands
**Applies to:** based (shell + core + ui)
**Test category:** integration (core relay + setting) / manual (shell dispatch)

The `sqlFileOpenTarget` setting (`"current-window"` | `"new-window"`, default
`"current-window"`) decides where a file-open batch lands. The shell reads it from
`GET /api/settings` per batch, defaulting to current-window on any error, and tracks window
focus order itself (`WindowEvent::Focused`); multi-selected files always share one window in
both modes (BASED-OPEN-SQL-ARGV).

Current-window dispatch routes through core, because windows are External-URL webviews with no
Tauri IPC: the shell POSTs `{sid, paths}` to `/api/open-files` and focuses that window; core
relays an `{type: "open-files", paths}` event over the sid's SSE stream, **buffering the batch
until that sid's SSE stream attaches** (a restored window's page may not have booted yet) and
flushing it exactly once. The UI queues the paths and opens them sequentially once the window
has a connected session. With no window open (or in new-window mode), the shell opens one new
window with the whole batch in the hash.

The Settings → General control ("Opening .sql files") offers "In the last-used window" / "In a
new window".

**Acceptance criteria:**
- A fresh settings read includes `sqlFileOpenTarget: "current-window"`; a saved
  `"new-window"` round-trips
- `POST /api/open-files` with an attached SSE reader for the sid delivers one `open-files`
  event with the paths; another sid's stream sees nothing
- With no SSE client attached, the batch is buffered and flushed exactly once when the sid's
  stream attaches (a second attach gets nothing)
- Empty or missing `paths` → 400

**Verification (manual, shell half):** procedure steps 1–3 of BASED-OPEN-SQL-ARGV, run in both
modes via Settings → General.
