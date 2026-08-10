# Architecture

## Why it looks like this

SSMS, DBeaver, and VS Code are all unsatisfying for daily SQL Server work, and Azure Data Studio was
retired in February 2026 — leaving a real gap for a dedicated, modern client. based fills it with
one non-negotiable premise: **the AI is a first-class part of the workbench, not an extension bolted
to the side.** That premise drives most of the structure below.

TypeScript end to end, three processes, one of which is deliberately disposable.

```
+-------------------------------------------------------------+
|  shell-tauri/  Tauri 2 native window (Rust + WebView2)      |
|  - spawns core as a child process, points a webview at it   |
|  - single-instance plugin (.sql file forwarding via argv)   |
|  - reuses each window's sid across restarts                 |
+---------------------------+---------------------------------+
                            | 127.0.0.1:<port>, per-launch token
+---------------------------v---------------------------------+
|  core/  Bun server -- all logic, all secrets                |
|                                                             |
|  REST  |  NDJSON query streaming  |  SSE  |  WebSocket LSP  |
|                                                             |
|  +-- db/       adapters behind one DatabaseAdapter iface    |
|  +-- agent/    Mastra agent, tools, skills, audit           |
|  +-- lsp/      two in-house language servers                |
|  +-- storage/  bun:sqlite in %APPDATA%/based/app.db         |
|  +-- secrets   Windows Credential Manager (@napi-rs/keyring)|
|  +-- import/export  CSV/XLSX                                |
+---------------------------+---------------------------------+
                            |
+---------------------------v---------------------------------+
|  ui/  React 19 + Vite + Tailwind -- "The Ledger"            |
|  left rail | tabbed work area | right rail ("Margin Chat")  |
+-------------------------------------------------------------+
```

**The shell is thin on purpose.** It holds no app logic — window management and process startup,
nothing else — so replacing it is a contained job, not a rewrite. That was not hypothetical: the
shell was Electrobun through v0.1.3 and swapping it for Tauri touched no `core/` or `ui/` code. The
same thinness is what makes the macOS port tractable.

**Core holds every secret.** The webview never sees a connection password or an API key. It gets a
per-launch bearer token in its URL hash and talks to loopback.

## The Ledger

The layout was chosen from two rounds of concept exploration: an editorial three-pane workbench,
with the AI occupying the right-hand margin — the column that would otherwise hold marginalia.

- **Left rail** — connection → database → schema → object explorer (accordion by type, with counts),
  and query/agent history.
- **Center** — VS-Code-style tabs, scoped to the current connection. A query tab is three
  vertically stacked, independently resizable panes: editor → results → output. Table tabs instead
  carry Details / Data / SQL / Embeddings sub-views.
- **Right rail** — the agent thread, plus optional tool-driven panels.

Tabs persist across restarts per connection (a replace, not an append, so restore never accumulates
stale tabs). Switching back to an already-visited connection restores its tabs from an in-memory
cache with no server round-trip.

## Engines

All three engines sit behind one `DatabaseAdapter` interface (`core/src/db/types.ts`). Each is
described by a declarative `EngineDescriptor` — connection-form fields, auth modes, SQL dialect,
default capabilities, LSP wiring, agent prose — registered in the one map that knows every engine
exists (`core/src/engines/registry.ts`); everything else asks the registry instead of branching on
engine ids, and `createAdapterFor` resolves a connection to its adapter through it.

- **SQL Server / Azure SQL** — in-process `tedious`, no sidecar. Four auth modes (Entra interactive,
  Azure CLI, SQL login, service principal). Client-side `GO` splitting, multiple result sets,
  batch-scoped failure, cancel, actual execution plans, client statistics, and full `sys.*`
  introspection in one multi-recordset batch.
- **LanceDB** — cloud and local. Local connections additionally get real SQL through an embedded
  DuckDB with the `lance` extension (`ATTACH ... TYPE lance`), so predicates push down instead of
  materializing in JS. Cloud connections don't, because the extension reads storage rather than the
  cloud API.
- **Snowflake** — the official `snowflake-sdk`. Password, key-pair (JWT), and external-browser SSO
  auth; catalog introspection over `INFORMATION_SCHEMA` plus `SHOW PRIMARY KEYS` / `SHOW IMPORTED
  KEYS`; scripting via `GET_DDL`. No plan capture (Snowflake exposes no equivalent artifact) and no
  index introspection (no user-defined indexes exist). The SDK's cloud-platform detection hangs
  forever under Bun, so the adapter disables it before the driver loads
  (`core/src/db/snowflakeEnv.ts`).

Engine differences are expressed as **capabilities**, not as per-screen conditionals.
`EngineCapabilities` carries flags (`sql`, `search`, `write`, `orderedBrowse`, `script`,
`relations`, plus finer-grained ones like `wherePredicate`, `structuredFilters`, `takeByKey`, and
`indexIntrospect`) that are wired end to end — the UI, the server routes, and the agent's toolset
all light up or gray out from the same source of truth.

Engine dependencies **load on demand**. Importing `@based/core` must not evaluate a native stack, so
concrete adapter classes are reachable only through `createAdapterFor` or an explicit subpath
import.

## The agent

Mastra 1.x, embedded in-process as a plain library — no server, no cloud, no CLI. AG-UI is the
transport to the webview. Memory is LibSQL on a local file.

