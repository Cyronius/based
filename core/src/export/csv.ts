// Traces: BASED-EXPORT-CSV
import type { ColumnInfo, WireValue } from "../db/types";

export function cellText(v: WireValue): string {
  if (v === null) return "";
  if (typeof v === "object") return `<binary ${v.len} bytes>`;
  return String(v);
}

function csvField(s: string): string {
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(columns: ColumnInfo[], rows: WireValue[][]): string {
  const lines = [columns.map((c) => csvField(c.name)).join(",")];
  for (const row of rows) lines.push(row.map((v) => csvField(cellText(v))).join(","));
  return lines.join("\r\n") + "\r\n";
}
