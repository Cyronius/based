// Traces: BASED-CHAT-HISTORY-PICKER — deterministic chat-title derivation. This is deliberately a
// pure, model-free function behind one seam: a tiny local titling model is planned as a future
// (config-optional) replacement, and it must slot in at this one call site.
import { describe, expect, test } from "bun:test";
import { threadTitle, isDerivableTitle } from "../../../core/src/agent/threadTitle";

describe("BASED-CHAT-HISTORY-PICKER: threadTitle", () => {
  test("takes the first 6 words, with an ellipsis when words were dropped", () => {
    expect(threadTitle("show me the top customers by revenue this year")).toBe("show me the top customers by…");
    expect(threadTitle("hello there")).toBe("hello there");
    expect(threadTitle("one two three four five six")).toBe("one two three four five six");
  });

  test("hard-caps at 48 chars including the ellipsis", () => {
    const longWord = "x".repeat(60);
    const t = threadTitle(longWord);
    expect(t.length).toBeLessThanOrEqual(48);
    expect(t.endsWith("…")).toBe(true);
  });

  test("collapses whitespace and handles blank input", () => {
    expect(threadTitle("  select \n *  from   customers ")).toBe("select * from customers");
    expect(threadTitle("")).toBe("Untitled chat");
    expect(threadTitle("   \n\t ")).toBe("Untitled chat");
  });

  test("isDerivableTitle: unset or Mastra-default titles derive; real titles are kept", () => {
    expect(isDerivableTitle(undefined)).toBe(true);
    expect(isDerivableTitle(null)).toBe(true);
    expect(isDerivableTitle("")).toBe(true);
    expect(isDerivableTitle("   ")).toBe(true);
    expect(isDerivableTitle("New Thread 2026-08-19T00:00:00.000Z")).toBe(true);
    expect(isDerivableTitle("show me the top customers by…")).toBe(false);
  });
});
