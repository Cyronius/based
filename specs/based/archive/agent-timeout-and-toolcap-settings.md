# Agent caps become checkpoints: ask to continue instead of killing the run

## Why the run died at ~10 minutes with no error

It almost certainly was **not** a timeout — it was the tool-step cap.

How `timeoutSeconds` (the "Response timeout" already on the AI profile form) is used today:

- `resolveAiTimeouts(timeoutSeconds)` (core/src/agent/provider.ts:188, mirrored in ui/src/agent/aiTimeouts.ts) → `{ idleMs (default 900 s), runMs = idleMs × 4 (default 60 min) }`.
- Consumed in three places:
  1. **Chat watchdog** (ui/src/components/RightRail.tsx:135–136 → vendored lm-ag-ui): `idleMs` = no-AG-UI-events window (reset by every streamed event), `runMs` = absolute whole-run cap. Either expiry aborts **and shows "The request timed out."** — never silent.
  2. **Cluster labeling one-shot** (core/src/server.ts:582): `AbortSignal.timeout(idleMs)`.
  3. **Subagent runner** (core/src/server.ts:1187): `idleMs` as each child task's wall-clock cap.
- With defaults (15 min idle / 60 min cap) nothing fires at 10 minutes, and a timeout is loud.

What matches the symptom exactly: `AGENT_MAX_STEPS = 30` (core/src/agent/agent.ts:20). Spec BASED-AGENT-MULTISTEP documents it verbatim: a run that exhausts the step budget *"ends tool-calls-last without a summary — accepted residual limitation."* ~30 tool rounds × ~20 s on a local model ≈ 10 min, then `RUN_FINISHED` with no error and no final text.

## Design: neither cap kills — both ask

Both limits become checkpoints that pause and ask the user; "keep going" resets the budget as if from 0. Hard kills remain only as far-out backstops and for subagents (no human in that loop).

### 1. Stall checkpoint (replaces the idle-timeout kill)

- Default `timeoutSeconds` 900 → **120**. Its meaning shifts from "kill after this much silence" to "**ask** after this much silence".
- The vendored library's watchdog behavior (abort + "The request timed out.") is hard-coded inside `useAgent`, so we don't use it for this: pass a large backstop for both `idleTimeoutMs`/`safetyTimeoutMs` (e.g. 6 h — last-resort leak guard for an unattended machine) and implement the stall detector in app code.
- App-side detector in `ChatSession` (ui/src/components/RightRail.tsx): while `isStreaming`, a 2-minute timer resets whenever `agent.messages` / `agent.currentMessage` change (token deltas and tool events both flow through these). On expiry, show an inline prompt in the chat: *"The model has been silent for 2 minutes — keep waiting?"* with **Keep waiting** / **Stop**.
  - Keep waiting → re-arm the window (reset as if 0).
  - Stop → `terminateRun()` (exposed by the vendored hook).
  - Any progress while the prompt is up → auto-dismiss and re-arm.

### 2. Step-cap checkpoint (replaces the silent tool-cap ending)

- New optional per-profile `maxToolSteps` (absent → 30) — see §4.
- Detection in `ChatSession`: run finished without `RUN_ERROR` and the last assistant message has `toolCalls` but no text (the exhausted-budget shape). Show: *"Stopped after N tool calls — keep going?"* with **Keep going** / **Dismiss**.
- Keep going → send a canned continuation turn through the exact send path CapiChat uses (CapiChat.tsx:209–228: `addMessage({role:"user", content:"Continue."})` + `agentClient.startNewRun()` + `agentClient.runAgent(...)`). A fresh run naturally gets a fresh step budget — the "reset as if 0". The continuation appears as a small "Continue" user bubble (honest and simple; a chip-style rendering is optional polish, not in scope).
- Heuristic note: a model that *chose* to end on a tool call is indistinguishable from a capped run — asking "keep going?" is the right response in both cases.

### 3. Timeout resolution changes (both copies: core provider.ts + ui aiTimeouts.ts)

- `DEFAULT_AI_TIMEOUT_SECONDS = 120`.
- `AI_RUN_TIMEOUT_MULTIPLIER` 4 → **15**: `runMs` no longer backs the chat watchdog; it survives as the subagent wall-clock cap (120 s × 15 = 30 min per child task) — switch core/src/server.ts:1187 from `.idleMs` to `.runMs`, since 2 min would strangle any multi-round child and no user can be asked mid-tool.
- Cluster labeling keeps `AbortSignal.timeout(idleMs)` (2 min for a one-shot call is right).

### 4. Tool cap becomes a per-profile setting

- core/src/storage/aiProfiles.ts — `maxToolSteps?: number`, same persistence/clear-on-resave semantics as `timeoutSeconds`.
- core/src/agent/agent.ts — `buildAgent` accepts `maxSteps?: number`, default `AGENT_MAX_STEPS` (30).
- core/src/server.ts — chat handler passes `profile.maxToolSteps`. Subagents keep `SUBAGENT_MAX_STEPS`.
- ui/src/api/types.ts — add the field to the duplicated shape.
- ui/src/components/ThemePicker.tsx (`AiProfileForm`) — "Tool call limit" number field next to "Response timeout (seconds)", same edited-as-text pattern; blank = default 30 in the placeholder.

## Spec impact

**Modified:**
- `BASED-AI-PROFILE-TIMEOUT` — default 120; multiplier 15; semantics: idle window drives the app-side stall *prompt*, not a kill; library watchdog demoted to a large backstop; subagent runner consumes `runMs`. Acceptance criteria updated (`resolveAiTimeouts(1800)` → `runMs: 1_800_000 × 15`, etc.); the "run aborts with The request timed out" manual procedure is replaced by the keep-waiting prompt procedure.
- `BASED-AGENT-MULTISTEP` — step budget becomes profile-overridable (default 30); the "accepted residual limitation" sentence is removed in favor of the continue prompt.

**New:**
- `BASED-AI-PROFILE-STEPCAP` (unit + integration + manual): per-profile `maxToolSteps` — resolution (absent/invalid → 30), API round-trip + clear-on-resave, `buildAgent` default-options assertion with an override, profile-form field.
- `BASED-AGENT-CONTINUE-PROMPT` (e2e/manual): the two checkpoint prompts — stall → Keep waiting / Stop; capped run → Keep going sends a continuation with a fresh budget. Documented procedure, no executable test (browser + streaming behavior).

## Tests

- specs/based/tests/unit.provider.test.ts — update default/multiplier expectations (red first).
- specs/based/tests/integration.agent.test.ts — `maxToolSteps` round-trip + clear-on-resave (mirror the `timeoutSeconds` test at line 181).
- Unit: `buildAgent({maxSteps: 60})` → resolved default options 60; omitted → 30.
- Manual procedures (in the spec + test file per doctrine):
  - Tool cap 2 on the active profile → schema-audit question → "keep going?" prompt; Keep going → run continues and finishes with a summary.
  - Response timeout 10 s → question a slow model can't start answering in time → keep-waiting prompt; Keep waiting → answer eventually arrives; Stop → run aborts.

## Out of scope

- In-flight uncommitted work (core/src/agent/tools/shared.ts, spec.md edits, unit.describeTable.test.ts) — untouched.
- No server-side abort path for the main chat run — unchanged (Stop remains a client-side disconnect; the server run drains into a closed stream as today).
- Chip-style rendering of the "Continue." bubble; asking on the 6 h backstop expiry.
