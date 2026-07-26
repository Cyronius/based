# Phase 2 — Margin Chat (core AI loop)

> **Status: COMPLETE (core AI loop, 2026-07-21).** Requirements merged into [../spec.md](../spec.md).
> Verification: `cd specs && bun test` → 51 pass / 9 skip / 0 fail (new unit classifier + integration
> agent tests, including live Azure SQL dev-DB runs of get_schema / sample_rows / run_query / mutation
> refusal / approved-mutation-via-endpoint / audit). AG-UI endpoint proven live end-to-end: RUN_STARTED
> streamed, and a model-load failure surfaced as a clean RUN_ERROR (the Mastra→openai-compatible→LM
> Studio HTTP seam was separately proven). UI typechecks and builds (React 19 + Streamdown + vendored
> lm-ag-ui + Monaco + glide-data-grid).
> **Not yet exercised:** a successful token stream — the configured LM Studio host's inference engine
> returns "Engine protocol startup was aborted" for every model (host-side, not code); and multi-turn
> memory recall across restart (BASED-AGENT-THREADS manual step).
> **Deferred to a follow-up pass:** full AI-settings screen (only a compact ⚙ panel ships), Tools-menu
> panels (Notes / Execution Plan / Messages), Mermaid ER-from-schema affordance, `analyze_results`
> charts, and verifying `sendFullHistory:false` + memory multi-turn context once a model is healthy.

Parent plan: [.claude/plans/feasibility-and-architecture.md](../../../.claude/plans/feasibility-and-architecture.md) (Phase 2 section).
Phase 0 streaming evidence: [../phase0-results.md](../phase0-results.md) (spike 4 — the reference stack).

## Goal

Put a working agent in the right-hand "Margin Chat" rail: ask a question → the model streams
markdown (SQL highlighted) → SQL blocks get **insert-into-editor** / **run** affordances →
schema-only context via tools → read-only queries by default, mutations gated behind a
user-approval round-trip → agent-issued SQL audited locally. Threads persist per connection.

## Spec impact

**New requirements:**

- Agent / tools: BASED-AGENT-SCHEMA-CTX, BASED-AGENT-RUNQUERY, BASED-AGENT-SAMPLE, BASED-AGENT-MUTATION-GATE, BASED-AGENT-AUDIT
- Provider / endpoint: BASED-AI-PROVIDER, BASED-AGENT-ENDPOINT, BASED-AGENT-THREADS
- UI (manual): BASED-CHAT-UI

Modified: BASED-UI-LAYOUT (right rail is no longer an empty placeholder — it hosts Margin Chat).
Removed: none.

## Requirement details (authoritative until merged into spec.md)

### BASED-AI-PROVIDER: AI provider configuration & model resolution
**Applies to:** based (core) — **Test category:** integration

Provider config (kind ∈ {openai-compatible, openai, azure-openai, anthropic}, base URL,
default model, optional deployment) shall persist in the local store; the API key is stored in
Windows Credential Manager (never the store). A resolver turns the active config into an AI SDK
`LanguageModel`. The out-of-box default targets a local LM Studio OpenAI-compatible server.

**Acceptance criteria:**
- Save config → read back identical fields; the stored record contains no key material
- `setAiKey`/`getAiKey`/`deleteAiKey` round-trip through Credential Manager
- Resolver returns a model for an `openai-compatible` config pointed at a reachable base URL (live check self-skips if unreachable)

### BASED-AGENT-RUNQUERY: Read-only `run_query` tool with row cap
**Applies to:** based (core) — **Test category:** unit

The agent `run_query` tool shall execute only read-only statements. A pure classifier decides
read-only vs. mutating; non-read statements are refused without touching the DB. Forwarded rows
are capped (default 1,000 for the agent) and the result is marked truncated past the cap.

**Acceptance criteria:**
- `isReadOnly("SELECT * FROM t")` → true; leading CTE `WITH x AS (...) SELECT ...` → true
- `INSERT`/`UPDATE`/`DELETE`/`DROP`/`TRUNCATE`/`EXEC`/`MERGE` → false (case/whitespace/comment insensitive)
- `run_query` on a mutating statement returns a refusal object and never calls the adapter

### BASED-AGENT-SCHEMA-CTX: Schema-only context tool
**Applies to:** based (core) — **Test category:** integration

`get_schema` shall return objects (schema-qualified) and, on request, a table's columns — the
same introspection the explorer uses — and never return row data.

**Acceptance criteria:**
- `get_schema()` returns a non-empty object list; each entry has schema/name/type
- `get_schema({ table })` returns that table's columns (name, type, nullable, pk) and no rows

### BASED-AGENT-SAMPLE: `sample_rows` tool
**Applies to:** based (core) — **Test category:** integration

`sample_rows({ schema, table, limit })` shall return up to `limit` (hard-capped) rows via a
parameterized `SELECT TOP` over the identifier-validated object — the one tool that returns row
data, used only when the model explicitly samples.

**Acceptance criteria:**
- `sample_rows` on a known dev-DB table returns ≤ limit rows with the table's columns
- An invalid identifier (contains `;` / brackets mismatch) is rejected without querying

