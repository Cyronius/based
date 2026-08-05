// Traces: BASED-AGENT-CONTEXT-RECOVERY
//
// The failure this exists for: a query against a table with a 21K-character text column put ~1.5M
// tokens into a 262K-token window, the provider rejected it, and the run died. Worse, the oversized
// tool result had already been written to the thread — so the next turn replayed it and died the
// same way. A one-row follow-up query could not get through. The conversation was unusable until it
// was thrown away.
//
// So the test that matters is the whole loop, not the matcher: a run whose model rejects the
// request mid-conversation must shed the payload it choked on and finish, and what it sends on the
// retry must actually be smaller. The MockLanguageModelV4 here IS the provider, so "the request got
// smaller" is observed on the wire rather than inferred.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV4 } from "ai/test";
import {
  AuditStore,
  buildAgent,
  contextRecoveryProcessor,
  defaultCapabilitiesFor,
  isContextOverflowError,
  openDb,
  shedLargestToolResult,
  SHED_TOOL_RESULT_NOTE,
  type DatabaseAdapter,
  type ToolDeps,
} from "@based/core";

const MSSQL = defaultCapabilitiesFor("mssql");
const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

/** The exact 400 LM Studio returns when the prompt overruns the loaded model's context. */
const LM_STUDIO_400 = `Engine protocol predict request returned 400: {"error":{"code":400,"message":"request (1536114 tokens) exceeds the available context size (262144 tokens), try increasing it","type":"exceed_context_size_error","n_prompt_tokens":1536114,"n_ctx":262144}}`;

function freshAudit(): AuditStore {
  return new AuditStore(openDb(join(mkdtempSync(join(tmpdir(), "based-ctxrec-")), "app.db")));
}

/** An adapter whose only table is the shape that caused the outage: an id and a conversation log. */
function wideTableAdapter(): DatabaseAdapter {
  return {
    capabilities: MSSQL,
    readTablePage: async () => ({
      columns: [
        { name: "sessionId", type: "int", nullable: false },
        { name: "runs", type: "nvarchar(max)", nullable: true },
      ],
      rows: Array.from({ length: 100 }, (_, i) => [i, "x".repeat(21_000)]),
      orderBy: [],
    }),
  } as unknown as DatabaseAdapter;
}

function deps(adapter: DatabaseAdapter): ToolDeps {
  return {
    getAdapter: () => adapter,
    connectionId: () => "conn",
    database: () => "db",
    audit: freshAudit(),
  };
}

describe("BASED-AGENT-CONTEXT-RECOVERY: recognizing the rejection", () => {
  test("matches how each provider phrases a context overflow", () => {
    expect(isContextOverflowError(new Error(LM_STUDIO_400))).toBe(true);
    expect(isContextOverflowError(new Error("This model's maximum context length is 128000 tokens"))).toBe(true);
    expect(isContextOverflowError({ data: { error: { code: "context_length_exceeded" } } })).toBe(true);
    expect(isContextOverflowError(new Error("prompt is too long: 210000 tokens > 200000 maximum"))).toBe(true);
    // Buried behind a wrapper, which is how the AI SDK usually delivers it.
    expect(isContextOverflowError({ message: "API call failed", cause: new Error(LM_STUDIO_400) })).toBe(true);
  });

  test("a real failure is NOT an overflow — it must never be retried into a loop", () => {
    expect(isContextOverflowError(new Error("Invalid object name 'dbo.Sessions'"))).toBe(false);
    expect(isContextOverflowError(new Error("401 Unauthorized"))).toBe(false);
    expect(isContextOverflowError(new Error("ECONNREFUSED"))).toBe(false);
    expect(isContextOverflowError(null)).toBe(false);
  });
});

