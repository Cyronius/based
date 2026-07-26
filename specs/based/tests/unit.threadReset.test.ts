// Traces: BASED-AGENT-THREADS
// The reset-wins rule behind "New chat": a thread-history fetch issued before the user discarded a
// conversation must not restore (or re-cache) it when it lands. Imported by relative path like
// unit.uiTabContext — threadReset is deliberately free of window-bound runtime imports.
import { describe, expect, test } from "bun:test";
import { beginHistoryFetch, historyIsStale, markThreadReset } from "../../../ui/src/agent/threadReset";

describe("BASED-AGENT-THREADS: history fetch vs. New chat", () => {
  test("a fetch in flight when the thread is reset is stale", () => {
    const inFlight = beginHistoryFetch("tab:c1:a");
    expect(historyIsStale(inFlight)).toBe(false);
    markThreadReset("tab:c1:a");
    expect(historyIsStale(inFlight)).toBe(true);
  });

  test("a fetch started after the reset is fresh", () => {
    markThreadReset("tab:c1:b");
    const after = beginHistoryFetch("tab:c1:b");
    expect(historyIsStale(after)).toBe(false);
    markThreadReset("tab:c1:b");
    expect(historyIsStale(after)).toBe(true);
  });

  test("resets don't leak across threads", () => {
    const other = beginHistoryFetch("tab:c1:d");
    markThreadReset("tab:c1:c");
    markThreadReset("tab:c1:c");
    expect(historyIsStale(other)).toBe(false);
  });
});
