// Traces: BASED-AGENT-DELEGATE, BASED-AGENT-DELEGATE-REPORT, BASED-AGENT-DELEGATE-ISOLATION
//
// Drives the child agents behind the `delegate` tool. Lives outside tools/ on purpose: it imports
// buildAgent, and tools/ is downstream of it (agent.ts -> surface.ts -> tools/shared.ts), so a tool
// that reached for the builder directly would close that chain into a cycle. Instead the runner is
// built here and injected as ToolDeps.runSubagent — which is also what makes recursion impossible,
// since the deps handed to a child have no runSubagent and therefore no `delegate` tool.
//
// Isolation is the whole point, so it is enforced structurally rather than by prompt:
//   - no memory, so nothing a child does is written to the tab's thread;
//   - no parent messages, so a child starts from the goal and its own brief and nothing else;
//   - only the report crosses back, capped, so a 40k-token schema crawl returns a few hundred.
//
// Mastra's native `agents:` delegation was evaluated and not used: its generated tool takes one
// prompt (no fan-out), and its result is either bare text or — with
// includeSubAgentToolResultsInModelContext — every child tool result verbatim, which is exactly the
// bloat this exists to avoid. There is no curated middle, and a curated middle is the feature.
import type { LanguageModel } from "ai";
import type { EngineCapabilities } from "../db/types";
import type { AuditSink } from "./audit";
import { buildAgent } from "./agent";
import { auditRead, type ToolDeps } from "./tools/shared";
import type { ExecutionDefaults } from "./provider";
import {
  reportFindingsTool,
  SUBAGENT_MAX_STEPS,
  SUBAGENT_SAMPLE_ROWS,
  SUBAGENT_SUMMARY_CAP,
  type RawSubagentReport,
  type SubagentArtifact,
  type SubagentResult,
  type SubagentRunner,
  type SubagentTask,
} from "./tools/delegate";

/** The child's engine-neutral core. Not Capi's: a subagent has no user, no rail, no tab strip, and
 *  no voice to keep. Everything that varies by connection still reaches it the normal way — the
 *  engine persona and the generated capability briefing are composed in by buildAgent — so a child
 *  can never learn a different story about the connection than its parent has. */
export const SUBAGENT_CORE = `You are a research subagent working inside a database client. A coordinating agent has handed you one self-contained task; you do the digging and report back.

What is true of your situation:
- You are on the same database connection as the coordinator, with the same database tools.
- You cannot see the conversation that produced this task, the user's open tabs, or any earlier tool result. Your brief is all the context there is. If it is ambiguous, investigate the most reasonable reading and say in your report which one you took.
- You have no way to show anything to the user, open a tab, write data, or ask a question. Do not offer to.
- Nobody reads your intermediate output. Only your report_findings call reaches the coordinator.

How to work:
- Investigate freely — this is what you are for. Read as much schema and as many samples as the task needs; that cost is yours to spend and it does not follow you home.
- Work from the real schema. Never assert a table or column you have not inspected.
- Finish by calling report_findings exactly once, then stop. Write the summary for someone who has none of your context: state findings, not the path you took to them. Attach a validated query as an artifact when the coordinator may want to show the rows — that saves the work being redone.
- If the task turns out to be impossible or the objects don't exist, report that plainly. A clear negative is a useful result; a guess is not.`;

export interface SubagentRunnerOptions {
  model: LanguageModel;
  /** The live adapter's capabilities — the child's surface is generated from the same facts. */
  capabilities: EngineCapabilities;
  /** Deps for the CHILD. Must not carry runSubagent; this strips it regardless. */
  toolDeps: ToolDeps;
  /** The engine persona the parent is running, so voice/policy stays consistent. */
  persona?: string;
  executionDefaults?: ExecutionDefaults;
  /** Per-task wall-clock limit. Nothing else stops a runaway child: the agent stream has no
   *  server-side abort path, so this signal is the only backstop. */
  timeoutMs: number;
  /** Child runs in flight. 1 on a local backend, which serializes generation anyway. */
  concurrency: number;
  maxSteps?: number;
}

/** Tag every statement a subagent causes, so the History panel shows who ran what. AuditEntry has
 *  no tag column and a leading SQL comment is both valid and legible, which beats a migration. */
export function taggedAudit(inner: AuditSink, taskName: string): AuditSink {
  const label = taskName.replace(/\s+/g, " ").trim().slice(0, 60);
  return {
    add: (entry) => inner.add({ ...entry, sql: `-- subagent: ${label}\n${entry.sql}` }),
    list: (connectionId, limit) => inner.list(connectionId, limit),
  };
}