describe("BASED-AGENT-CONTEXT-RECOVERY: shedding", () => {
  /** A stand-in for Mastra's MessageList, with the two members the shedder touches. */
  function listOf(parts: Array<{ id: string; result: unknown }>) {
    const messages = parts.map((p) => ({
      content: {
        parts: [
          { type: "tool-invocation", toolInvocation: { toolCallId: p.id, toolName: "run_query", state: "result", result: p.result } },
        ],
      },
    }));
    const updated: string[] = [];
    return {
      messages,
      updated,
      get: { all: { db: () => messages } },
      updateToolInvocation: (part: unknown) => {
        updated.push((part as { toolInvocation: { toolCallId: string } }).toolInvocation.toolCallId);
        return true;
      },
    };
  }

  function resultOf(list: ReturnType<typeof listOf>, i: number): unknown {
    return (list.messages[i]!.content.parts[0] as { toolInvocation: { result: unknown } }).toolInvocation.result;
  }

  test("drops the biggest result, leaves the rest, and re-persists the change", () => {
    const list = listOf([
      { id: "a", result: { rows: [["small"]] } },
      { id: "b", result: { rows: [["x".repeat(50_000)]] } },
      { id: "c", result: { rows: [["y".repeat(2_000)]] } },
    ]);
    const out = shedLargestToolResult(list);
    expect(out.shed).toBe(true);
    expect(out.chars).toBeGreaterThan(50_000);
    expect(resultOf(list, 1)).toBe(SHED_TOOL_RESULT_NOTE);
    expect(resultOf(list, 0)).toEqual({ rows: [["small"]] });
    // Rewritten through the supported API too, so the stored thread is healed, not just this run.
    expect(list.updated).toEqual(["b"]);
  });

  test("a second shed takes the next-biggest, never the stub it just wrote", () => {
    const list = listOf([
      { id: "a", result: { rows: [["x".repeat(50_000)]] } },
      { id: "b", result: { rows: [["y".repeat(20_000)]] } },
    ]);
    shedLargestToolResult(list);
    shedLargestToolResult(list);
    expect(resultOf(list, 0)).toBe(SHED_TOOL_RESULT_NOTE);
    expect(resultOf(list, 1)).toBe(SHED_TOOL_RESULT_NOTE);
  });

  test("refuses when there is nothing worth shedding — retrying an identical request is pointless", () => {
    const list = listOf([{ id: "a", result: { rows: [["tiny"]] } }]);
    expect(shedLargestToolResult(list).shed).toBe(false);
    expect(resultOf(list, 0)).toEqual({ rows: [["tiny"]] });
  });
});

describe("BASED-AGENT-CONTEXT-RECOVERY: the processor's guard rails", () => {
  const bigList = {
    get: {
      all: {
        db: () => [
          {
            content: {
              parts: [
                { type: "tool-invocation", toolInvocation: { toolCallId: "a", toolName: "run_query", state: "result", result: "z".repeat(40_000) } },
              ],
            },
          },
        ],
      },
    },
  };

  test("passes a non-overflow error straight through", () => {
    const p = contextRecoveryProcessor();
    const out = p.processAPIError!({ error: new Error("Invalid object name"), messageList: bigList, retryCount: 0 } as never);
    expect(out).toEqual({ retry: false });
  });

  test("stops retrying at the attempt cap", () => {
    const p = contextRecoveryProcessor({ maxAttempts: 2 });
    const args = { error: new Error(LM_STUDIO_400), messageList: bigList, retryCount: 2 } as never;
    expect(p.processAPIError!(args)).toEqual({ retry: false });
  });

  test("sheds and reports what it gave up", () => {
    const shedded: Array<{ toolName?: string; attempt: number }> = [];
    const p = contextRecoveryProcessor({ onShed: (i) => shedded.push(i) });
    const out = p.processAPIError!({ error: new Error(LM_STUDIO_400), messageList: bigList, retryCount: 0 } as never);
    expect(out).toEqual({ retry: true });
    expect(shedded).toEqual([{ toolName: "run_query", chars: 40_000, attempt: 1 }]);
  });
});

