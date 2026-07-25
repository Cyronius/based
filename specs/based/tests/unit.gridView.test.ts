// Traces: BASED-GRID-SORT, BASED-GRID-FILTER
// Pure view computation for the query results grid: type-aware stable sort + per-column filter
// mini-language, composed by computeViewIndex (filter first, then sort, returning original indices).
import { describe, expect, test } from "bun:test";
import { compileFilter, computeViewIndex, parseFilterToTableFilter, type SortState } from "../../../ui/src/gridView";
import type { ColumnInfo, WireValue } from "../../../ui/src/api/types";

const intCol: ColumnInfo = { name: "n", type: "int" };
const textCol: ColumnInfo = { name: "s", type: "nvarchar" };
const dateCol: ColumnInfo = { name: "d", type: "datetime2" };

function rowsOf(...vals: WireValue[]): WireValue[][] {
  return vals.map((v) => [v]);
}

function order(rows: WireValue[][], cols: ColumnInfo[], sort: SortState, filters: Record<number, string> = {}): WireValue[] {
  const idx = computeViewIndex(rows, cols, sort, filters) ?? rows.map((_, i) => i);
  return idx.map((i) => rows[i]![0]!);
}

describe("BASED-GRID-SORT: type-aware stable sort", () => {
  test("numeric asc puts NULL first, desc puts NULL last", () => {
    const rows = rowsOf(3, 1, null, 2);
    expect(order(rows, [intCol], { col: 0, dir: "asc" })).toEqual([null, 1, 2, 3]);
    expect(order(rows, [intCol], { col: 0, dir: "desc" })).toEqual([3, 2, 1, null]);
  });

  test("text sorts case-insensitively", () => {
    const rows = rowsOf("banana", "Apple", "cherry");
    expect(order(rows, [textCol], { col: 0, dir: "asc" })).toEqual(["Apple", "banana", "cherry"]);
  });

  test("temporal strings sort lexically (chronological)", () => {
    const rows = rowsOf("2026-01-02 00:00:00.000", "2025-12-31 23:59:59.000", "2026-01-01 12:00:00.000");
    expect(order(rows, [dateCol], { col: 0, dir: "asc" })).toEqual([
      "2025-12-31 23:59:59.000",
      "2026-01-01 12:00:00.000",
      "2026-01-02 00:00:00.000",
    ]);
  });

  test("sort is stable: equal keys keep arrival order", () => {
    const rows: WireValue[][] = [
      [1, "first"],
      [2, "x"],
      [1, "second"],
      [1, "third"],
    ];
    const cols = [intCol, textCol];
    const idx = computeViewIndex(rows, cols, { col: 0, dir: "asc" }, {})!;
    const labels = idx.map((i) => rows[i]![1]);
    expect(labels).toEqual(["first", "second", "third", "x"]);
  });

  test("wire objects (bin/vec) sort by their summary text without throwing", () => {
    const rows = rowsOf({ $: "bin", len: 4, preview: "0xAA" }, { $: "bin", len: 2, preview: "0x01" }, null);
    expect(() => order(rows, [{ name: "b", type: "varbinary" }], { col: 0, dir: "asc" })).not.toThrow();
    expect(order(rows, [{ name: "b", type: "varbinary" }], { col: 0, dir: "asc" })[0]).toBeNull();
  });

  test("no sort and no filters returns null (identity view)", () => {
    expect(computeViewIndex(rowsOf(1, 2), [intCol], null, {})).toBeNull();
  });
});

