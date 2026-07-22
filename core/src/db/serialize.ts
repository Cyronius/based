// Traces: BASED-VALUE-SAFETY
import type { WireValue } from "./types";

const BIN_PREVIEW_BYTES = 32;

function pad(n: number, w: number): string {
  return String(n).padStart(w, "0");
}

/** SQL-style local timestamp: YYYY-MM-DD HH:mm:ss.mmm */
export function formatSqlDate(d: Date): string {
  return (
    `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1, 2)}-${pad(d.getDate(), 2)} ` +
    `${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}:${pad(d.getSeconds(), 2)}.${pad(d.getMilliseconds(), 3)}`
  );
}

export function serializeValue(v: unknown): WireValue {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" || typeof v === "boolean") return v;
  if (typeof v === "number") return Number.isFinite(v) ? v : String(v);
  if (typeof v === "bigint") return v.toString();
  if (v instanceof Date) return formatSqlDate(v);
  if (v instanceof Uint8Array) {
    const preview = Buffer.from(v.subarray(0, BIN_PREVIEW_BYTES)).toString("hex");
    return { $: "bin", len: v.byteLength, preview: `0x${preview}${v.byteLength > BIN_PREVIEW_BYTES ? "…" : ""}` };
  }
  // UDTs (geography/geometry) and anything exotic: safe string summary
  try {
    return String(v);
  } catch {
    return "[unrenderable]";
  }
}

export function serializeRow(row: unknown[]): WireValue[] {
  return row.map(serializeValue);
}
