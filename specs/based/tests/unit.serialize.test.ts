// Traces: BASED-VALUE-SAFETY
import { describe, expect, test } from "bun:test";
import { serializeValue, formatSqlDate } from "@based/core";

describe("BASED-VALUE-SAFETY: safe cell serialization", () => {
  test("SQL NULL → wire null; string 'null' stays a string", () => {
    expect(serializeValue(null)).toBeNull();
    expect(serializeValue(undefined)).toBeNull();
    expect(serializeValue("null")).toBe("null");
  });

  test("Buffer → tagged binary summary with capped hex preview", () => {
    const small = serializeValue(Buffer.from([0xde, 0xad, 0xbe, 0xef]));
    expect(small).toEqual({ $: "bin", len: 4, preview: "0xdeadbeef" });
    const big = serializeValue(Buffer.alloc(100, 0xab)) as { $: string; len: number; preview: string };
    expect(big.len).toBe(100);
    expect(big.preview.length).toBeLessThan(100); // capped, not the full payload
    expect(big.preview.endsWith("…")).toBe(true);
  });

  test("Date → SQL-style string", () => {
    const d = new Date(2026, 0, 2, 3, 4, 5, 67);
    expect(formatSqlDate(d)).toBe("2026-01-02 03:04:05.067");
    expect(serializeValue(d)).toBe("2026-01-02 03:04:05.067");
  });

  test("primitives pass through", () => {
    expect(serializeValue("x")).toBe("x");
    expect(serializeValue(42.5)).toBe(42.5);
    expect(serializeValue(true)).toBe(true);
    expect(serializeValue(10n)).toBe("10");
  });
});
