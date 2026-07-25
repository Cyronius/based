// Traces: BASED-AGENT-EXPORT
// Agent-invokable export: run a read-only query (or page through a whole table) server-side and
// write the rows to a CSV/XLSX file via the existing writers. Pure of any HTTP concerns — the
// agent tool supplies the adapter and the resolved target path. Data *import* is a separate
// workstream (BASED-IMPORT-*); no import path lives here.
import type { ColumnInfo, DatabaseAdapter, WireValue } from "../db/types";
import { collectQuery } from "../agent/runSql";
import { toCsv } from "./csv";
import { writeXlsx } from "./xlsx";

export const EXPORT_ROW_CAP = 100_000;
/** readTablePage page size for whole-table exports. */
const EXPORT_PAGE_SIZE = 1_000;

export type ExportSource = { kind: "sql"; sql: string } | { kind: "table"; schema: string; table: string };

export interface ExportResult {
  path: string;
  rowCount: number;
  truncated: boolean;
  columns: string[];
}

/** Reject anything that could escape the export folder; enforce the format's extension. */
export function sanitizeExportFileName(name: string, format: "csv" | "xlsx"): string {
  if (/[/\\]/.test(name) || name.includes("..")) {
    throw new Error("fileName must be a bare file name (no directories or '..')");
  }
  const trimmed = name.trim();
  if (!trimmed) throw new Error("fileName must not be empty");
  return trimmed.toLowerCase().endsWith(`.${format}`) ? trimmed : `${trimmed}.${format}`;
}

async function collectSource(
  adapter: DatabaseAdapter,
  source: ExportSource,
  rowCap: number,
  pageSize: number,
): Promise<{ columns: ColumnInfo[]; rows: WireValue[][]; truncated: boolean; extraResultSets: number }> {
  if (source.kind === "sql") {
    if (!adapter.capabilities.sql) throw new Error("This connection does not support SQL — export a table instead.");
    const result = await collectQuery(adapter, source.sql, { rowCap });
    if (result.status !== "ok") throw new Error(result.errors.join("; ") || "Query failed");
    const rs = result.resultSets[0];
    if (!rs) throw new Error("The query returned no result set.");
    return { columns: rs.columns, rows: rs.rows, truncated: rs.truncated, extraResultSets: result.resultSets.length - 1 };
  }
  const rows: WireValue[][] = [];
  let columns: ColumnInfo[] = [];
  let truncated = false;
  let offset = 0;
  for (;;) {
    const page = await adapter.readTablePage(source.schema, source.table, { offset, limit: pageSize });
    if (columns.length === 0) columns = page.columns.map((c) => ({ name: c.name, type: c.type }));
    for (const row of page.rows) {
      if (rows.length >= rowCap) {
        truncated = true;
        break;
      }
      rows.push(row);
    }
    if (truncated || page.rows.length < pageSize) break;
    offset += pageSize;
  }
  return { columns, rows, truncated, extraResultSets: 0 };
}

/** Collect the source rows (bounded) and write them to `targetPath` in the given format. */
export async function exportData(
  adapter: DatabaseAdapter,
  source: ExportSource,
  format: "csv" | "xlsx",
  targetPath: string,
  opts?: { rowCap?: number; pageSize?: number },
): Promise<ExportResult> {
  const rowCap = opts?.rowCap ?? EXPORT_ROW_CAP;
  const pageSize = opts?.pageSize ?? EXPORT_PAGE_SIZE;
  const { columns, rows, truncated } = await collectSource(adapter, source, rowCap, pageSize);
  if (format === "csv") await Bun.write(targetPath, toCsv(columns, rows));
  else await writeXlsx(targetPath, columns, rows);
  return { path: targetPath, rowCount: rows.length, truncated, columns: columns.map((c) => c.name) };
}
