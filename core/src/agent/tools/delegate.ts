// Traces: BASED-AGENT-DELEGATE, BASED-AGENT-DELEGATE-REPORT
//
// Delegation: the parent agent hands a task DESCRIPTION to a child agent, and gets back a bounded
// summary plus structured artifacts. The point is context, not concurrency — every schema dump the
// child pulls (describe_table, read_table, script_object) dies with the child instead of living in
// the tab's thread memory for the rest of the conversation. Fan-out across independent tasks is a
// bonus, and only a real one against a hosted provider: a single local backend serializes anyway.
//
// This module holds the two halves of the contract and nothing else. The runner that actually
// builds and drives a child agent lives in ../subagent.ts, and is INJECTED as ToolDeps.runSubagent
// so this file never imports the agent builder (agent.ts -> surface.ts -> tools/shared.ts is a
// one-way chain, and closing it would be a cycle). That injection is also what prevents recursion:
// the child's ToolDeps omits runSubagent, so `delegate` is simply absent from its surface.
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { ToolDeps } from "./shared";

/** Most tasks one `delegate` call may fan out to. */
export const DELEGATE_MAX_TASKS = 4;

/** Characters of a subagent summary that reach the parent. Truncated by the runner regardless of
 *  what the child sends — an unbounded summary would re-import the bloat we just avoided. */
export const SUBAGENT_SUMMARY_CAP = 4_000;

/** Rows a single artifact may carry back. Artifacts are for pointing at data, not moving it. */
export const SUBAGENT_SAMPLE_ROWS = 5;

/** Step budget for one child run (the parent's own budget is AGENT_MAX_STEPS = 30). */
export const SUBAGENT_MAX_STEPS = 20;

/** Child runs in flight. Set to DELEGATE_MAX_TASKS so a fan-out is never artificially serialized —
 *  how much parallelism there is becomes the model's choice of task count, not a second hidden
 *  limit. Deliberately NOT lowered for local backends: LM Studio serves parallel requests, and
 *  against one that doesn't, the extra requests simply queue rather than costing anything. */
export const SUBAGENT_CONCURRENCY = DELEGATE_MAX_TASKS;

export interface SubagentTask {
  /** Short label, used in the audit trail and in the result the parent reads. */
  name: string;
  /** The whole brief. The child sees no conversation history and no workspace context. */
  instructions: string;
}

/** A handle on something the child found, so the parent can act without seeing the raw data. A
 *  `sql` artifact is the important one: the parent feeds it to show_results and the rows go
 *  straight to a grid, never through anyone's context. */
export interface SubagentArtifact {
  label: string;
  sql?: string;
  objects?: string[];
  sample?: unknown[];
  note?: string;
}

export interface SubagentTrace {
  steps: number;
  /** Tool names the child called, in order, with repeats collapsed to `name xN`. */
  tools: string[];
  ms: number;
}

export interface SubagentResult {
  name: string;
  status: "ok" | "error" | "timeout";
  summary: string;
  artifacts: SubagentArtifact[];
  confidence?: "high" | "medium" | "low";
  trace: SubagentTrace;
  error?: string;
}

/** What ToolDeps.runSubagent must satisfy. `goal` is the parent's one-line framing, prepended to
 *  every task so a child knows what the fan-out is for without seeing its siblings. */
export type SubagentRunner = (goal: string, tasks: SubagentTask[]) => Promise<SubagentResult[]>;

/** The raw shape a child reports through `report_findings`, before the runner applies its caps. */
export interface RawSubagentReport {
  summary: string;
  artifacts?: SubagentArtifact[];
  confidence?: "high" | "medium" | "low";
}

// ---------------------------------------------------------------------------------------------

/** The parent-side tool. `goal` is first and is a string on purpose: the UI labels a collapsed
 *  tool-activity row with the first non-empty string argument, and an array-first schema would
 *  render a blank row for a call that can run for a minute. */
