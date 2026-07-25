// Traces: BASED-AGENT-THREADS — Mastra DB messages → AG-UI messages for per-tab history restore.
import { describe, expect, test } from "bun:test";
import { mapDbMessagesToAgui } from "@based/core";
import type { DbMessageLike } from "@based/core";

function textMsg(id: string, role: string, text: string): DbMessageLike {
  return { id, role, content: { format: 2, parts: [{ type: "text", text }] } };
}

describe("BASED-AGENT-THREADS: mapDbMessagesToAgui", () => {
  test("maps user and assistant text messages with their original ids", () => {
    const out = mapDbMessagesToAgui([textMsg("u1", "user", "hi"), textMsg("a1", "assistant", "hello")]);
    expect(out).toEqual([
      { id: "u1", role: "user", content: "hi" },
      { id: "a1", role: "assistant", content: "hello" },
    ]);
  });

  test("a resolved tool invocation yields toolCalls plus a synthetic hist_-prefixed tool message", () => {
    const out = mapDbMessagesToAgui([
      {
        id: "a1",
        role: "assistant",
        content: {
          format: 2,
          parts: [
            { type: "text", text: "Looking…" },
            {
              type: "tool-invocation",
              toolInvocation: { toolCallId: "call_1", toolName: "get_schema", args: { table: "T" }, state: "result", result: { columns: [] } },
            },
          ],
        },
      },
    ]);
    expect(out.length).toBe(2);
    const assistant = out[0]! as { toolCalls?: Array<{ id: string; function: { name: string; arguments: string } }> };
    expect(assistant.toolCalls![0]!.id).toBe("call_1");
    expect(assistant.toolCalls![0]!.function.name).toBe("get_schema");
    expect(JSON.parse(assistant.toolCalls![0]!.function.arguments)).toEqual({ table: "T" });
    const toolMsg = out[1]! as { id: string; role: string; toolCallId: string; content: string };
    expect(toolMsg.id).toBe("hist_call_1");
    expect(toolMsg.role).toBe("tool");
    expect(toolMsg.toolCallId).toBe("call_1");
    expect(JSON.parse(toolMsg.content)).toEqual({ columns: [] });
  });

  test("an unresolved (call-state) invocation gets no synthetic tool message", () => {
    const out = mapDbMessagesToAgui([
      {
        id: "a1",
        role: "assistant",
        content: {
          format: 2,
          parts: [{ type: "tool-invocation", toolInvocation: { toolCallId: "c1", toolName: "run_query", args: {}, state: "call" } }],
        },
      },
    ]);
    expect(out.length).toBe(1);
    expect((out[0] as { toolCalls?: unknown[] }).toolCalls?.length).toBe(1);
  });

  test("unknown roles and part types are skipped, not thrown on", () => {
    const out = mapDbMessagesToAgui([
      textMsg("s1", "system", "internal"),
      { id: "a1", role: "assistant", content: { format: 2, parts: [{ type: "reasoning", text: "hmm" } as never, { type: "text", text: "ok" }] } },
      { id: "weird", role: "assistant", content: null },
      { id: "x", role: "signal", content: { format: 2, parts: [] } },
    ]);
    expect(out).toEqual([{ id: "a1", role: "assistant", content: "ok" }]);
  });
});
