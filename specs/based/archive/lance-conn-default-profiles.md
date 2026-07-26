# Plan: Per-connection default search profiles + profile discovery for the LanceDB agent

## Spec impact

**New requirements:** BASED-LANCE-CONN-DEFAULT-PROFILES (integration + manual),
BASED-LANCE-PROFILE-DISCOVERY (unit + integration), BASED-LANCE-EMBED-DIM-GUARD (integration).

**Modified requirements:** BASED-CONN-STORE (two optional LanceDB-only fields), BASED-LANCE-UI
(connection-dialog pickers; agent procedure), BASED-LANCE-EMBED-PROFILES /
BASED-LANCE-RERANK-PROFILES (a profile can be a connection's default; deletion sweeps references),
BASED-LANCE-SEARCH-PROFILES-UI (Search tab stays CRUD-only), BASED-LANCE-AGENT-SURFACE
(`list_search_profiles` in the toolset), BASED-LANCE-EMBED-COMPUTE ("no profile" now means no
caller id *and* no connection default; columns read before embedding).

No removed requirements.

## Context

Semantic search through the agent could not run at all. `vector_search`/`hybrid_search` took an
optional `embeddingProfileId`; with it omitted, `resolveEmbeddingProfile` returned `undefined` and
the adapter threw "No embedding profile selected". The LanceDB persona nevertheless promised the
query would be embedded "using the session's default embedding profile" — no such thing existed in
any store. And the model could not route around it: profile ids are `crypto.randomUUID()` and no
tool listed them, so it could neither name a profile nor check whether a reranker was configured,
despite the persona telling it to ask rather than assume.

Nothing validated the embedding's dimension either: `embedQuery` returns whatever the endpoint
gives, so a mismatch surfaced as LanceDB's `No vector column found to match with the query vector
dimension: N` — which names neither the column nor the model at fault.

## Decisions

**Scope is the connection, not app-wide settings.** Which embedding model to use is a property of
how a dataset's vectors were built. A global default silently reuses one model across datasets from
different pipelines; the dangerous case is not a dimension mismatch (now guarded) but two
*same-dimension* models, which returns plausible garbage with no error at all. `ConnectionConfig`
already carried LanceDB-only optionals (`uri`, `region`), so this is two more fields in the same
JSON blob — no migration.

**No app-level default at all.** Its only job would have been zero-config for single-endpoint
users; prefilling a *new* connection's picker when exactly one embedding profile exists covers that
without a second scope that can silently win at query time. Pre-existing connections take a one-time
edit, and the error message says so.

**Table scope rejected as over-engineering.** Two tables in one directory can come from different
pipelines, but there is no per-table config store and the dimension guard catches the common
mismatch.

**Embedding default is auto-applied; the reranker default is advertised, not applied.** Embedding is
required for the search to run and costs one cheap request. An `api: "openai"` reranker costs one
chat completion *per candidate* (up to `sampleSize`), so firing it implicitly on every agent search
would silently multiply latency and spend. The agent learns the id from `list_search_profiles` and
passes it when asked to tighten results. This also holds on `/api/session/lance-search`: the Data tab
seeds its picker from the connection, so an absent id there means the user chose "None".

**A stale default degrades; an explicit bad id throws.** An explicit unknown id is the model naming
something that doesn't exist (`Unknown embedding profile: <id>`). A dangling default — profile
deleted since the connection was configured — resolves to no profile so the caller gets actionable
guidance instead of a uuid it never chose. Deletion also sweeps the reference off every connection.

## Implementation

- `core/src/db/types.ts` — `ConnectionConfig.defaultEmbeddingProfileId` / `defaultRerankerProfileId`.
- `core/src/storage/connections.ts` — `clearSearchProfileRefs(profileId)` sweeps both fields (ids are
  unique across the two profile stores, so one method covers either kind).
- `core/src/db/searchProfileResolve.ts` — both resolvers take a `defaultId`, tolerant on the default
  path and throwing on an explicit unknown id.
- `core/src/server.ts` — `connectionDefaults(sid)` re-reads the connected connection per call (never
  captured at connect/agent-build time), so an edit applies without reconnecting and a mid-session
  switch can't carry the old default over. Wired into the `lance-search` route (embedding only) and
  the agent's `toolDeps`; both profile DELETE handlers call the sweep.
- `core/src/agent/tools/shared.ts` — `ToolDeps.defaultEmbeddingProfileId` / `defaultRerankerProfileId`
  as getters.
- `core/src/agent/tools/lancedb.ts` — embedding fallback in `resolveProfiles` (no reranker fallback),
  the new `list_search_profiles` tool, and a persona rewrite covering the connection's profile,
  discovery, and opt-in reranking.
- `core/src/db/lanceAdapter.ts` — `resolveTable`/`getTableColumns` moved above the embed step, plus
  `assertVectorDimension` (named column + dims + the profile's model).
- UI — `ConnectionDialog` gains the two pickers inside the existing `isLance` block with the
  single-profile prefill (new connections only; cleared when switching to SQL Server);
  `TableDataGrid` seeds both search dropdowns from the connection until the user touches either;
  `ThemePicker`'s Search tab points at the connection dialog; `ui/src/api/types.ts` mirrors the
  fields.

## Tests

TDD on the executable half — each assertion was confirmed failing for the right reason first
(missing method, missing tool, LanceDB's error instead of the guard's).

- `integration.storage.test.ts` — field round-trip/clear/legacy-absent; the delete sweep, including
  that unrelated references survive.
- `unit.surface.test.ts` — `list_search_profiles` on LanceDB, absent on MSSQL.
- `integration.lancedb.test.ts` — connection-default embedding through the agent tool (stub
  `/v1/embeddings`); reranker default never auto-applied but honored when passed; dangling vs.
  explicit-unknown id; discovery output shape incl. legacy `api: "rerank"` and no key material; the
  dimension guard for a raw vector, an embedded query (names the model), and a vectorless table.
- `integration.server.test.ts` — `/api/session/lance-search` with no `embeddingProfileId` embeds via
  the connection; profile DELETE clears the reference and the next search degrades descriptively.
- `manual.ui.test.ts` — the UI half (pickers, prefill rule, Data-tab seeding/override).

Full suite after the change: 378 pass, 38 skip (pre-existing env-gated), 0 fail; `bun run typecheck`
clean.

## Follow-ups (not done, deliberately)

- Per-table profile defaults (see decision above).
- Choosing a profile by *matching* the column's dimension — two profiles can share a dimension and
  produce incompatible spaces, so a dim match is not evidence of the right model. The guard rejects;
  it never guesses.
- The persona text is copied into user-editable instruction sets (`instructionsStore.ts`); only the
  built-in `default` set tracks the constant, so custom sets keep the old wording until re-created.
