// Traces: BASED-IMPORT-CSV-COERCE
// Per-column-type CSV string → wire value coercion. Numeric types validate (a bad number is a
// per-row error, not NaN); bit accepts 0/1/true/false; empty strings become NULL when the option
// is on and the column is nullable; everything else passes through as a string and rides
// runCommands' NVarChar implicit conversion (the established pattern for dates/uniqueidentifier).
import type { TableColumn, WireValue } from "../db/types";

const NUMERIC_TYPES = /^(int|bigint|smallint|tinyint|decimal|numeric|float|real|money|smallmoney)$/;

export type CoerceResult = { value: WireValue } | { error: string };

export function coerceCsv(col: TableColumn, raw: string, opts: { nullEmpty: boolean }): CoerceResult {
  if (raw === "") {
    if (opts.nullEmpty) {
      if (col.nullable) return { value: null };
      if (!NUMERIC_TYPES.test(col.type) && col.type !== "bit") return { value: "" };
      return { error: `Column "${col.name}" is NOT NULL but the CSV field is empty` };
    }
    if (NUMERIC_TYPES.test(col.type) || col.type === "bit") {
      return { error: `Column "${col.name}" (${col.type}) cannot take an empty string` };
    }
    return { value: "" };
  }

  if (NUMERIC_TYPES.test(col.type)) {
    const n = Number(raw.trim());
    if (!Number.isFinite(n)) return { error: `Column "${col.name}" (${col.type}): "${raw}" is not a number` };
    return { value: n };
  }

  if (col.type === "bit") {
    const v = raw.trim().toLowerCase();
    if (v === "1" || v === "true") return { value: 1 };
    if (v === "0" || v === "false") return { value: 0 };
    return { error: `Column "${col.name}" (bit): "${raw}" is not 0/1/true/false` };
  }

  return { value: raw };
}
