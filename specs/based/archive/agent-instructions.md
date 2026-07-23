# Editable agent instruction sets

> **Status: COMPLETE (2026-07-22).** Requirements merged into [../spec.md](../spec.md).
> Verification: `cd specs && bun test` → 102 pass / 10 skip / 0 fail (full suite, including the new
> `integration.agentInstructions` file and the extended `integration.agent` composition tests). Core +
> UI both typecheck clean (`bun run typecheck`).
>
> Parent plan: `~/.claude/plans/the-ai-assistant-needs-adaptive-wombat.md`.

## What shipped

Capi's system prompt (the shared core + each engine's persona) is now user-editable and persisted as
named instruction sets, with the built-in "Default" set locked read-only.

- **Store** ([core/src/agent/instructionsStore.ts](../../../core/src/agent/instructionsStore.ts)): `AgentInstructionsStore` — single-row JSON (`activeId` + `customSets`) over the `agent_instructions` table ([core/src/storage/db.ts](../../../core/src/storage/db.ts)), mirroring `AiConfigStore`/`SettingsStore`. The `"default"` set is virtual — computed live from `GENERIC_CORE`/`MSSQL_PERSONA`/`LANCE_PERSONA`, never persisted, so it can't drift from the code or be edited/deleted.
- **Composition** ([core/src/agent/agent.ts](../../../core/src/agent/agent.ts)): `agentInstructions(core, persona, skillTags)` now takes `core` as an explicit param; `buildAgent` gains optional `core`/`persona` overrides, defaulting to `GENERIC_CORE`/the engine surface's persona when omitted.
- **Endpoints** ([core/src/server.ts](../../../core/src/server.ts)): `GET/POST /api/agent/instructions`, `POST /api/agent/instructions/active`, `DELETE /api/agent/instructions/:id`; `agentStream` resolves the active set per engine before building the agent.
- **UI**: the gear panel next to Ask Capi ([ui/src/components/RightRail.tsx](../../../ui/src/components/RightRail.tsx)) gained an "Agent instructions" section — a set picker plus three collapsible boxes (Core, SQL Server persona, LanceDB persona), disabled when the selected set isn't Default; Duplicate/Save/Delete actions. New API surface in [ui/src/api/client.ts](../../../ui/src/api/client.ts) and types in [ui/src/api/types.ts](../../../ui/src/api/types.ts).

## Requirements
Merged into spec.md: BASED-AGENT-INSTRUCTIONS, BASED-AGENT-INSTRUCTIONS-COMPOSE, BASED-AGENT-INSTRUCTIONS-UI (manual).

## Not exercised
- BASED-AGENT-INSTRUCTIONS-UI is `manual` — the panel is built and typechecks; the click-through procedure (documented in `specs/based/tests/manual.ui.test.ts`) awaits a live shell run to confirm end-to-end (edit → reload → still applied → chat reflects the active set).
