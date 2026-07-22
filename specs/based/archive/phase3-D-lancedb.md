# Phase 3 — workstream D (LanceDB: second engine, per-engine agent toolsets)

> **Status: COMPLETE (2026-07-22).** Requirements merged into [../spec.md](../spec.md) (LanceDB engine section).
> Verification: `cd specs && bun test` → **81 pass / 10 skip / 0 fail** (was 68/9 pre-D; +13 new: 9 LanceDB
> integration incl. an end-to-end agent-tool run, 4 agent-surface unit tests; +1 skip = env-gated cloud
> connect). `bun run typecheck` (core + ui + shell) clean.
> Parent plan: [../../../.claude/plans/phase3-daily-driver.md](../../../.claude/plans/phase3-daily-driver.md).
> Working plan: [../../../.claude/plans/phase3d-lancedb-adapter.md](../../../.claude/plans/phase3d-lancedb-adapter.md).

## Gate cleared

**BASED-LANCE-SPIKE — PASS under bun 1.3.14.** `@lancedb/lancedb@0.24.1` (win32-x64-msvc napi) loads and
runs under Bun: connect, create-table, vector search (correct nearest neighbour), FTS, hybrid + RRF
rerank, and Arrow schema introspection (`FixedSizeList[dim]<Float32>`) all verified. The Electrobun
pinned-Bun packaged load stays a later manual check under workstream E's shell gate.

## What shipped

### The refactor (validated against the existing MSSQL suite)
- **Engine discriminator + factory** — `ConnectionConfig.engine?`, `engineOf()` (absent → `mssql`, no
  migration), [core/src/db/adapterFactory.ts](../../../core/src/db/adapterFactory.ts) (`createAdapter`,
  engine-agnostic `testConnection`). `session.adapter`/`requireAdapter`/`ToolDeps.getAdapter` widened
  from `MssqlAdapter` to the `DatabaseAdapter` interface. `testConnection`'s `@@VERSION` query moved into
  `MssqlAdapter.probe()`.
- **Capability-gating** — `DatabaseAdapter.capabilities` (`sql`/`vectorSearch`/`fullTextSearch`/
  `hybridSearch`/`write`); `execute`/`runCommands` stay required but return graceful errors on engines
  that lack the capability. Server gates the SQL and table-edit endpoints on it.
- **Per-engine agent surface** — `tools.ts` split into
  [tools/shared.ts](../../../core/src/agent/tools/shared.ts) (`get_schema`/`load_skill`),
  [tools/mssql.ts](../../../core/src/agent/tools/mssql.ts) (`sample_rows`/`run_query` + `MSSQL_PERSONA`),
  [tools/lancedb.ts](../../../core/src/agent/tools/lancedb.ts) (`vector_search`/`text_search`/
  `hybrid_search`/`sample_rows` + `LANCE_PERSONA`). [agent/surface.ts](../../../core/src/agent/surface.ts)
  `agentSurfaceFor(engine, deps)`; `buildAgent` takes the engine; the persona split into a generic core +
  engine fragment. Skills gained an `engines?` tag with an engine-filtered `catalog(tags)`.

### LanceDB
- **Adapter** [core/src/db/lanceAdapter.ts](../../../core/src/db/lanceAdapter.ts): cloud + local connect,
  probe, listObjects/getTableColumns (vector-aware)/readTablePage, and `vectorSearch`/`textSearch`/
  `hybridSearch`; `execute`/`runCommands` degrade gracefully (no SQL, read-only).
- **Wire** [core/src/db/lanceSerialize.ts](../../../core/src/db/lanceSerialize.ts): vector cells →
  `{$:"vec", dim, preview}` (handles array / TypedArray / Arrow `Vector`); `WireValue` + `TableColumn`
  extended (MSSQL wire format unchanged).
- **Skill** [core/src/agent/skills/lanceSearch.ts](../../../core/src/agent/skills/lanceSearch.ts)
  (`lance-search`, tagged `["lancedb"]`).
- **UI**: connection-dialog Engine selector + Cloud/Local LanceDB fields; `vector[dim]` type display and
  `vec[dim] […]` cell rendering; no-PK read-only browse (falls out of the existing PK gate); SQL-editor /
  new-query button hidden for LanceDB connections.

## Requirements
Merged into spec.md: BASED-LANCE-SPIKE, -ENGINE, -CONNECT, -BROWSE, -WIRE, -VECTOR-SEARCH, -FTS, -HYBRID,
-AGENT-SURFACE, -UI (manual), -EMBED-COMPUTE (future work). BASED-SKILL-REGISTRY updated for the
engine-filtered `catalog(engines?)`.

## Not exercised (same gates as the rest of Phase 3)
- LanceDB **cloud** connect is env-gated (`BASED_LANCE_CLOUD_URI`/`_KEY`) and self-skips without creds.
- BASED-LANCE-UI is `manual`; the components typecheck and the procedure is documented — the click-through
  and the live agent search demo await the human shell-launch (BASED-SHELL-LAUNCH) and a healthy backend.
- BASED-LANCE-EMBED-COMPUTE (based-side embeddings) is documented future work, not built.
