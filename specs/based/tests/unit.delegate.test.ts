// Traces: BASED-AGENT-DELEGATE, BASED-AGENT-DELEGATE-REPORT
//
// Delegation exists to protect the parent's context, so what these tests actually guard is the
// boundary: what crosses back from a child, and what a child can reach. Two rules matter most and
// neither is enforced by prose at runtime —
//
//  1. A subagent has no `delegate` tool, because the deps it is built from have no runSubagent.
//     Recursion is prevented by absence, in the same way a missing capability removes a tool rather
//     than leaving one that refuses.
//  2. The caps on what comes back are the RUNNER's, not the schema's. `.max()` in an input schema is
//     a request to a language model; a model that ignores it must still not be able to push 40k of
//     schema dump into the conversation it was supposed to keep out.
//
// The model here is a MockLanguageModelV4 (the real providers in this repo are `specificationVersion
// "v4"`), driven turn-by-turn so a run can be made to report, stay silent, fail, or hang on demand.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV4 } from "ai/test";
import {
  agentSurfaceFor,
  AuditStore,
  createSubagentRunner,
  defaultCapabilitiesFor,
  DELEGATE_MAX_TASKS,
  openDb,
  SUBAGENT_SAMPLE_ROWS,
  SUBAGENT_SUMMARY_CAP,
  taggedAudit,
  type SubagentResult,
  type SubagentRunner,
  type SubagentTask,
  type ToolDeps,
} from "@based/core";

const MSSQL = defaultCapabilitiesFor("mssql");
const LANCE = defaultCapabilitiesFor("lancedb");

function freshAudit(): AuditStore {
  return new AuditStore(openDb(join(mkdtempSync(join(tmpdir(), "based-delegate-")), "app.db")));
}

/** Deps with no adapter: nothing here may touch the database. */
function deps(extra?: Partial<ToolDeps>): ToolDeps {
  return {
    getAdapter: () => {
      throw new Error("delegate tests must not touch the adapter");
    },
    connectionId: () => "c",
    database: () => "d",
    audit: freshAudit(),
    ...extra,
  };
}

/** A runner that records its calls and returns a canned result per task. */
function stubRunner(): SubagentRunner & { calls: Array<{ goal: string; tasks: SubagentTask[] }> } {
  const calls: Array<{ goal: string; tasks: SubagentTask[] }> = [];
  const fn = (async (goal, tasks) => {
    calls.push({ goal, tasks });
    return tasks.map<SubagentResult>((t) => ({
      name: t.name,
      status: "ok",
      summary: `summary for ${t.name}`,
      artifacts: [],
      trace: { steps: 1, tools: [], ms: 1 },
    }));
  }) as SubagentRunner & { calls: typeof calls };
  fn.calls = calls;
  return fn;
}

/** One `doGenerate` reply per turn; the last is reused if the loop runs longer. */
function scriptedModel(turns: Array<() => unknown>) {
  let i = 0;
  return new MockLanguageModelV4({
    doGenerate: async () => {
      const turn = turns[Math.min(i++, turns.length - 1)]!;
      return turn() as never;
    },
  }) as never;
}

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

function saysText(text: string) {
  return () => ({ content: [{ type: "text", text }], finishReason: "stop", usage, warnings: [] });
}

function callsReport(args: unknown) {
  return () => ({
    content: [{ type: "tool-call", toolCallId: `tc-${Math.random()}`, toolName: "report_findings", input: JSON.stringify(args) }],
    finishReason: "tool-calls",
    usage,
    warnings: [],
  });
}

function throws(message: string) {
  return () => {
    throw new Error(message);
  };
}

function runnerFor(model: never, extra?: Partial<Parameters<typeof createSubagentRunner>[0]>) {
  return createSubagentRunner({
    model,
    capabilities: MSSQL,
    toolDeps: deps(),
    timeoutMs: 10_000,
    concurrency: 1,
    ...extra,
  });
}

describe("BASED-AGENT-DELEGATE: the tool is a property of the run, not the connection", () => {
  test("present on every engine when runSubagent is supplied", () => {
    for (const caps of [MSSQL, LANCE]) {
      const tools = agentSurfaceFor(caps, deps({ runSubagent: stubRunner() })).tools;
      expect(Object.keys(tools)).toContain("delegate");
    }
  });

  test("absent — not present-and-refusing — when it is not", () => {
    for (const caps of [MSSQL, LANCE]) {
      const tools = agentSurfaceFor(caps, deps()).tools;
      expect(Object.keys(tools)).not.toContain("delegate");
    }
  });

  test("report_findings never leaks onto the parent's surface", () => {
    const tools = agentSurfaceFor(MSSQL, deps({ runSubagent: stubRunner() })).tools;
    expect(Object.keys(tools)).not.toContain("report_findings");
  });

  test("the briefing gains the delegation paragraph only when delegation is available", () => {
    const withIt = agentSurfaceFor(MSSQL, deps({ runSubagent: stubRunner() })).briefing;
    const without = agentSurfaceFor(MSSQL, deps()).briefing;
    expect(withIt).toContain("delegate tool");
    expect(without).not.toContain("delegate tool");
    // The paragraph is additive: nothing the connection says about itself is displaced.
    expect(withIt.startsWith(without)).toBe(true);
  });
});