describe("BASED-AGENT-CONTEXT-RECOVERY: the whole loop", () => {
  test("a run that overflows mid-conversation sheds the payload and finishes", async () => {
    const prompts: number[] = [];
    let sawStub = false;
    let call = 0;

    const model = new MockLanguageModelV4({
      doGenerate: async (options: { prompt?: unknown }) => {
        const serialized = JSON.stringify(options.prompt ?? []);
        prompts.push(serialized.length);
        if (serialized.includes(SHED_TOOL_RESULT_NOTE)) sawStub = true;
        call++;
        if (call === 1) {
          return {
            content: [{ type: "tool-call", toolCallId: "tc-1", toolName: "read_table", input: JSON.stringify({ table: "Sessions", limit: 100 }) }],
            finishReason: "tool-calls",
            usage,
            warnings: [],
          } as never;
        }
        // Second call carries the wide tool result — the provider rejects it, exactly as LM Studio did.
        if (call === 2) throw new Error(LM_STUDIO_400);
        return { content: [{ type: "text", text: "done" }], finishReason: "stop", usage, warnings: [] } as never;
      },
    }) as never;

    const agent = buildAgent({ model, capabilities: MSSQL, toolDeps: deps(wideTableAdapter()) });
    const result = await agent.generate("show me the sessions table");

    // 1. The run completes instead of dying on the rejection.
    expect(result.text).toBe("done");
    // 2. It got there by shedding: the retry carried the stub, not the payload.
    expect(sawStub).toBe(true);
    // 3. And the retry was genuinely smaller — the whole point of the exercise.
    expect(prompts).toHaveLength(3);
    expect(prompts[2]!).toBeLessThan(prompts[1]!);
  }, 30_000);

  test("the same recovery holds on the streaming path, which is what the AG-UI endpoint actually uses", async () => {
    let sawStub = false;
    let call = 0;

    const model = new MockLanguageModelV4({
      doStream: async (options: { prompt?: unknown }) => {
        const serialized = JSON.stringify(options.prompt ?? []);
        if (serialized.includes(SHED_TOOL_RESULT_NOTE)) sawStub = true;
        call++;
        if (call === 1) {
          return {
            stream: new ReadableStream({
              start(c) {
                c.enqueue({ type: "tool-call", toolCallId: "tc-1", toolName: "read_table", input: JSON.stringify({ table: "Sessions", limit: 100 }) });
                c.enqueue({ type: "finish", finishReason: "tool-calls", usage });
                c.close();
              },
            }),
          } as never;
        }
        if (call === 2) throw new Error(LM_STUDIO_400);
        return {
          stream: new ReadableStream({
            start(c) {
              c.enqueue({ type: "text-start", id: "t1" });
              c.enqueue({ type: "text-delta", id: "t1", delta: "recovered" });
              c.enqueue({ type: "text-end", id: "t1" });
              c.enqueue({ type: "finish", finishReason: "stop", usage });
              c.close();
            },
          }),
        } as never;
      },
    }) as never;

    const agent = buildAgent({ model, capabilities: MSSQL, toolDeps: deps(wideTableAdapter()) });
    const stream = await agent.stream("show me the sessions table");
    let text = "";
    for await (const chunk of stream.textStream) text += chunk;

    expect(text).toBe("recovered");
    expect(sawStub).toBe(true);
    expect(call).toBe(3);
  }, 30_000);

  test("a non-overflow provider failure still fails — recovery must not swallow real errors", async () => {
    let calls = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        calls++;
        throw new Error("401 Unauthorized: invalid api key");
      },
    }) as never;

    const agent = buildAgent({ model, capabilities: MSSQL, toolDeps: deps(wideTableAdapter()) });
    await expect(agent.generate("hello")).rejects.toThrow(/401/);
    expect(calls).toBe(1);
  }, 30_000);
});
