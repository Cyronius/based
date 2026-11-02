// Traces: BASED-TAB-REOPEN
import { describe, expect, test } from "bun:test";
import { CLOSED_TAB_BATCH_CAP, popClosed, pushClosed } from "../../../ui/src/lib/closedTabs";

describe("BASED-TAB-REOPEN: closed-tab batch stack", () => {
  test("a batch comes back whole, most recent first", () => {
    let stack = pushClosed<string>([], ["a"]);
    stack = pushClosed(stack, ["b", "c", "d"]);
    const first = popClosed(stack);
    expect(first.batch).toEqual(["b", "c", "d"]);
    const second = popClosed(first.stack);
    expect(second.batch).toEqual(["a"]);
    expect(popClosed(second.stack).batch).toBeNull();
  });

  test("an empty close adds no batch", () => {
    expect(pushClosed<string>([], [])).toEqual([]);
  });

  test("the oldest batch is evicted past the cap", () => {
    let stack: number[][] = [];
    for (let i = 0; i < CLOSED_TAB_BATCH_CAP + 3; i++) stack = pushClosed(stack, [i]);
    expect(stack.length).toBe(CLOSED_TAB_BATCH_CAP);
    expect(stack[0]).toEqual([3]);
    expect(popClosed(stack).batch).toEqual([CLOSED_TAB_BATCH_CAP + 2]);
  });
});
