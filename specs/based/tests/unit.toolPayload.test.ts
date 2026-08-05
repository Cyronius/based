// Traces: BASED-AGENT-TOOL-PAYLOAD-CAP
//
// What these guard is the difference between two limits that were long treated as one: how MANY
// rows go to the model, and how BIG they are. The row cap was always there; the size cap wasn't,
// and a single wide text column was enough to put a quarter-million tokens into one tool result.
//
// The other half is honesty. A clipped value that doesn't say it was clipped is worse than no
// value — the model quotes it back as the whole thing — so every cut has to show up in the result.
import { describe, expect, test } from "bun:test";
import { boundRows, payloadBudget, TOOL_CELL_CAP, TOOL_PAYLOAD_CAP } from "@based/core";
import type { WireValue } from "@based/core";

/** The real shape of the failure: a conversation-log column holding whole transcripts. */
function wideRows(count: number, chars: number): WireValue[][] {
  return Array.from({ length: count }, (_, i) => [i, "x".repeat(chars)] as WireValue[]);
}

describe("BASED-AGENT-TOOL-PAYLOAD-CAP: cell capping", () => {
  test("a 21,000-character cell comes back capped, marked, and counted", () => {
    const out = boundRows([[1, "y".repeat(21_000)]]);
    const cell = out.rows[0]![1] as string;
    expect(cell).toHaveLength(TOOL_CELL_CAP + 1); // the cap plus the ellipsis
    expect(cell.endsWith("…")).toBe(true);
    expect(out.cellsTruncated).toBe(1);
    expect(out.truncated).toBe(true);
  });

  test("narrow rows — the common case — pass through untouched and unflagged", () => {
    const rows: WireValue[][] = [
      [1, "alice", true, null],
      [2, "bob", false, 3.5],
    ];
    const out = boundRows(rows);
    expect(out.rows).toEqual(rows);
    expect(out.returned).toBe(2);
    expect(out.truncated).toBe(false);
    expect(out.cellsTruncated).toBe(0);
    expect(out.droppedForSize).toBe(0);
    expect(out.note).toBeUndefined();
  });

  test("a value exactly at the cap is not cut — only a longer one is", () => {
    const out = boundRows([["z".repeat(TOOL_CELL_CAP)], ["z".repeat(TOOL_CELL_CAP + 1)]]);
    expect(out.rows[0]![0]).toBe("z".repeat(TOOL_CELL_CAP));
    expect(out.rows[1]![0]).toBe(`${"z".repeat(TOOL_CELL_CAP)}…`);
    expect(out.cellsTruncated).toBe(1);
  });

  test("wire-summarized vector and binary cells survive intact — the adapters already shrank them", () => {
    const rows: WireValue[][] = [[{ $: "vec", dim: 1536, preview: [0.1, 0.2] }, { $: "bin", len: 4096, preview: "0x00" }]];
    const out = boundRows(rows);
    expect(out.rows).toEqual(rows);
    expect(out.truncated).toBe(false);
  });
});

describe("BASED-AGENT-TOOL-PAYLOAD-CAP: payload budget", () => {
  test("50 rows of a 21K-char column: the result stays inside the budget instead of blowing the window", () => {
    const out = boundRows(wideRows(50, 21_000));
    expect(JSON.stringify(out.rows).length).toBeLessThanOrEqual(TOOL_PAYLOAD_CAP);
    // Cell capping alone already fits all 50 rows here — which is the point: the second bound only
    // has to fire when the first isn't enough (many columns, or a cap raised per call).
    expect(out.returned).toBe(50);
    expect(out.cellsTruncated).toBe(50);
  });

  test("rows are dropped, and counted, once the budget runs out", () => {
    const budget = payloadBudget(2_000);
    const out = boundRows(wideRows(50, 21_000), { budget });
    expect(out.returned).toBeGreaterThan(0);
    expect(out.returned).toBeLessThan(50);
    expect(out.droppedForSize).toBe(50 - out.returned);
    expect(JSON.stringify(out.rows).length).toBeLessThan(4_000);
  });

  test("one budget spent across several result sets, not one per set", () => {
    const budget = payloadBudget(2_000);
    const first = boundRows(wideRows(50, 21_000), { budget });
    const second = boundRows(wideRows(50, 21_000), { budget });
    expect(first.returned).toBeGreaterThan(0);
    // The first set spent the budget; the second gets its one guaranteed row and nothing more.
    expect(second.returned).toBe(1);
    expect(second.droppedForSize).toBe(49);
  });

  test("a single row bigger than the whole budget is still returned — zero rows teaches nothing", () => {
    const out = boundRows(wideRows(1, 21_000), { budget: payloadBudget(10) });
    expect(out.returned).toBe(1);
    expect(out.droppedForSize).toBe(0);
    // And it is still cell-capped, so "oversized" is bounded by the column count, not by the data.
    expect((out.rows[0]![1] as string).length).toBe(TOOL_CELL_CAP + 1);
  });
});

describe("BASED-AGENT-TOOL-PAYLOAD-CAP: the model is told what was cut", () => {
  test("the note names both kinds of cut and says what to do instead", () => {
    const out = boundRows(wideRows(50, 21_000), { budget: payloadBudget(2_000) });
    expect(out.note).toContain("cut short");
    expect(out.note).toContain("were dropped");
    expect(out.note).toContain("export_data");
    expect(out.note).toContain("Do not present a cut-short value as the complete one");
  });

  test("cell-only and drop-only cuts each report just their own", () => {
    const cellsOnly = boundRows([[1, "q".repeat(5_000)]]);
    expect(cellsOnly.note).toContain("cut short");
    expect(cellsOnly.note).not.toContain("were dropped");

    const rowsOnly = boundRows(
      Array.from({ length: 20 }, (_, i) => [i, `row-${i}`] as WireValue[]),
      { budget: payloadBudget(30) },
    );
    expect(rowsOnly.note).toContain("were dropped");
    expect(rowsOnly.note).not.toContain("cut short");
  });
});
