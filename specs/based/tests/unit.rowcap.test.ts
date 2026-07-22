// Traces: BASED-ROWCAP
import { describe, expect, test } from "bun:test";
import { RowCollector } from "@based/core";
import type { WireValue } from "@based/core";

describe("BASED-ROWCAP: display row cap", () => {
  test("caps forwarded rows, keeps counting, marks truncated", () => {
    const flushed: WireValue[][] = [];
    const c = new RowCollector((rows) => flushed.push(...rows), 10, 3);
    for (let i = 0; i < 25; i++) c.push([i]);
    const { rowCount, truncated } = c.finish();
    expect(flushed.length).toBe(10);
    expect(rowCount).toBe(25);
    expect(truncated).toBe(true);
  });

  test("exactly at cap is not truncated", () => {
    const flushed: WireValue[][] = [];
    const c = new RowCollector((rows) => flushed.push(...rows), 10, 3);
    for (let i = 0; i < 10; i++) c.push([i]);
    const { rowCount, truncated } = c.finish();
    expect(flushed.length).toBe(10);
    expect(rowCount).toBe(10);
    expect(truncated).toBe(false);
  });

  test("flushes in chunks and preserves order", () => {
    const chunks: WireValue[][][] = [];
    const c = new RowCollector((rows) => chunks.push([...rows]), 100, 4);
    for (let i = 0; i < 9; i++) c.push([i]);
    c.finish();
    expect(chunks.map((ch) => ch.length)).toEqual([4, 4, 1]);
    expect(chunks.flat().map((r) => r[0])).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });
});
