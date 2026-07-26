// Traces: BASED-GRID-COPY-MD (canonical spec: specs/based/spec.md)
// Clipboard formatting for grid selections: slice semantics shared by Copy (TSV) and the new
// Copy-as-Markdown, plus the raw-value slice that feeds selection-scoped file export.
import { describe, expect, it } from "bun:test";
import type { GridSelection } from "@glideapps/glide-data-grid";
import {
  computeSelectionSlice,
  computeSelectionText,
  selectionContains,
  selectionMarkdown,
  sliceRows,
} from "../../../ui/src/gridSelectionText";
import type { WireValue } from "../../../ui/src/api/types";

// Minimal stand-ins for glide's CompactSelection — only the members gridSelectionText touches.
const compact = (idxs: number[]) => ({
  length: idxs.length,
  toArray: () => idxs,
  hasIndex: (i: number) => idxs.includes(i),
});

const sel = (o: {
  rows?: number[];
  cols?: number[];
  range?: { x: number; y: number; width: number; height: number };
  stack?: { x: number; y: number; width: number; height: number }[];
}): GridSelection =>
  ({
    rows: compact(o.rows ?? []),
    columns: compact(o.cols ?? []),
    current: o.range
      ? { cell: [o.range.x, o.range.y], range: o.range, rangeStack: o.stack ?? [] }
      : undefined,
  }) as unknown as GridSelection;

const columns = [{ name: "id" }, { name: "name|pipe" }, { name: "note" }];
const rows: WireValue[][] = [
  [1, "alpha", null],
  [2, "b|eta", "line1\nline2"],
  [3, "gamma", "plain"],
];

describe("BASED-GRID-COPY-MD: selection slice", () => {
  it("nothing selected → whole grid with header", () => {
    const s = computeSelectionSlice(undefined, columns.length);
    expect(s).toEqual({ colIndexes: [0, 1, 2], rowIndexes: null, header: true });
  });

  it("row selection → all columns of those rows, no header", () => {
    const s = computeSelectionSlice(sel({ rows: [0, 2] }), columns.length);
    expect(s).toEqual({ colIndexes: [0, 1, 2], rowIndexes: [0, 2], header: false });
  });

  it("column selection → those columns across every row, with header", () => {
    const s = computeSelectionSlice(sel({ cols: [1] }), columns.length);
    expect(s).toEqual({ colIndexes: [1], rowIndexes: null, header: true });
  });

  it("cell range → the rectangle, no header", () => {
    const s = computeSelectionSlice(sel({ range: { x: 1, y: 0, width: 2, height: 2 } }), columns.length);
    expect(s).toEqual({ colIndexes: [1, 2], rowIndexes: [0, 1], header: false });
  });
});

describe("BASED-GRID-COPY-MD: TSV parity (existing Copy semantics preserved)", () => {
  it("whole grid: header + NULL formatting, CRLF line breaks", () => {
    expect(computeSelectionText(undefined, columns, rows)).toBe(
      "id\tname|pipe\tnote\r\n1\talpha\tNULL\r\n2\tb|eta\tline1\nline2\r\n3\tgamma\tplain",
    );
  });

  it("range copy: just the rectangle, no header", () => {
    expect(computeSelectionText(sel({ range: { x: 0, y: 1, width: 2, height: 2 } }), columns, rows)).toBe(
      "2\tb|eta\r\n3\tgamma",
    );
  });
});

describe("BASED-GRID-COPY-MD: markdown table", () => {
  it("always emits a header, escapes pipes, converts newlines to <br>", () => {
    const slice = computeSelectionSlice(undefined, columns.length);
    expect(selectionMarkdown(slice, columns, rows)).toBe(
      [
        "| id | name\\|pipe | note |",
        "| --- | --- | --- |",
        "| 1 | alpha | NULL |",
        "| 2 | b\\|eta | line1<br>line2 |",
        "| 3 | gamma | plain |",
      ].join("\n"),
    );
  });

  it("range selection still gets a header row naming the involved columns", () => {
    const slice = computeSelectionSlice(sel({ range: { x: 2, y: 0, width: 1, height: 1 } }), columns.length);
    expect(selectionMarkdown(slice, columns, rows)).toBe("| note |\n| --- |\n| NULL |");
  });
});

describe("BASED-GRID-COPY-MD: raw slice for selection-scoped export", () => {
  it("returns involved column names and raw wire values", () => {
    const slice = computeSelectionSlice(sel({ range: { x: 1, y: 1, width: 2, height: 1 } }), columns.length);
    expect(sliceRows(slice, columns, rows)).toEqual({
      columns: [{ name: "name|pipe" }, { name: "note" }],
      rows: [["b|eta", "line1\nline2"]],
    });
  });
});

describe("BASED-GRID-CONTEXT-MENU: selectionContains", () => {
  it("detects cells inside ranges, rows, and columns; rejects outside", () => {
    expect(selectionContains(sel({ range: { x: 1, y: 1, width: 2, height: 2 } }), [2, 2])).toBe(true);
    expect(selectionContains(sel({ range: { x: 1, y: 1, width: 2, height: 2 } }), [0, 0])).toBe(false);
    expect(selectionContains(sel({ rows: [3] }), [0, 3])).toBe(true);
    expect(selectionContains(sel({ cols: [2] }), [2, 99])).toBe(true);
    expect(selectionContains(undefined, [0, 0])).toBe(false);
  });
});