/** Run `work` over `items` with at most `limit` in flight. Same shape as the reranker's pool. */
async function pool<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await work(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Collapse a call sequence into `name xN` runs, so a 20-step trace stays one short line. */
function summarizeTools(names: string[]): string[] {
  const out: string[] = [];
  for (const name of names) {
    const prev = out[out.length - 1];
    if (prev === name) out[out.length - 1] = `${name} x2`;
    else if (prev?.startsWith(`${name} x`)) out[out.length - 1] = `${name} x${Number(prev.slice(name.length + 2)) + 1}`;
    else out.push(name);
  }
  return out;
}

/** Apply the caps to whatever the child reported. Done here, not in the tool's schema, because the
 *  schema is a request and this is the guarantee — a model that ignores `max` still can't blow up
 *  the parent's context. */
function clampReport(report: RawSubagentReport): Pick<SubagentResult, "summary" | "artifacts" | "confidence"> {
  const artifacts: SubagentArtifact[] = (report.artifacts ?? []).map((a) => ({
    ...a,
    ...(a.sample ? { sample: a.sample.slice(0, SUBAGENT_SAMPLE_ROWS) } : {}),
  }));
  return {
    summary: (report.summary ?? "").slice(0, SUBAGENT_SUMMARY_CAP),
    artifacts,
    ...(report.confidence ? { confidence: report.confidence } : {}),
  };
}

/** Build the runner injected as ToolDeps.runSubagent. Everything it needs — the resolved model, the
 *  live capabilities, the active persona, the profile's execution defaults and timeout — is
 *  resolved once per request by the caller, exactly as the parent agent's own build is. */
export function createSubagentRunner(opts: SubagentRunnerOptions): SubagentRunner {
  const { runSubagent: _noRecursion, ...baseDeps } = opts.toolDeps;
  const maxSteps = opts.maxSteps ?? SUBAGENT_MAX_STEPS;

  async function runOne(goal: string, task: SubagentTask): Promise<SubagentResult> {
    const t0 = performance.now();
    let reported: RawSubagentReport | null = null;
    const deps: ToolDeps = { ...baseDeps, audit: taggedAudit(opts.toolDeps.audit, task.name) };
    const agent = buildAgent({
      model: opts.model,
      capabilities: opts.capabilities,
      toolDeps: deps,
      core: SUBAGENT_CORE,
      persona: opts.persona,
      executionDefaults: opts.executionDefaults,
    });
    const prompt = `Goal of the overall request: ${goal}\n\nYour task — ${task.name}:\n${task.instructions}`;
    // The deadline is enforced by racing, not just by the abort signal. Aborting asks the model
    // call to stop and a well-behaved provider obliges, but the parent is inside a tool call the
    // user is watching: it must come back on time even against a backend that ignores the signal.
    let timedOut = false;
    const controller = new AbortController();
    let fire!: () => void;
    const deadline = new Promise<never>((_, reject) => {
      fire = () => {
        timedOut = true;
        controller.abort();
        reject(new Error(`Timed out after ${Math.round(opts.timeoutMs / 1000)}s`));
      };
    });
    const timer = setTimeout(fire, opts.timeoutMs);
    try {
      const result = await Promise.race([
        agent.generate(prompt, {
          maxSteps,
          abortSignal: controller.signal,
          // Per-call toolset rather than a surface change: report_findings belongs to the delegation
          // protocol, not to the connection, and must never appear on the parent's surface.
          toolsets: { delegation: { report_findings: reportFindingsTool((r) => (reported = r)) } } as never,
        }),
        deadline,
      ]);
      const calls = (result.toolCalls ?? []) as Array<{ payload?: { toolName?: string } }>;
      const trace = {
        steps: result.steps?.length ?? 0,
        tools: summarizeTools(calls.map((c) => c.payload?.toolName).filter((n): n is string => !!n)),
        ms: Math.round(performance.now() - t0),
      };
      // A child that never reports still did the work — fall back to its closing text rather than
      // throwing away the run. Artifacts are the part that needs the explicit call.
      const report: RawSubagentReport = reported ?? { summary: result.text ?? "" };
      return { name: task.name, status: "ok", ...clampReport(report), trace };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        name: task.name,
        status: timedOut ? "timeout" : "error",
        // A child that reported and then failed still has something worth handing up.
        ...clampReport(reported ?? { summary: "" }),
        trace: { steps: 0, tools: [], ms: Math.round(performance.now() - t0) },
        error: msg,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  return async (goal, tasks) => {
    const t0 = performance.now();
    const results = await pool(tasks, opts.concurrency, (task) => runOne(goal, task));
    const failed = results.filter((r) => r.status !== "ok");
    auditRead(
      opts.toolDeps,
      `delegate(${goal.replace(/\s+/g, " ").trim().slice(0, 120)}, ${tasks.length} task(s))`,
      failed.length === results.length ? "error" : "ok",
      Math.round(performance.now() - t0),
      failed.length ? failed.map((r) => `${r.name}: ${r.error ?? r.status}`).join("; ") : null,
    );
    return results;
  };
}
