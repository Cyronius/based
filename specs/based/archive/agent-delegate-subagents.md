# Agent delegation — handing tasks to subagents

**Status:** shipped 2026-07-26. Requirements `BASED-AGENT-DELEGATE`, `BASED-AGENT-DELEGATE-REPORT`,
`BASED-AGENT-DELEGATE-ISOLATION` live in `spec.md` under `## Agent / AI`.

## Problem

Capi's tools return large payloads by design — `describe_table`, `read_table`, `script_object`,
`get_indexes`, `run_query` previews. All of it lands permanently in the tab's Mastra thread memory,
so one exploratory question ("which tables feed the invoice report?") burns context that the rest of
the conversation then carries forever. With `AGENT_MAX_STEPS = 30`, a single run can do thirty rounds
of it.

## What shipped

A `delegate` tool: the parent hands over a task *description*, a child agent spends its own context on
the digging, and only a bounded summary plus structured artifacts come back.

- **`core/src/agent/tools/delegate.ts`** — the two halves of the contract and the caps.
  `delegate({ goal, tasks[1..4] })` on the parent; `report_findings({ summary, artifacts?, confidence? })`
  on the child. `goal` is the schema's first property because the UI labels a collapsed
  `ToolActivityRow` with the first non-empty string argument.
- **`core/src/agent/subagent.ts`** — `createSubagentRunner`, `SUBAGENT_CORE`, the worker pool, and the
  audit decorator. Builds one child `Agent` per task with **no memory** and no parent messages.
- **`ToolDeps.runSubagent?`** — the injection point. Registered in `sharedTools` gated on the dep, and
  `agentSurfaceFor` appends a delegation paragraph to the **briefing** (never the persona) when it is
  present.
- **`server.ts`** — `childDeps` / `toolDeps` split; the runner is constructed per request from the
  already-resolved model, live capabilities, active persona, and profile execution defaults.

### Decisions worth keeping

**Injected runner, not a direct import.** `agent.ts → surface.ts → tools/shared.ts` is one-way; a tool
that reached for `buildAgent` would close it into a cycle. Injection also makes recursion impossible
by absence rather than by a runtime check — the child's deps have no `runSubagent`, so it has no
`delegate` tool. Same shape as every other capability-gated tool on this surface.

**Mastra's native `agents:` delegation was evaluated and rejected.** Mastra 1.51 has it
(`AgentConfig.agents`, `DelegationConfig`, auto sub-thread ids), but: the generated tool is
`agent-<name>` taking a single `prompt`, so there is no fan-out and parallelism depends on the model
emitting parallel tool calls (which local models don't); and the result is either bare `text` or —
with `includeSubAgentToolResultsInModelContext: true` — *every* child tool result verbatim, which is
precisely the bloat this feature exists to avoid. There is no curated middle, and the curated middle
is the feature. What it gives free (sub-thread isolation, result collapsing) is three lines each here.

**`report_findings` rather than `structuredOutput`.** Structured-output mode is unreliable against
local OpenAI-compatible backends and interacts badly with tool loops. It is passed per-call via
`toolsets`, so it never appears on the parent's surface.

**A schema `.max()` is a request; the runner is the guarantee.** First implementation put
`.max(SUBAGENT_SAMPLE_ROWS)` on the report's `sample` array — which made a report with six rows fail
validation *entirely*, losing a real result and falling back to the closing text. The cap now lives
only in the runner's `clampReport`, with the limit stated in the parameter description. `delegate`'s
own `.max(DELEGATE_MAX_TASKS)` is kept, because there rejecting is the right answer.

**The deadline is a race, not just an abort signal.** Aborting asks a provider to stop and a
well-behaved one obliges, but the parent is inside a tool call the user is watching, so it must return
on time even against a backend that ignores the signal. Timeout comes from the profile's existing
`resolveAiTimeouts(...).idleMs` rather than a new constant.

**Concurrency is `DELEGATE_MAX_TASKS`, with no provider-kind special-casing.** The first cut capped
`openai-compatible` at 1 on the assumption that a local backend serializes generation. That is wrong:
LM Studio serves parallel requests and is commonly configured for 4+, so the heuristic throttled
exactly the setup it was meant to help. Against a backend that genuinely serializes, the surplus
requests queue and cost nothing. Parallelism is now the model's choice of task count.

**Audit tagging by SQL comment.** `AuditEntry` has no tag column; `taggedAudit` prefixes
`-- subagent: <name>\n`, which is valid SQL, legible in the History panel, and needs no migration.
Whitespace in the task name is collapsed so it can't break out of the comment line.

## Tests

- `specs/based/tests/unit.delegate.test.ts` (17 tests) — surface presence/absence, briefing, schema
  bounds, fan-out, concurrency peak at 1 vs 3, report composition, no-report fallback, cap
  enforcement, per-task error/timeout independence, report-then-fail, audit tagging.
- `specs/based/tests/unit.surface.test.ts` — `delegate` across all four connection variants in both
  directions.
- `specs/based/tests/integration.agent.test.ts` — a real delegated run against a real LibSQL thread,
  asserting the thread is unchanged and the fan-out is audited.

Models are `MockLanguageModelV4` from `ai/test` (the real providers here are `specificationVersion
"v4"`), driven turn-by-turn. This added `ai` to `specs/package.json` devDependencies.

Suite after: **438 pass / 65 skip / 0 fail**.

## Not done

- Live per-subagent progress in the tool card. `delegate` renders through the default
  `ToolActivityRow`. Mastra's `ToolExecutionContext.writer` would be the hook; nothing in the repo
  uses it yet.
- Nested delegation, and any subagent write path (structurally impossible — mutation and import go
  through frontend approval cards a child cannot reach).
- A "how to decompose work" skill; the tool description and briefing carry the guidance for now.
- Manual verification against a live model — still blocked on a healthy backend.
