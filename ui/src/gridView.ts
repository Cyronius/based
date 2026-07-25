// Traces: BASED-GRID-SORT, BASED-GRID-FILTER
// Pure view computation for the query results grid: rows are fully client-side (streamed up to the
// row cap), so sort/filter is a derived index over the original rows — no server round-trip, no
// mutation of arrival order. computeViewIndex returns original row indices (filter first, then a
// stable type-aware sort), or null for the identity view so callers can skip mapping entirely.
import { cellText, type ColumnInfo, type TableFilter, type WireValue } from "./api/types";

export type SortDir = "asc" | "desc";
export type SortState = { col: number; dir: SortDir } | null;
/** Column index → filter expression (the mini-language of compileFilter). */
export type ColumnFilters = Record<number, string>;

/** SQL numeric type names — numeric compare + right alignment (shared with ResultGrid). */
export const NUMERIC_TYPES = /^(int|bigint|smallint|tinyint|decimal|numeric|float|real|money|smallmoney)$/;

function displayText(v: WireValue): string {
  if (v === null) return "";
  return typeof v === "object" ? cellText(v) : String(v);
}

/**
 * Filter mini-language: empty → match all; `NULL` / `NOT NULL` → nullness; a leading `=`, `!=`,
 * `<>`, `>`, `>=`, `<`, `<=` → typed compare (numeric on numeric columns or numeric operands,
 * case-insensitive string otherwise; never matches NULL — SQL semantics); anything else →
 * case-insensitive contains over the display text (never matches NULL).
 */
export function compileFilter(colType: string, expr: string): (v: WireValue) => boolean {
  const trimmed = expr.trim();
  if (!trimmed) return () => true;

  const upper = trimmed.toUpperCase();
  if (upper === "NULL") return (v) => v === null;
  if (upper === "NOT NULL") return (v) => v !== null;

  const m = /^(>=|<=|!=|<>|=|>|<)\s*(.*)$/.exec(trimmed);
  if (m) {
    const op = m[1] === "<>" ? "!=" : m[1]!;
    const operand = m[2]!.trim();
    const numericCol = NUMERIC_TYPES.test(colType);
    const operandNum = Number(operand);
    const numericOperand = operand !== "" && Number.isFinite(operandNum);
    return (v) => {
      if (v === null) return false; // operator filters never match NULL (SQL semantics)
      let cmp: number;
      if ((numericCol || typeof v === "number") && numericOperand) {
        const n = typeof v === "number" ? v : Number(displayText(v));
        if (!Number.isFinite(n)) return false;
        cmp = n < operandNum ? -1 : n > operandNum ? 1 : 0;
      } else {
        const a = displayText(v).toLowerCase();
        const b = operand.toLowerCase();
        cmp = a < b ? -1 : a > b ? 1 : 0;
      }
      switch (op) {
        case "=":
          return cmp === 0;
        case "!=":
          return cmp !== 0;
        case ">":
          return cmp > 0;
        case ">=":
          return cmp >= 0;
        case "<":
          return cmp < 0;
        case "<=":
          return cmp <= 0;
        default:
          return false;
      }
    };
  }

  const needle = trimmed.toLowerCase();
  return (v) => v !== null && displayText(v).toLowerCase().includes(needle);
}

/**
 * Translate a filter expression (same mini-language as compileFilter) into a structured, server-side
 * TableFilter for the Data tab (BASED-TABLE-ORDERBY): `NULL`/`NOT NULL` → nullness ops; a leading
 * comparison operator → the matching op with a typed value (number on numeric columns with numeric
 * operands); plain text → `like` with a `%…%` pattern, LIKE wildcards escaped via `[...]`. Returns
 * null for an empty expression.
 */
export function parseFilterToTableFilter(column: string, colType: string, expr: string): TableFilter | null {
  const trimmed = expr.trim();
  if (!trimmed) return null;

  const upper = trimmed.toUpperCase();
  if (upper === "NULL") return { column, op: "is-null" };
  if (upper === "NOT NULL") return { column, op: "not-null" };

  const m = /^(>=|<=|!=|<>|=|>|<)\s*(.*)$/.exec(trimmed);
  if (m) {
    const OPS: Record<string, TableFilter["op"]> = { "=": "eq", "!=": "ne", "<>": "ne", ">": "gt", ">=": "ge", "<": "lt", "<=": "le" };
    const op = OPS[m[1]!]!;
    const operand = m[2]!.trim();
    const asNum = Number(operand);
    const value = NUMERIC_TYPES.test(colType) && operand !== "" && Number.isFinite(asNum) ? asNum : operand;
    return { column, op, value };
  }

  // contains → LIKE '%…%' with the user's text escaped so % _ [ are literals
  const escaped = trimmed.replace(/[[%_]/g, (c) => `[${c}]`);
  return { column, op: "like", value: `%${escaped}%` };
}

/** Type-aware value comparator; NULL handling lives in the caller (direction-dependent). */
function compareValues(a: WireValue, b: WireValue, numericCol: boolean): number {
  if (numericCol || (typeof a === "number" && typeof b === "number")) {
    const na = typeof a === "number" ? a : Number(displayText(a));
    const nb = typeof b === "number" ? b : Number(displayText(b));
    if (Number.isFinite(na) && Number.isFinite(nb)) return na < nb ? -1 : na > nb ? 1 : 0;
  }
  const sa = displayText(a).toLowerCase();
  const sb = displayText(b).toLowerCase();
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/**
 * The grid's view: filter every row through the active column filters, then stable-sort by the
 * sort column (NULLs first ascending / last descending, SQL Server convention). Returns original
 * row indices, or null when there is nothing to do (identity view — callers skip mapping).
 */
export function computeViewIndex(
  rows: WireValue[][],
  columns: ColumnInfo[],
  sort: SortState,
  filters: ColumnFilters,
): number[] | null {
  const activeFilters = Object.entries(filters)
    .map(([col, expr]) => ({ col: Number(col), expr: expr.trim() }))
    .filter((f) => f.expr !== "");
  if (!sort && activeFilters.length === 0) return null;

  const predicates = activeFilters.map((f) => ({
    col: f.col,
    test: compileFilter(columns[f.col]?.type ?? "", f.expr),
  }));

  let index: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    let keep = true;
    for (const p of predicates) {
      if (!p.test(row[p.col] ?? null)) {
        keep = false;
        break;
      }
    }
    if (keep) index.push(i);
  }

  if (sort) {
    const { col, dir } = sort;
    const numericCol = NUMERIC_TYPES.test(columns[col]?.type ?? "");
    const sign = dir === "asc" ? 1 : -1;
    // Decorate with the original index as the tiebreak → stable regardless of Array.sort.
    index = index
      .map((i) => ({ i, v: rows[i]?.[col] ?? null }))
      .sort((a, b) => {
        if (a.v === null || b.v === null) {
          if (a.v === null && b.v === null) return a.i - b.i;
          // NULLs first on asc, last on desc.
          return (a.v === null ? -1 : 1) * sign;
        }
        const cmp = compareValues(a.v, b.v, numericCol);
        return cmp !== 0 ? cmp * sign : a.i - b.i;
      })
      .map((e) => e.i);
  }

  return index;
}
