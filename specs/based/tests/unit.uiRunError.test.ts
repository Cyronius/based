// Traces: BASED-CHAT-UI ("Run errors surface in the rail" — the pre-stream half)
// A runAgent rejection (HTTP error before the SSE stream opens, unreachable server, no configured
// profile) must yield a human-readable message for the chat, and user-initiated aborts must be
// distinguishable so Stop never reads as a failure. Pure module, imported by relative path like
// unit.uiTabContext.
import { describe, expect, test } from "bun:test";
import { classifySettledTurn, describeRunError, isAbortError, type TurnMessage } from "../../../ui/src/agent/runError";

describe("describeRunError", () => {
  test("prefers the server's JSON error payload over the HTTP wrapper", () => {
    const err = Object.assign(new Error('HTTP 400: {"error":"No agent profile configured — add one in Settings → Agent."}'), {
      status: 400,
      payload: { error: "No agent profile configured — add one in Settings → Agent." },
    });
    expect(describeRunError(err)).toBe("No agent profile configured — add one in Settings → Agent.");
  });

  test("string payload (plain-text error body) is used with its status", () => {
    const err = Object.assign(new Error("HTTP 500: Internal Server Error"), {
      status: 500,
      payload: "Internal Server Error",
    });
    expect(describeRunError(err)).toBe("Internal Server Error (HTTP 500)");
  });

  test("HTML error body falls back to the error message, not a page dump", () => {
    const err = Object.assign(new Error("HTTP 502: <html>…</html>"), {
      status: 502,
      payload: "<html><body>Bad Gateway</body></html>",
    });
    expect(describeRunError(err)).toBe("HTTP 502: <html>…</html>");
  });

  test("network-level fetch failure names the server, not 'Failed to fetch'", () => {
    expect(describeRunError(new TypeError("Failed to fetch"))).toBe(
      "Could not reach the server — it may have stopped. Check the app is still running and try again.",
    );
  });

  test("plain Error passes its message through", () => {
    expect(describeRunError(new Error("boom"))).toBe("boom");
  });

  test("non-Error throw is stringified", () => {
    expect(describeRunError("wat")).toBe("wat");
  });

  test("empty/null errors still produce something", () => {
    expect(describeRunError(null).length).toBeGreaterThan(0);
    expect(describeRunError(new Error("")).length).toBeGreaterThan(0);
  });
});

describe("classifySettledTurn", () => {
  const user = (content: string): TurnMessage => ({ id: "u1", role: "user", content });
  const assistant = (content: string, toolCalls?: unknown[]): TurnMessage => ({
    id: "a1",
    role: "assistant",
    content,
    ...(toolCalls ? { toolCalls } : {}),
  });

  test("an answered turn is ok", () => {
    expect(classifySettledTurn([user("hi"), assistant("Hello — what can I look at?")])).toBe("ok");
  });

  test("empty transcript is ok — nothing has been sent", () => {
    expect(classifySettledTurn([])).toBe("ok");
  });

  // The regression this was written for: a provider that answers an unknown path with HTTP 200 and
  // a JSON error body (a typo'd base URL) completes the run with no events at all.
  test("user message last means the turn produced nothing", () => {
    expect(classifySettledTurn([user("hi")])).toBe("no-output");
  });

  test("assistant message with neither text nor tool calls is also no-output", () => {
    expect(classifySettledTurn([user("hi"), assistant("")])).toBe("no-output");
    expect(classifySettledTurn([user("hi"), assistant("   ")])).toBe("no-output");
  });

  test("tool-calls-last with no final text is the step-cap shape, not no-output", () => {
    expect(classifySettledTurn([user("audit the schema"), assistant("", [{ id: "t1" }])])).toBe("tool-calls");
  });

  test("text alongside tool calls still counts as answered", () => {
    expect(classifySettledTurn([user("audit"), assistant("Here is what I found.", [{ id: "t1" }])])).toBe("ok");
  });

  test("trailing tool results are ignored — the assistant message before them decides", () => {
    const withToolResult: TurnMessage[] = [
      user("audit"),
      assistant("", [{ id: "t1" }]),
      { id: "t1", role: "tool", content: "[]" },
    ];
    expect(classifySettledTurn(withToolResult)).toBe("tool-calls");
  });

  // Both error paths add an `error_` assistant message with text, so they classify as ok and the
  // no-output prompt never double-reports a failure the thread already shows as an error block.
  test("a rendered error message is not reported as no-output", () => {
    const withError: TurnMessage[] = [user("hi"), { id: "error_1", role: "assistant", content: "Error: boom" }];
    expect(classifySettledTurn(withError)).toBe("ok");
  });
});

describe("isAbortError", () => {
  test("DOMException AbortError is an abort", () => {
    expect(isAbortError(new DOMException("The operation was aborted.", "AbortError"))).toBe(true);
  });

  test("Error named AbortError is an abort", () => {
    expect(isAbortError(Object.assign(new Error("aborted"), { name: "AbortError" }))).toBe(true);
  });

  test("ordinary errors are not aborts", () => {
    expect(isAbortError(new Error("HTTP 500"))).toBe(false);
    expect(isAbortError(null)).toBe(false);
  });
});
