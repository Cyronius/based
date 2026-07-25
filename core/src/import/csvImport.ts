// Traces: BASED-IMPORT-CSV-RUN
// Batched, transactional CSV import. The batch builder is pure (unit-tested); the runner streams
// progress chunks while inserting through the adapter's transactional runCommands.
import { quoteIdent, qualified } from "../db/tableEdit";
import type { DatabaseAdapter, DbCommand, TableColumn, WireValue } from "../db/types";
import { coerceCsv } from "./coerce";
import { CsvParser } from "./csvParse";

/** SQL Server allows 2,100 parameters per request; budget 2,000 for margin. NULLs are params too. */
const PARAM_BUDGET = 2000;
/** Files at or under this many data rows import as ONE transaction (all-or-nothing). */
export const ATOMIC_ROW_LIMIT = 5000;
/** Batch size (rows per transaction) above the atomic limit. */
export const BATCH_ROWS = 1000;

/**
 * Pure: pack rows into multi-row parameterized INSERT statements, ≤ PARAM_BUDGET params each.
 * Identifiers go through tableEdit's strict quoteIdent — imports write, so the write path's
 * injection guard applies.
 */
export function buildInsertBatches(schema: string, table: string, columns: string[], rows: WireValue[][]): DbCommand[] {
  if (columns.length === 0 || rows.length === 0) return [];
  const rowsPerStatement = Math.max(1, Math.floor(PARAM_BUDGET / columns.length));
  const target = qualified(schema, table);
  const colList = columns.map(quoteIdent).join(", ");
  const out: DbCommand[] = [];
  for (let start = 0; start < rows.length; start += rowsPerStatement) {
    const slice = rows.slice(start, start + rowsPerStatement);
    const params: DbCommand["params"] = [];
    const tuples = slice.map((row) => {
      const placeholders = row.map((v) => {
        const name = `p${params!.length}`;
        params!.push({ name, value: v });
        return `@${name}`;
      });
      return `(${placeholders.join(", ")})`;
    });
    out.push({ sql: `INSERT INTO ${target} (${colList}) VALUES ${tuples.join(", ")}`, params });
  }
  return out;
}

export interface CsvImportRequest {
  path: string;
  schema: string;
  table: string;
  hasHeader: boolean;
  /** csvIndex → target column name. */
  mapping: Array<{ csvIndex: number; column: string }>;
  nullEmpty: boolean;
  skipBadRows: boolean;
}

export type ImportChunk =
  | { type: "progress"; inserted: number; totalRows: number }
  | { type: "rowError"; row: number; error: string }
  | { type: "done"; status: "ok" | "error"; inserted: number; failed: number; durationMs: number; error?: string };

/**
 * Run the import: stream-parse the file, coerce per mapping, insert in batches. ≤ ATOMIC_ROW_LIMIT
 * rows → one transaction (all-or-nothing); larger → per-batch transactions with progress. A bad
 * row stops everything (atomic mode rolls back) unless skipBadRows, which skips + reports it.
 */
export async function runCsvImport(
  adapter: DatabaseAdapter,
  req: CsvImportRequest,
  columns: TableColumn[],
  onChunk: (chunk: ImportChunk) => void,
): Promise<{ status: "ok" | "error"; inserted: number; failed: number; error?: string }> {
  const started = Date.now();
  const byName = new Map(columns.map((c) => [c.name, c]));
  const mapping = req.mapping.map((m) => {
    const col = byName.get(m.column);
    if (!col) throw new Error(`Unknown column "${m.column}" on ${req.schema}.${req.table}`);
    return { csvIndex: m.csvIndex, col };
  });
  const targetCols = mapping.map((m) => m.col.name);

  // Parse + coerce the whole file first (memory: strings only; the row cap of realistic CSV
  // imports for a desktop tool is well within RAM — the DB write is the bottleneck).
  const file = Bun.file(req.path);
  if (!(await file.exists())) throw new Error(`File not found: ${req.path}`);
  const parser = new CsvParser();
  const raw: string[][] = [];
  const stream = file.stream();
  const decoder = new TextDecoder("utf-8");
  for await (const chunk of stream) {
    raw.push(...parser.push(decoder.decode(chunk, { stream: true })));
  }
  const tail = decoder.decode();
  if (tail) raw.push(...parser.push(tail));
  raw.push(...parser.finish());

  const dataRows = req.hasHeader ? raw.slice(1) : raw;
  const rows: WireValue[][] = [];
  let failed = 0;
  for (let i = 0; i < dataRows.length; i++) {
    const csvRowNum = i + 1 + (req.hasHeader ? 1 : 0); // 1-based, counting the header
    const src = dataRows[i]!;
    const wire: WireValue[] = [];
    let rowError: string | null = null;
    for (const m of mapping) {
      const r = coerceCsv(m.col, src[m.csvIndex] ?? "", { nullEmpty: req.nullEmpty });
      if ("error" in r) {
        rowError = r.error;
        break;
      }
      wire.push(r.value);
    }
    if (rowError) {
      onChunk({ type: "rowError", row: csvRowNum, error: rowError });
      failed++;
      if (!req.skipBadRows) {
        const error = `Row ${csvRowNum}: ${rowError}`;
        onChunk({ type: "done", status: "error", inserted: 0, failed, durationMs: Date.now() - started, error });
        return { status: "error", inserted: 0, failed, error };
      }
      continue;
    }
    rows.push(wire);
  }

  let inserted = 0;
  const finish = (status: "ok" | "error", error?: string) => {
    onChunk({ type: "done", status, inserted, failed, durationMs: Date.now() - started, ...(error ? { error } : {}) });
    return { status, inserted, failed, ...(error ? { error } : {}) };
  };

  if (rows.length === 0) return finish("ok");

  if (rows.length <= ATOMIC_ROW_LIMIT) {
    const commands = buildInsertBatches(req.schema, req.table, targetCols, rows);
    const result = await adapter.runCommands(commands);
    if (result.error) return finish("error", result.error);
    inserted = rows.length;
    onChunk({ type: "progress", inserted, totalRows: rows.length });
    return finish("ok");
  }

  for (let start = 0; start < rows.length; start += BATCH_ROWS) {
    const slice = rows.slice(start, start + BATCH_ROWS);
    const commands = buildInsertBatches(req.schema, req.table, targetCols, slice);
    const result = await adapter.runCommands(commands);
    if (result.error) {
      return finish("error", `Batch starting at data row ${start + 1} failed (${inserted} rows already committed): ${result.error}`);
    }
    inserted += slice.length;
    onChunk({ type: "progress", inserted, totalRows: rows.length });
  }
  return finish("ok");
}
