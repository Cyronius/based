// Traces: BASED-AGENT-TRANSCRIPT — the markdown rendering of a thread. One formatter serves both
// the save_chat_transcript tool (messages from agent memory) and the chat header's download button
// (messages straight off the live AgentClient), so it is asserted against the shared AG-UI shape.
import { describe, expect, test } from "bun:test";
import { transcriptMarkdown } from "@based/core";
import type { Message } from "@ag-ui/core";

const AT = "2026-07-26T12:00:00.000Z";

function msgs(...m: unknown[]): Message[] {
  return m as Message[];
}

describe("BASED-AGENT-TRANSCRIPT: transcriptMarkdown", () => {
  test("renders the turns in order under You / Capi headings", () => {
    const out = transcriptMarkdown(
      msgs(
        { id: "1", role: "user", content: "how many orders?" },
        { id: "2", role: "assistant", content: "1,204." },
        { id: "3", role: "user", content: "and last month?" },
      ),
      { generatedAt: AT },
    );
    expect(out).toBe(
      `# based — chat transcript\n\n_Generated ${AT}_\n\n## You\n\nhow many orders?\n\n## Capi\n\n1,204.\n\n## You\n\nand last month?\n`,
    );
  });

  test("assistant prose passes through verbatim — code and mermaid fences survive", () => {
    const body = "Here:\n\n```sql\nSELECT *\nFROM dbo.Orders -- keep  this  spacing\n```\n\nand a chart:\n\n```mermaid\npie\n  \"a\" : 3\n```";
    const out = transcriptMarkdown(msgs({ id: "1", role: "assistant", content: body }), { generatedAt: AT });
    expect(out).toContain(body);
  });

  test("tool and system messages contribute no section", () => {
    const out = transcriptMarkdown(
      msgs(
        { id: "0", role: "system", content: "you are Capi" },
        { id: "1", role: "user", content: "hi" },
        { id: "2", role: "tool", toolCallId: "t1", content: '{"rowCount":3}' },
        { id: "3", role: "assistant", content: "hello" },
      ),
      { generatedAt: AT },
    );
    expect(out).not.toContain("you are Capi");
    expect(out).not.toContain("rowCount");
    expect(out.match(/^## .+$/gm)).toEqual(["## You", "## Capi"]);
  });

  test("an assistant turn that is only tool calls produces no empty heading", () => {
    const out = transcriptMarkdown(
      msgs(
        { id: "1", role: "user", content: "count them" },
        { id: "2", role: "assistant", toolCalls: [{ id: "t1", type: "function", function: { name: "run_query", arguments: "{}" } }] },
        { id: "3", role: "tool", toolCallId: "t1", content: "{}" },
        { id: "4", role: "assistant", content: "1,204." },
      ),
      { generatedAt: AT },
    );
    expect(out.match(/^## .+$/gm)).toEqual(["## You", "## Capi"]);
    expect(out).not.toContain("run_query");
  });

  test("consecutive same-role turns merge under one heading", () => {
    const out = transcriptMarkdown(
      msgs(
        { id: "1", role: "assistant", content: "first" },
        { id: "2", role: "assistant", content: "second" },
      ),
      { generatedAt: AT },
    );
    expect(out.match(/^## .+$/gm)).toEqual(["## Capi"]);
    expect(out).toContain("first\n\nsecond");
  });

  test("an empty thread renders the header alone", () => {
    expect(transcriptMarkdown([], { generatedAt: AT })).toBe(`# based — chat transcript\n\n_Generated ${AT}_\n`);
  });

  test("a title replaces the default heading", () => {
    expect(transcriptMarkdown([], { title: "Orders analysis", generatedAt: AT }).startsWith("# Orders analysis\n")).toBe(true);
  });
});