describe("BASED-AGENT-DELEGATE: fan-out", () => {
  test("passes the goal and every task to the runner, and returns the results", async () => {
    const runner = stubRunner();
    const tools = agentSurfaceFor(MSSQL, deps({ runSubagent: runner })).tools as Record<string, any>;
    const out = await tools.delegate.execute(
      {
        goal: "map the invoice pipeline",
        tasks: [
          { name: "tables", instructions: "find the tables" },
          { name: "procs", instructions: "find the procs" },
        ],
      },
      {} as never,
    );
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]!.goal).toBe("map the invoice pipeline");
    expect(runner.calls[0]!.tasks.map((t) => t.name)).toEqual(["tables", "procs"]);
    expect(out.results.map((r: SubagentResult) => r.summary)).toEqual([
      "summary for tables",
      "summary for procs",
    ]);
    expect(typeof out.totalMs).toBe("number");
  });

  test("the schema bounds the fan-out at both ends", () => {
    const tools = agentSurfaceFor(MSSQL, deps({ runSubagent: stubRunner() })).tools as Record<string, any>;
    const schema = tools.delegate.inputSchema;
    const task = { name: "t", instructions: "do it" };
    expect(schema.safeParse({ goal: "g", tasks: [] }).success).toBe(false);
    expect(schema.safeParse({ goal: "g", tasks: Array(DELEGATE_MAX_TASKS).fill(task) }).success).toBe(true);
    expect(schema.safeParse({ goal: "g", tasks: Array(DELEGATE_MAX_TASKS + 1).fill(task) }).success).toBe(false);
  });

  test("a subagent cannot delegate — observed from inside the child's own run", async () => {
    // The model sees exactly the toolset the child was built with, so this is the real surface,
    // not a re-derivation of it. The runner is handed deps that DO carry a runner, to prove the
    // stripping happens in the runner rather than at the call site.
    let offered: string[] = [];
    const model = new MockLanguageModelV4({
      doGenerate: async (options: { tools?: Array<{ name: string }> }) => {
        offered = (options.tools ?? []).map((t) => t.name);
        return saysText("done")() as never;
      },
    }) as never;
    const runner = createSubagentRunner({
      model,
      capabilities: MSSQL,
      toolDeps: { ...deps(), runSubagent: stubRunner() },
      timeoutMs: 10_000,
      concurrency: 1,
    });
    await runner("g", [{ name: "t", instructions: "i" }]);
    expect(offered).not.toContain("delegate");
    // …but it does get the rest of the connection's surface, plus the way to report back.
    expect(offered).toContain("describe_table");
    expect(offered).toContain("report_findings");
  });

  test("concurrency 1 never overlaps; concurrency 3 does", async () => {
    for (const [concurrency, expectedPeak] of [
      [1, 1],
      [3, 3],
    ] as const) {
      let inFlight = 0;
      let peak = 0;
      const model = new MockLanguageModelV4({
        doGenerate: async () => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await new Promise((r) => setTimeout(r, 30));
          inFlight--;
          return saysText("ok")() as never;
        },
      }) as never;
      const runner = runnerFor(model, { concurrency });
      const results = await runner(
        "g",
        Array.from({ length: 3 }, (_, i) => ({ name: `t${i}`, instructions: "i" })),
      );
      expect(results).toHaveLength(3);
      expect(peak).toBe(expectedPeak);
    }
  });
});

