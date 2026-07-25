// Traces: BASED-IMPORT-CSV-UI (manual)
// CSV → table import stepper: pick file (native dialog) → map columns (auto-map by name, warnings
// for unmapped NOT NULL / identity targets) → coerced preview with per-cell error highlighting →
// run with live NDJSON progress + error list → summary, then the caller reloads the grid.
// Modal shell mirrors ConnectionDialog (centered over a scrim).
import { useMemo, useState } from "react";
import { inspectCsv, openFileDialogApi, streamCsvImport, type CsvImportChunk } from "../api/client";
import type { TableColumn } from "../api/types";

const NUMERIC_TYPES = /^(int|bigint|smallint|tinyint|decimal|numeric|float|real|money|smallmoney)$/;

/** Client-side mirror of the server's coercion — preview-only (the server re-coerces on run). */
function previewCell(col: TableColumn | undefined, raw: string, nullEmpty: boolean): { text: string; error: boolean } {
  if (!col) return { text: raw, error: false };
  if (raw === "") {
    if (nullEmpty && col.nullable) return { text: "NULL", error: false };
    if (NUMERIC_TYPES.test(col.type) || col.type === "bit") return { text: "(empty)", error: true };
    return { text: '""', error: false };
  }
  if (NUMERIC_TYPES.test(col.type)) {
    return Number.isFinite(Number(raw.trim())) ? { text: raw, error: false } : { text: raw, error: true };
  }
  if (col.type === "bit") {
    const v = raw.trim().toLowerCase();
    return ["0", "1", "true", "false"].includes(v) ? { text: raw, error: false } : { text: raw, error: true };
  }
  return { text: raw, error: false };
}

const field =
  "px-2 py-1 rounded border border-line bg-ink-950 text-paper text-[length:var(--fs-sm)] focus:outline-none focus:border-brass-soft";
const btnPrimary = "px-2.5 py-1 rounded border border-brass-soft bg-brass/15 text-brass hover:bg-brass/25 disabled:opacity-40";
const btnSecondary = "px-2 py-1 rounded border border-line text-muted hover:text-paper disabled:opacity-35";