describe("BASED-GRID-FILTER: filter mini-language", () => {
  test("plain text is case-insensitive contains and never matches NULL", () => {
    const f = compileFilter("nvarchar", "abc");
    expect(f("xABCy")).toBe(true);
    expect(f("ab")).toBe(false);
    expect(f(null)).toBe(false);
  });

  test("= on a numeric column compares numerically", () => {
    const f = compileFilter("int", "= 5");
    expect(f(5)).toBe(true);
    expect(f(50)).toBe(false);
    expect(f(null)).toBe(false);
  });

  test("> and >= on numbers; never match NULL", () => {
    expect(compileFilter("int", "> 5")(6)).toBe(true);
    expect(compileFilter("int", "> 5")(5)).toBe(false);
    expect(compileFilter("int", ">= 5")(5)).toBe(true);
    expect(compileFilter("int", "> 5")(null)).toBe(false);
  });

  test("!= and <> match differing values but not NULL", () => {
    for (const op of ["!= x", "<> x"]) {
      const f = compileFilter("nvarchar", op);
      expect(f("y")).toBe(true);
      expect(f("x")).toBe(false);
      expect(f("X")).toBe(false); // case-insensitive equality
      expect(f(null)).toBe(false);
    }
  });

  test("= string equality is case-insensitive", () => {
    const f = compileFilter("nvarchar", "= Apple");
    expect(f("apple")).toBe(true);
    expect(f("apples")).toBe(false);
  });

  test("NULL / NOT NULL literals", () => {
    expect(compileFilter("int", "NULL")(null)).toBe(true);
    expect(compileFilter("int", "null")(1)).toBe(false);
    expect(compileFilter("int", "NOT NULL")(1)).toBe(true);
    expect(compileFilter("int", "not null")(null)).toBe(false);
  });

  test("lexical compare on non-numeric columns (dates)", () => {
    const f = compileFilter("datetime2", ">= 2026-01-01");
    expect(f("2026-03-15 00:00:00.000")).toBe(true);
    expect(f("2025-12-31 23:59:59.000")).toBe(false);
  });

  test("empty/whitespace filter matches everything", () => {
    const f = compileFilter("int", "   ");
    expect(f(null)).toBe(true);
    expect(f(1)).toBe(true);
  });
});

describe("BASED-TABLE-ORDERBY: mini-language → structured TableFilter", () => {
  test("plain text becomes an escaped %…% LIKE", () => {
    expect(parseFilterToTableFilter("name", "nvarchar", "ap")).toEqual({ column: "name", op: "like", value: "%ap%" });
    expect(parseFilterToTableFilter("name", "nvarchar", "50%_[x]")).toEqual({
      column: "name",
      op: "like",
      value: "%50[%][_][[]x]%",
    });
  });

  test("operators map with typed values on numeric columns", () => {
    expect(parseFilterToTableFilter("qty", "int", "> 5")).toEqual({ column: "qty", op: "gt", value: 5 });
    expect(parseFilterToTableFilter("qty", "int", "= 5")).toEqual({ column: "qty", op: "eq", value: 5 });
    expect(parseFilterToTableFilter("name", "nvarchar", "<> x")).toEqual({ column: "name", op: "ne", value: "x" });
    expect(parseFilterToTableFilter("name", "nvarchar", ">= b")).toEqual({ column: "name", op: "ge", value: "b" });
  });

  test("NULL / NOT NULL / empty", () => {
    expect(parseFilterToTableFilter("qty", "int", "null")).toEqual({ column: "qty", op: "is-null" });
    expect(parseFilterToTableFilter("qty", "int", "NOT NULL")).toEqual({ column: "qty", op: "not-null" });
    expect(parseFilterToTableFilter("qty", "int", "  ")).toBeNull();
  });
});

describe("BASED-GRID-FILTER + SORT: composition", () => {
  test("filters first, then sorts, returning original indices", () => {
    const rows: WireValue[][] = [
      [30, "keep"],
      [10, "drop"],
      [20, "keep"],
      [null, "keep"],
    ];
    const cols = [intCol, textCol];
    const idx = computeViewIndex(rows, cols, { col: 0, dir: "desc" }, { 1: "keep" })!;
    expect(idx).toEqual([0, 2, 3]); // 30, 20, NULL-last on desc; row 1 filtered out
  });

  test("filter-only view returns matching original indices in order", () => {
    const rows = rowsOf("a", "b", "ab");
    const idx = computeViewIndex(rows, [textCol], null, { 0: "a" })!;
    expect(idx).toEqual([0, 2]);
  });
});