export function delegateTool(deps: ToolDeps) {
  return createTool({
    id: "delegate",
    description: `Hand one or more self-contained investigation tasks to subagents and get back a short summary of each. Use this when answering would mean pulling a lot of schema or data you don't need to keep — a subagent burns its own context on describe_table/read_table/run_query and returns only what matters, so your conversation stays small. Up to ${DELEGATE_MAX_TASKS} tasks per call; independent tasks may run at the same time.

A subagent is on the same connection you are, with the same database tools — but it CANNOT see this conversation, the user's tabs, or any tool result you already have, and it has no show_results, list_tabs, open_query_tab, run_mutation, or import_csv. Write each task's instructions so they stand completely on their own, and restate any fact from the conversation the subagent needs.

Each result comes back as a summary plus optional artifacts. When an artifact carries \`sql\`, that query was actually run and validated — pass it to show_results if the user wants to see the rows, rather than asking a subagent to re-fetch them.

Don't delegate work you could finish in one or two tool calls; the round trip costs more than it saves.`,
    inputSchema: z.object({
      goal: z
        .string()
        .describe("One line: what this fan-out is for. Shown to the user and to every subagent."),
      tasks: z
        .array(
          z.object({
            name: z.string().describe('Short label, e.g. "invoice tables"'),
            instructions: z
              .string()
              .describe(
                "The complete brief for this subagent. It starts with no context beyond the goal — restate anything it needs to know, and say what to report back.",
              ),
          }),
        )
        .min(1)
        .max(DELEGATE_MAX_TASKS)
        .describe("Independent tasks. Split only work that genuinely doesn't depend on itself."),
    }),
    execute: async (args: { goal: string; tasks: SubagentTask[] }) => {
      const run = deps.runSubagent;
      // Unreachable in practice — the tool is only registered when the dep exists — but the surface
      // contract is "absent, never present-and-refusing", so this is a guard, not a policy.
      if (!run) return { error: "Delegation is not available on this connection." };
      const t0 = performance.now();
      try {
        const results = await run(args.goal, args.tasks);
        return { results, totalMs: Math.round(performance.now() - t0) };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  });
}

/** The child-side tool. Reporting through a tool call rather than `structuredOutput` is deliberate:
 *  structured-output mode is fragile against local OpenAI-compatible backends and interacts badly
 *  with tool loops, whereas every model that can use the rest of this surface can call one more
 *  tool. `sink` is per-run, so the runner reads the report even if the child keeps talking after. */
export function reportFindingsTool(sink: (report: RawSubagentReport) => void) {
  return createTool({
    id: "report_findings",
    description: `Report what you found. Call this exactly once, as your LAST action, then stop. Whoever reads this has none of your context and cannot see any tool result you got — the summary is the entire deliverable.

Attach an artifact for anything the reader may want to act on: a \`sql\` query you actually ran and validated (so they can show the rows without re-deriving it), the qualified names of objects you inspected, or a handful of sample rows. Keep samples tiny — at most ${SUBAGENT_SAMPLE_ROWS} rows.`,
    inputSchema: z.object({
      summary: z
        .string()
        .describe("What you found, in prose. Assume the reader has none of your context."),
      artifacts: z
        .array(
          z.object({
            label: z.string().describe("What this artifact is"),
            sql: z.string().optional().describe("A read-only query you actually ran and validated"),
            objects: z.array(z.string()).optional().describe("Qualified names you inspected"),
            // Asks for the limit, does not enforce it: a hard `.max()` here would make the whole
            // report fail validation over one extra row, losing a genuine result. The runner trims
            // instead, which is the only guarantee that matters to the parent's context.
            sample: z
              .array(z.record(z.unknown()))
              .optional()
              .describe(`Representative rows — at most ${SUBAGENT_SAMPLE_ROWS}, which is all that will be kept`),
            note: z.string().optional().describe("Anything the reader needs to interpret it"),
          }),
        )
        .optional()
        .describe("Things the reader can act on without re-doing your work"),
      confidence: z
        .enum(["high", "medium", "low"])
        .optional()
        .describe("How sure you are, given what you were able to inspect"),
    }),
    execute: async (report: RawSubagentReport) => {
      sink(report);
      return { received: true };
    },
  });
}