export function ImportCsvDialog({
  schema,
  table,
  columns,
  onClose,
  onImported,
}: {
  schema: string;
  table: string;
  columns: TableColumn[];
  onClose: () => void;
  /** Called after a successful (or partially successful) run so the grid reloads. */
  onImported: () => void;
}) {
  const [path, setPath] = useState<string | null>(null);
  const [header, setHeader] = useState<string[]>([]);
  const [sample, setSample] = useState<string[][]>([]);
  const [hasHeader, setHasHeader] = useState(true);
  const [nullEmpty, setNullEmpty] = useState(true);
  const [skipBadRows, setSkipBadRows] = useState(false);
  /** csvIndex → target column name ("" = not imported). */
  const [mapping, setMapping] = useState<Record<number, string>>({});
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ inserted: number; totalRows: number } | null>(null);
  const [rowErrors, setRowErrors] = useState<Array<{ row: number; error: string }>>([]);
  const [done, setDone] = useState<Extract<CsvImportChunk, { type: "done" }> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const byName = useMemo(() => new Map(columns.map((c) => [c.name.toLowerCase(), c])), [columns]);

  async function chooseFile() {
    setError(null);
    const { path: chosen } = await openFileDialogApi("csv");
    if (!chosen) return;
    try {
      const { header: h, rows } = await inspectCsv(chosen);
      setPath(chosen);
      setHeader(h);
      setSample(rows);
      setDone(null);
      setRowErrors([]);
      // Auto-map by case-insensitive header name.
      const auto: Record<number, string> = {};
      h.forEach((name, i) => {
        const col = byName.get(name.trim().toLowerCase());
        if (col) auto[i] = col.name;
      });
      setMapping(auto);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const mapped = useMemo(
    () =>
      Object.entries(mapping)
        .filter(([, col]) => col !== "")
        .map(([i, col]) => ({ csvIndex: Number(i), column: col })),
    [mapping],
  );
  const mappedNames = new Set(mapped.map((m) => m.column));
  const unmappedRequired = columns.filter((c) => !c.nullable && !mappedNames.has(c.name));
  const columnFor = (csvIndex: number) => columns.find((c) => c.name === mapping[csvIndex]);

  async function run() {
    if (!path) return;
    setRunning(true);
    setError(null);
    setRowErrors([]);
    setProgress(null);
    setDone(null);
    try {
      await streamCsvImport({ path, schema, table, hasHeader, mapping: mapped, nullEmpty, skipBadRows }, (chunk) => {
        if (chunk.type === "progress") setProgress({ inserted: chunk.inserted, totalRows: chunk.totalRows });
        else if (chunk.type === "rowError") setRowErrors((prev) => [...prev.slice(-199), { row: chunk.row, error: chunk.error }]);
        else if (chunk.type === "done") {
          setDone(chunk);
          if (chunk.inserted > 0) onImported();
        }
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/50" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="w-[min(90vw,780px)] max-h-[85vh] overflow-y-auto rounded border border-line bg-ink-900 shadow-2xl shadow-black/50 fade-up">
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-line">
          <span className="font-display text-lg text-paper">
            Import CSV → <span className="font-mono text-[length:var(--fs-base)]">{schema}.{table}</span>
          </span>
          <button className="text-muted hover:text-paper" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="p-4 space-y-3 text-[length:var(--fs-base)]">
          <div className="flex items-center gap-2">
            <button className={btnSecondary} onClick={() => void chooseFile()} disabled={running}>
              Choose file…
            </button>
            <span className="font-mono text-[length:var(--fs-sm)] text-muted truncate">{path ?? "No file selected."}</span>
          </div>

          {path && (
            <>
              <div className="flex items-center gap-4 text-[length:var(--fs-sm)]">
                <label className="flex items-center gap-1.5 text-muted">
                  <input type="checkbox" checked={hasHeader} onChange={(e) => setHasHeader(e.target.checked)} />
                  First row is a header
                </label>
                <label className="flex items-center gap-1.5 text-muted" title="Empty CSV fields become NULL for nullable columns">
                  <input type="checkbox" checked={nullEmpty} onChange={(e) => setNullEmpty(e.target.checked)} />
                  Empty → NULL
                </label>
                <label className="flex items-center gap-1.5 text-muted" title="Skip rows that fail coercion instead of aborting">
                  <input type="checkbox" checked={skipBadRows} onChange={(e) => setSkipBadRows(e.target.checked)} />
                  Skip bad rows
                </label>
              </div>

              <div className="ledger-label">Column mapping</div>
              <div className="flex flex-wrap gap-2">
                {header.map((h, i) => (
                  <label key={i} className="flex items-center gap-1.5 text-[length:var(--fs-sm)]">
                    <span className="font-mono text-paper-dim">{hasHeader ? h : `#${i + 1}`}</span>
                    <span className="text-faint">→</span>
                    <select className={field} value={mapping[i] ?? ""} onChange={(e) => setMapping({ ...mapping, [i]: e.target.value })}>
                      <option value="">(not imported)</option>
                      {columns.map((c) => (
                        <option key={c.name} value={c.name}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
              {unmappedRequired.length > 0 && (
                <div className="text-[length:var(--fs-sm)] text-brass">
                  Not mapped and NOT NULL: {unmappedRequired.map((c) => c.name).join(", ")} — the insert will fail unless these
                  columns have defaults or identity.
                </div>
              )}

              <div className="ledger-label">Preview</div>
              <div className="max-h-56 overflow-auto rounded border border-line-soft">
                <table className="text-[length:var(--fs-sm)] border-collapse w-full">
                  <thead>
                    <tr className="text-left">
                      {header.map((h, i) => (
                        <th key={i} className="px-2 py-1 border-b border-line font-mono text-faint whitespace-nowrap sticky top-0 bg-ink-900">
                          {mapping[i] ? `${hasHeader ? h : `#${i + 1}`} → ${mapping[i]}` : hasHeader ? h : `#${i + 1}`}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(hasHeader ? sample : [header, ...sample]).slice(0, 20).map((row, r) => (
                      <tr key={r}>
                        {header.map((_, c) => {
                          const cell = previewCell(columnFor(c), row[c] ?? "", nullEmpty);
                          return (
                            <td
                              key={c}
                              className={`px-2 py-1 border-b border-line-soft font-mono whitespace-nowrap ${
                                cell.error ? "text-err bg-err/10" : mapping[c] ? "text-paper-dim" : "text-faint/60"
                              }`}
                            >
                              {cell.text}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {progress && !done && (
                <div className="text-[length:var(--fs-sm)] text-muted font-mono">
                  {progress.inserted.toLocaleString()} of {progress.totalRows.toLocaleString()} rows inserted…
                </div>
              )}
              {done && (
                <div className={`text-[length:var(--fs-sm)] ${done.status === "ok" ? "text-ok" : "text-err"}`}>
                  {done.status === "ok" ? "Import complete" : "Import failed"} — {done.inserted.toLocaleString()} inserted,{" "}
                  {done.failed.toLocaleString()} failed, {done.durationMs.toLocaleString()} ms.
                  {done.error && <span className="block font-mono mt-0.5">{done.error}</span>}
                </div>
              )}
              {rowErrors.length > 0 && (
                <div className="max-h-28 overflow-auto rounded border border-err/30 bg-err/5 px-2 py-1 text-[length:var(--fs-xs)] font-mono text-err">
                  {rowErrors.map((e, i) => (
                    <div key={i}>
                      Row {e.row}: {e.error}
                    </div>
                  ))}
                </div>
              )}
              {error && <div className="text-[length:var(--fs-sm)] text-err font-mono">{error}</div>}
            </>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-2.5 border-t border-line">
          <button className={btnSecondary} onClick={onClose}>
            {done ? "Close" : "Cancel"}
          </button>
          <button className={btnPrimary} disabled={!path || mapped.length === 0 || running} onClick={() => void run()}>
            {running ? "Importing…" : "Import"}
          </button>
        </div>
      </div>
    </div>
  );
}