describe("BASED-AGENT-DELEGATE-REPORT: what crosses back", () => {
  test("a report becomes the result", async () => {
    const runner = runnerFor(
      scriptedModel([
        callsReport({
          summary: "three tables feed it",
          artifacts: [{ label: "the query", sql: "SELECT 1", objects: ["dbo.Invoice"] }],
          confidence: "high",
        }),
        saysText("reported"),
      ]),
    );
    const [result] = await runner("g", [{ name: "invoices", instructions: "look" }]);
    expect(result!.status).toBe("ok");
    expect(result!.name).toBe("invoices");
    expect(result!.summary).toBe("three tables feed it");
    expect(result!.confidence).toBe("high");
    expect(result!.artifacts).toEqual([
      { label: "the query", sql: "SELECT 1", objects: ["dbo.Invoice"] },
    ]);
    expect(result!.trace.tools).toContain("report_findings");
  });

  test("a run that never reports falls back to its closing text", async () => {
    const runner = runnerFor(scriptedModel([saysText("I looked and found nothing unusual.")]));
    const [result] = await runner("g", [{ name: "t", instructions: "i" }]);
    expect(result!.status).toBe("ok");
    expect(result!.summary).toBe("I looked and found nothing unusual.");
    expect(result!.artifacts).toEqual([]);
  });

  test("the runner enforces the caps the schema only asks for", async () => {
    const runner = runnerFor(
      scriptedModel([
        callsReport({
          summary: "x".repeat(SUBAGENT_SUMMARY_CAP + 500),
          artifacts: [
            {
              label: "too many rows",
              sample: Array.from({ length: SUBAGENT_SAMPLE_ROWS + 7 }, (_, i) => ({ i })),
            },
          ],
        }),
        saysText("done"),
      ]),
    );
    const [result] = await runner("g", [{ name: "t", instructions: "i" }]);
    expect(result!.summary).toHaveLength(SUBAGENT_SUMMARY_CAP);
    expect(result!.artifacts[0]!.sample).toHaveLength(SUBAGENT_SAMPLE_ROWS);
  });

  test("a failing task is a value, and its siblings still succeed", async () => {
    let seen = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        // First task through the (serial) pool blows up; the rest answer normally.
        if (seen++ === 0) throw new Error("model exploded");
        return saysText("fine")() as never;
      },
    }) as never;
    const results = await runnerFor(model)("g", [
      { name: "bad", instructions: "i" },
      { name: "good", instructions: "i" },
    ]);
    expect(results[0]!.status).toBe("error");
    expect(results[0]!.error).toContain("model exploded");
    expect(results[1]!.status).toBe("ok");
    expect(results[1]!.summary).toBe("fine");
  });

  test("a run that outlives its deadline comes back as a timeout, not a hang", async () => {
    const model = new MockLanguageModelV4({
      // Never settles: the point is that the runner returns anyway.
      doGenerate: () => new Promise<never>(() => {}),
    }) as never;
    const [result] = await runnerFor(model, { timeoutMs: 120 })("g", [{ name: "t", instructions: "i" }]);
    expect(result!.status).toBe("timeout");
    expect(result!.error).toContain("Timed out");
  });

  test("a child that reported and then failed still hands its summary up", async () => {
    const runner = runnerFor(
      scriptedModel([
        callsReport({ summary: "partial but real" }),
        throws("died on the way home"),
      ]),
    );
    const [result] = await runner("g", [{ name: "t", instructions: "i" }]);
    expect(result!.status).toBe("error");
    expect(result!.summary).toBe("partial but real");
  });
});

describe("BASED-AGENT-DELEGATE-ISOLATION: the audit trail names the subagent", () => {
  test("the fan-out itself is audited, with the failure detail when every task failed", async () => {
    const audit = freshAudit();
    const runner = createSubagentRunner({
      model: scriptedModel([throws("nope")]),
      capabilities: MSSQL,
      toolDeps: deps({ audit }),
      timeoutMs: 5_000,
      concurrency: 1,
    });
    await runner("map the pipeline", [{ name: "t", instructions: "i" }]);
    const [entry] = audit.list("c");
    expect(entry!.sql).toBe("delegate(map the pipeline, 1 task(s))");
    expect(entry!.kind).toBe("read");
    expect(entry!.status).toBe("error");
    expect(entry!.error).toContain("t: ");
  });

  test("a subagent's statements are tagged with its task name, and stay valid SQL", () => {
    // taggedAudit is what a child's tools write through — the same decorator the runner installs.
    const audit = freshAudit();
    const sink = taggedAudit(audit, "invoice tables");
    sink.add({
      connectionId: "c",
      database: "d",
      kind: "read",
      sql: "SELECT TOP 1 * FROM dbo.Invoice",
      approved: false,
      startedAt: new Date().toISOString(),
      durationMs: 4,
      status: "ok",
      error: null,
    });
    const [entry] = audit.list("c");
    expect(entry!.sql).toBe("-- subagent: invoice tables\nSELECT TOP 1 * FROM dbo.Invoice");
    // A comment, not a marker column: the History panel shows the statement as-is and it still runs.
    expect(entry!.sql.split("\n")[0]!.startsWith("--")).toBe(true);
    expect(entry!.connectionId).toBe("c");
  });

  test("a wild task name cannot break out of the comment line", () => {
    const audit = freshAudit();
    taggedAudit(audit, "drop\nthe\ttables").add({
      connectionId: "c",
      database: "d",
      kind: "read",
      sql: "SELECT 1",
      approved: false,
      startedAt: new Date().toISOString(),
      durationMs: 1,
      status: "ok",
      error: null,
    });
    const lines = audit.list("c")[0]!.sql.split("\n");
    expect(lines[0]).toBe("-- subagent: drop the tables");
    expect(lines[1]).toBe("SELECT 1");
  });
});
