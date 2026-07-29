# Changelog

All notable changes to based are documented here. This project follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releases are cut with `scripts/release.ps1`, which drafts the section below from the commit log
and then stops for it to be rewritten into something a human would want to read.

## [0.1.3] - 2026-07-29

### Changed
- keyboard shortcut documentation

## [0.1.2] - 2026-07-28

### Changed
- snowflake
- bump version
- snowflake docs
- fix release script
- snowflake support

## [0.1.1] - 2026-07-28

- **Snowflake engine.** Connect with an account identifier and database (schema, warehouse, and
  role optional), with three auth modes: password, key pair (JWT) — the route past Snowflake's MFA
  policy for service accounts, supporting encrypted keys — and external-browser SSO. Full catalog
  introspection, table browsing and editing, scripting via `GET_DDL`, editor completion with
  Snowflake keywords, and an agent toolset built from Snowflake's actual capabilities (no
  `get_indexes` — Snowflake has no user-defined indexes; no plan capture — use `EXPLAIN` or
  `QUERY_HISTORY`). A wrong account identifier gets a descriptive error explaining the
  region/cloud identifier form instead of the driver's bare 404.

### Changed

- Engines are now declared in a registry of per-engine descriptors (fields, auth modes, dialect,
  capabilities, LSP, agent prose); connection dialogs render from the served engine profile, so
  adding an engine no longer touches the UI.

## [0.1.0] - 2026-07-26

First public release. Windows x64, unsigned installer.

### Engines

- **SQL Server / Azure SQL** over in-process `tedious`, with four auth modes: Entra ID interactive
  (system browser + loopback capture), Azure CLI credential, SQL login, and service principal.
- **LanceDB**, both cloud (`db://`) and local directories, including base-folder auto-detect that
  flattens every Lance database under a parent directory into the explorer as a schema.
- Local Lance connections get real SQL through an embedded DuckDB with the `lance` extension.
- Engine capabilities (`sql`, `search`, `write`, `orderedBrowse`, `script`, `relations`) are wired
  end to end, so the UI, the server routes, and the agent's toolset all light up from one source.

### Agent ("Ask Capi")

- Embedded Mastra agent over AG-UI, with provider profiles for OpenAI-compatible endpoints
  (LM Studio by default, no API key), OpenAI, Azure OpenAI, and Anthropic.
- Workspace-aware: reads your other open tabs' SQL and results, and opens new tabs whose results
  land in a real grid rather than in chat.
- The toolset is generated from the connection's capabilities. Tool names are stable across engines
  (`read_table`, `count_rows`, `describe_table`, `get_indexes`, `run_query`); parameters and
  descriptions vary, and a missing capability means the tool is absent rather than present and
  refusing. `get_connection_info` reports the whole surface in one call.
- Read-only by design. Writes and CSV imports reach the database only through an approval card you
  click, gated on the connection accepting writes. Every agent read goes to a local audit log.
- Per-tab conversation threads that survive a restart, a live tool-call activity feed, and
  Mermaid diagram rendering in the rail.

### Editor and results

- Monaco with LSP-backed completion and hover from two in-house language servers: one for T-SQL
  driven by the live authenticated connection, one for the DuckDB/DataFusion dialect.
- `GO` batch splitting, multiple result sets, cancel mid-query, real SQL error text, actual
  execution plans, and client statistics.
- Virtualized grids with client-side sort, a per-column filter mini-language, resizable auto-fit
  columns, and a shared export set (copy, copy as Markdown, CSV, open in Excel) that respects the
  sorted and filtered view.
- Table tabs with Details, editable Data, SQL, and Embeddings sub-views; transactional edit commit
  with a Review SQL preview; SSMS-style Script as.

### Embeddings Atlas

- Full-precision vectors streamed in a zero-copy binary wire format, reduced in a web worker
  (random projection, PCA, UMAP, k-means++ with automatic k) and rendered with deck.gl in 2D and
  3D, animating live as the layout converges.
- Lasso selection into a grid, find-similar via cosine kNN, TF-IDF cluster terms, and optional AI
  cluster naming.

### Search

- Vector, full-text, and hybrid search over LanceDB through one pipeline, with optional reranking.
- Reranker profiles support both the Cohere/TEI `/rerank` shape and OpenAI chat-completions
  yes/no logprob scoring, which turns any logprob-capable endpoint (including LM Studio, which has
  no rerank endpoint) into a reranker.

### App

- Multi-window with per-window session restore: reopens the windows that were open at last exit,
  each reconnecting and restoring its tabs.
- Self-healing sessions -- kill the core process mid-session and the window recovers with tabs intact.
- 32 themes across dark, midtone, and light, each with its own font trio, retinting the chrome,
  Monaco, both grids, and the WebGL canvas with no reload.
- Secrets in Windows Credential Manager, a per-launch bearer token on loopback, and per-user
  install with non-destructive `.sql` "Open with" registration.
