# Phase 3 — workstreams A (table browse+edit) & C (skills/diagrams)

> **Status: COMPLETE (2026-07-22).** Requirements merged into [../spec.md](../spec.md).
> Verification: `cd specs && bun test` → 68 pass / 9 skip / 0 fail. New: `unit.tableEdit` (8),
> `unit.skills` (3), `BASED-SKILL-LOAD` in `integration.agent` (always-run), and live Azure SQL
> dev-DB runs of `BASED-TABLE-BROWSE` + `BASED-TABLE-COMMIT` (adapter transaction in
> `integration.mssql`, endpoint+history in `integration.server`) against self-created/dropped scratch
> tables (self-skip without CREATE TABLE permission — permission was present, so they ran). Core + UI
> both typecheck clean.
>
> Parent plan: [../../../.claude/plans/phase3-daily-driver.md](../../../.claude/plans/phase3-daily-driver.md)
> (workstreams B/D/E remain in that plan, gated on their human-in-the-loop steps).

## What shipped

### A — Table data browse + edit
- **Adapter interface** ([core/src/db/types.ts](../../../core/src/db/types.ts)): `DbCommand`/`CommandResult`/`TablePage`; `DatabaseAdapter.readTablePage()` + `runCommands()`.
- **MssqlAdapter** ([core/src/db/mssqlAdapter.ts](../../../core/src/db/mssqlAdapter.ts)): `readTablePage` (PK-ordered `OFFSET…FETCH`, row-cap-bounded) and `runCommands` (single `sql.Transaction`, all-or-nothing, rollback on error, JS-value type inference — NULL binds as NVarChar).
- **Pure builder** ([core/src/db/tableEdit.ts](../../../core/src/db/tableEdit.ts)): `buildEditCommands` — parameterized, bracket-quoted, identifier-validated; PK required for update/delete.
- **Server** ([core/src/server.ts](../../../core/src/server.ts)): `GET /api/session/table-data`, `POST /api/session/table-edit` (with `preview` flag; build-failure → 400; commit records a history row).
- **UI**: `store.setTableView` + `TableTabState.view`; new [TableDataGrid.tsx](../../../ui/src/components/TableDataGrid.tsx) (editable glide grid, paging, add/delete row, pending indicator, Review SQL peek, Commit/Discard); [TableDetailsView.tsx](../../../ui/src/components/TableDetailsView.tsx) hosts the Details/Data toggle; client + wire types.

### C — Skill framework + diagrams skill
- **Registry** ([core/src/agent/skills/](../../../core/src/agent/skills/)): `types.ts`, `registry.ts` (`list`/`catalog`/`get`), `diagrams.ts` (skill #1), `index.ts`.
- **Tool** ([core/src/agent/tools.ts](../../../core/src/agent/tools.ts)): `load_skill` (progressive disclosure; unknown name → valid-name list, no throw).
- **Prompt** ([core/src/agent/agent.ts](../../../core/src/agent/agent.ts)): `agentInstructions()` composes base rules + the skill catalog (name+desc only) + load-a-skill-first protocol. Mermaid already renders in the rail ([MarginChat.tsx](../../../ui/src/components/MarginChat.tsx)).

## Requirements
Merged into spec.md: BASED-TABLE-BROWSE, BASED-TABLE-DML, BASED-TABLE-COMMIT, BASED-UI-TABLE-EDIT (manual), BASED-SKILL-REGISTRY, BASED-SKILL-LOAD, BASED-DIAGRAM-RENDER (manual).

## Not exercised (same backend gate as Phase 2)
- BASED-DIAGRAM-RENDER live demo (agent emits a mermaid chart) still waits on a healthy model backend.
- BASED-UI-TABLE-EDIT is `manual` — the grid is built and typechecks; the click-through procedure in spec.md awaits the human shell-launch validation (BASED-SHELL-LAUNCH, workstream E).