### BASED-AGENT-MUTATION-GATE: Approval-gated mutations
**Applies to:** based (core) — **Test category:** integration

The agent has **no server tool that executes DML/DDL.** Mutations run only through the
approval-gated endpoint, which requires an explicit `approved: true` and records the SQL to the
audit log before executing. The frontend reaches this endpoint only after the user approves the
`run_mutation` card.

**Acceptance criteria:**
- POST mutation-exec with `approved` absent/false → 400, nothing runs, no audit row
- POST with `approved: true` on a harmless statement → runs, audit row written with `approved`
- `run_query` (the only agent-callable exec tool) rejects mutations (BASED-AGENT-RUNQUERY), so the model cannot self-execute DML

### BASED-AGENT-AUDIT: Audit log of agent SQL
**Applies to:** based (core) — **Test category:** integration

Every SQL the agent causes to run (read via `run_query`/`sample_rows`, and approved mutations)
shall append an audit row (connection, database, kind read|mutation, sql, approved, started-at,
status, error) to the local store, retrievable most-recent-first.

**Acceptance criteria:**
- After an agent `run_query`, the audit list returns it with kind `read`, status `ok`
- An approved mutation records kind `mutation`, `approved: true`

### BASED-AGENT-ENDPOINT: AG-UI endpoint on the core server
**Applies to:** based (core) — **Test category:** integration

`POST /api/agent/:agentId` shall expose the Mastra agent as an AG-UI SSE stream, gated by the
per-launch token (401 without). It requires a live session (connection) so the tools have an
adapter.

**Acceptance criteria:**
- POST without the bearer token → 401
- With the token and a valid `RunAgentInput`, the response streams AG-UI events (`RUN_STARTED` … `RUN_FINISHED`)

### BASED-AGENT-THREADS: Per-connection thread persistence
**Applies to:** based (core) — **Test category:** integration

Chat threads shall persist via Mastra Memory (LibSQLStore, its own `agent.db`), keyed by
connection id, so a thread's history survives a restart.

**Acceptance criteria:**
- Two runs on the same `threadId` → the second sees the first's messages in memory
- Memory tables live in `agent.db`, not the bun:sqlite `app.db`

### BASED-CHAT-UI: Margin Chat panel
**Applies to:** based (ui) — **Test category:** manual

The right rail hosts the AG-UI chat (`useAgent`/`AgentProvider`), Streamdown-rendered assistant
markdown with Shiki SQL highlighting; each SQL block offers **Insert into editor** (new/active
tab) and **Run**; `run_mutation` renders an approval card whose Approve calls the gated endpoint.
Empty/misconfigured provider shows a "configure a provider" state rather than failing silently.

**Verification procedure:**
1. Connect to the dev DB → open the margin rail → ask "what tables are there?" → streamed answer
2. Ask for SQL → a highlighted SQL block appears with Insert / Run → Run opens a results tab
3. Ask for an update → approval card renders; Reject = nothing runs; Approve = runs via the endpoint and an audit row appears
4. Kill the app mid-thread, reopen, same connection → prior turns still shown

## Implementation decisions (below the traceability line)

- **Model = local LM Studio (OpenAI-compatible)** via `@ai-sdk/openai-compatible`, base URL
  `http://localhost:1234/v1`, default model `google/gemma-4-26b-a4b`. Seeded as the default
  provider config so the app works with no setup. Provider registry (openai / azure / anthropic)
  is wired at the resolver but the full settings **screen** is deferred; a minimal inline config
  suffices this pass.
- **Mutation gate = frontend tool + server endpoint,** not a server DML tool. The agent's only
  mutation affordance is the `run_mutation` frontend tool → approval card → `POST /api/agent/mutation`
  `{ sql, approved: true }`. This is the honest server-side gate: no agent-reachable code path
  runs DML, and `run_query` refuses non-read statements. Posture recorded: `approved` is a UX gate
  (a personal tool), the real enforcement is that DML has no agent tool.
- **Agent memory = `@mastra/libsql` LibSQLStore in its own `agent.db`** (separate from the
  bun:sqlite `app.db`) to avoid two SQLite clients on one file. Threads keyed by connection id.
- **Server tools close over the live `session` adapter** in `startServer` — the agent runs
  in-process, so `get_schema`/`sample_rows`/`run_query` reach the current connection directly.
- **React bumped 18→19** to match the validated spike stack (Streamdown 2.x / lm-ag-ui);
  re-verify Monaco + glide-data-grid + resizable-panels still render.
- **lm-ag-ui** is `github:Cyronius/lm-ag-ui` (not on npm); the spike-recorded `prepare`/build
  gotcha applies (build once inside its node_modules).
- **Deferred to follow-up:** AI-settings screen UI, Tools-menu panels (Notes / Execution Plan /
  Messages), Mermaid ER-from-schema, `analyze_results` charts.

## Verification

`cd specs && bun test` — new unit tests (classifier, agent row cap) always run; new integration
tests (provider resolve, endpoint auth, mutation gate, audit, threads) self-skip when the dev DB /
LM Studio is unavailable, matching the Phase 1 pattern. Live smoke against LM Studio +
dev DB documents BASED-CHAT-UI. On completion: merge requirements into spec.md, archive this plan.