The design rules that matter:

- **Schema by default, rows on request.** The model gets object and column metadata freely; rows
  only through explicit, row-capped tool calls. 1,000 rows fetched, 50 previewed back to the model.
- **The agent cannot write.** `run_query` is guarded by a read-only classifier. Mutations and CSV
  imports are *frontend* tools: the agent proposes, an approval card renders in the rail, and only
  your click reaches the gated endpoint — which also checks the connection can accept writes at all.
- **The surface is generated from the connection's capabilities, not just its engine.** Tool *names*
  are stable everywhere (`read_table`, `count_rows`, `describe_table`, `get_indexes`, `run_query`),
  so a conversation stays coherent when you switch connections. What varies is each tool's
  parameters and description, both generated from `EngineCapabilities` — and a capability the
  connection lacks means the tool or parameter is *absent*, never present-and-refusing. A LanceDB
  Cloud session simply has no `run_query`; a base-folder session gets a `folder` parameter listing
  the real folders. LanceDB additionally exposes vector/text/hybrid search and profile discovery.
  `get_connection_info` reports the whole picture in one call, so the agent never has to discover a
  limit by hitting it.
- **It can see your workspace.** Every send carries a snapshot of the active tab, its SQL, its
  result summaries, and the open-tab list. Frontend tools let it read other tabs and open new ones
  whose results land in a real grid rather than in chat.
- **Skills are progressively disclosed.** The system prompt advertises skill names and descriptions
  only; the body is pulled on demand via `load_skill`, so the prompt doesn't grow with the catalog.
- **Every agent read is audited** to a local log, viewable in the history panel.

## Language servers

Both are in-house, for concrete reasons.

- **T-SQL** — completions and hover are driven by the session's *live authenticated adapter*, so it
  works with every auth type including Entra. The external `sqls` binary that was there first
  couldn't do that (SQL-login only), so it was removed.
- **DuckDB/DataFusion** — no language server exists for the dialect. This one sources completions
  from `sql_auto_complete()` and `duckdb_tables/columns/functions` against the live attached Lance
  catalog, and calls out vector columns with their dimension on hover.

Snowflake reuses the T-SQL server's catalog-backed completion — object and column completion is
dialect-neutral — with Snowflake's keyword list swapped in.

Graceful degradation is a hard requirement: server down, upgrade refused, or timeout, and the
providers return empty so the editor behaves exactly as it did before LSP existed.

## Streaming

Query execution streams as NDJSON — a discriminated `QueryChunk` union of `resultset`, `rows`,
`resultsetEnd`, `message`, `plan`, and `done`. The `plan` chunk is itself keyed by format
(`showplan-xml` vs `duckdb-json`) and both render through one common operator tree.

Connection status rides a separate SSE channel, which is also one of the two triggers for session
recovery: a **push** signal (a status snapshot for another session) and a **pull** signal (any
session-scoped request returning `409 session-lost`, which transparently retries after reconnect).
Concurrent triggers collapse into one in-flight resume. Kill core mid-session and the window heals
with tabs intact.

## Vectors and the Atlas

Vector data has its own binary wire format: `[u32 LE headerLen][JSON header, space-padded to 4-byte
alignment][raw float32 block]`. The alignment is the point — the client builds a `Float32Array`
view directly over the response buffer with no copy. It is the only read path that bypasses the
`{$:"vec"}` preview cap, and it's bounded by the row cap, a 128 MB vector-byte budget, and table
size (over-large tables sample in evenly strided chunks).

Reduction and clustering are hand-written, pure, and DOM-free, operating on flat `Float32Array`s:
seeded RNG, Johnson-Lindenstrauss projection, exact PCA by subspace iteration, UMAP, k-means++ with
Calinski-Harabasz auto-k, TF-IDF cluster terms, cosine kNN. It runs in a web worker with
generation-token cancellation and streams UMAP epochs out as they complete, which is why the layout
animates from noise into structure. Same table plus same seed gives a byte-identical layout.

## Storage and secrets

- `%APPDATA%/based/app.db` (`bun:sqlite`) — connections, tabs, window state, history, settings,
  AI/embedding/reranker profiles, agent instruction sets, audit log.
- `%APPDATA%/based/agent.db` (LibSQL) — agent thread memory.
- **Windows Credential Manager** — every secret, keyed by id: SQL passwords, service principal
  secrets, and all provider API keys. Deleted with the connection or profile. Uninstall leaves both
  the data directory and the credentials alone.

## Packaging

`scripts/package-win.ps1` produces `dist/based-<version>-Setup.exe` via Inno Setup: per-user install
to `%LOCALAPPDATA%\Programs\based`, no UAC, and non-destructive `.sql` registration — based is added
to the Open With list and Default Apps without displacing whatever already owns the extension.

The core bundle needs three custom Bun bundler plugins to get native modules into a working
bundle (`shell-tauri/bundle-core.ts`): `@napi-rs/keyring` clobbers the bundle-global `require`,
libsql's binding load is a template-string `require` the bundler can't follow, and
`@duckdb/node-bindings` resolves *every* platform branch instead of the host's. DuckDB's `.node` is
also only a shim against a companion `duckdb.dll`, copied beside it explicitly by a separate build
step. Each of those was a real failure that only appeared in a packaged build; the comments in that
file are worth reading before changing it.
