# Plan: LanceDB create table / database + agent proposal tool

## Spec impact

**New requirements:**
- `BASED-LANCE-CREATE-TABLE` — adapter `createTable`, `createTable` capability, structural schema builder, cache invalidation (unit + integration)
- `BASED-LANCE-CREATE-TABLE-UI` — New Table dialog + explorer / connection-menu entry points (manual)
- `BASED-AGENT-LANCE-CREATE` — `create_table` proposal tool + approval card + gated `/api/agent/create-table` endpoint + audit (unit + integration)

**Modified requirements:**
- `BASED-LANCE-CONNECT` — a truly empty local directory now connects as an empty single-db database (bootstrap for "create a brand-new database from nothing") instead of erroring
- `BASED-AGENT-MUTATION-GATE` — the "future LanceDB write surface" design note now points at `BASED-AGENT-LANCE-CREATE` as its first realization

## Design decisions (research findings)

- **No new dependency.** `@lancedb/lancedb@0.24.1`'s `createEmptyTable(name, schema)` accepts a *structural* `SchemaLike` (`{fields: [{name, type, nullable}]}`); scalar types as strings (`utf8`, `int64`, `float64`, `bool`, `datemillisecond`), vectors as `{typeId: 16 /*FixedSizeList*/, listSize: dim, children: [{name: "item", type: "float32", nullable: true}]}` — verified against `dist/sanitize.js` and smoke-tested. Mirrors the adapter's existing no-arrow-import doctrine (`vectorInfo`). Timestamps have no string name in this SDK version → the builder maps `date` to `datemillisecond`.
- **`createEmptyTable`, never seed rows.** Row inference maps every JS number to Float64, errors on `Date`, and needs vector-name heuristics; with no delete in this build, a junk seed row would be permanent. Default `mode: "create"` so an existing name errors (never `overwrite`).
- **Narrow `createTable` capability, not `write`.** Flipping `write` would switch on `run_mutation`/`import_csv`/grid-edit, none of which Lance can honour. `filterToolsByCapabilities` becomes a per-tool required-capability map.
- **Cloud stays off in v1** (`createTable: !isCloud()`) — the SDK supports it, but it is untestable here; flipping later is one line.
- **Cache invalidation:** update `baseFolderDbs` after create; close + null the DuckDB `LanceSqlBridge` so the next SQL/LSP call re-attaches (a new folder needs a new ATTACH). Other windows' sessions keep a stale explorer snapshot until reconnect — accepted, noted in the spec.
- **Concurrency:** Lance local commits are optimistic; a concurrent create surfaces as an SDK commit-conflict error passed through verbatim. `mode: "create"` avoids overwrite-while-attached (our DuckDB bridge holds files open on Windows).
- **Writes go through the frontend proposal-tool pattern** (approval card + server re-check), per BASED-AGENT-MUTATION-GATE's three layers. No backend Mastra write tool.

## Implementation

1. `core/src/db/lanceSchema.ts` (new): `LanceColumnSpec` → structural `SchemaLike`; validation (unique identifier names, vector dim 1–8192).
2. `core/src/db/types.ts`: `createTable` on `EngineCapabilities` (all five definition sites updated), optional `createTable?(spec)` on `DatabaseAdapter`; mirror in `ui/src/api/types.ts`.
3. `core/src/db/lanceAdapter.ts`: `createTable({name, folder?, columns})` (existing folder, new subfolder, or single-db root); empty-dir bootstrap in `connect()`.
4. `core/src/server.ts`: `POST /api/session/create-table` (dialog path) and `POST /api/agent/create-table` (`approved === true` **and** `capabilities.createTable`, audit row).
5. `ui/src/agent/capiToolDefs.ts` + `capiTools.tsx`: `create_table` def, per-tool capability map, `CreateTableApprovalCard`.
6. `core/src/agent/tools/lancedb.ts`: briefing line when `caps.createTable`.
7. `ui/src/components/NewTableDialog.tsx` (new) + entry points: "+ New table" in the explorer Tables header, "New table…" in a connection context menu (LeftRail).
8. Tests: `unit.lanceSchema.test.ts` (new), `unit.capiTools.test.ts`, `unit.surface.test.ts`, `integration.lancedb.test.ts`, `integration.server.test.ts`.
