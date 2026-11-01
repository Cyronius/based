// Traces: BASED-QUERY-BATCH-FAILURE — one ordered strip tells the run's story: grids, the failure, what never ran.
import { plural } from "./plural";

export interface SlotError {
  afterResult: number;
  statement?: number;
  statementCount?: number;
  batch?: number;
}

export type ResultSlot =
  | { kind: "grid"; result: number; label: string }
  | { kind: "error"; errors: number[]; label: string }
  | { kind: "skipped"; count: number; label: string };

function errorLabel(e: SlotError): string {
  if (e.statement != null) return `Statement ${e.statement} failed`;
  if (e.batch != null) return `Batch ${e.batch} failed`;
  return "Error";
}

export function resultSlots(
  sets: Array<{ rowCount: number; rows: unknown[]; complete: boolean }>,
  errors: SlotError[],
): ResultSlot[] {
  const slots: ResultSlot[] = [];
  const pushErrorsAt = (pos: number) =>
    errors.forEach((e, i) => {
      if (e.afterResult !== pos) return;
      const label = errorLabel(e);
      const prev = slots[slots.length - 1];
      // SQL Server often raises two messages for one failure; they share one slot.
      if (prev?.kind === "error" && prev.label === label) prev.errors.push(i);
      else slots.push({ kind: "error", errors: [i], label });
    });
  sets.forEach((s, i) => {
    pushErrorsAt(i);
    const count = s.complete ? plural(s.rowCount, "row") : `${s.rows.length.toLocaleString()}…`;
    slots.push({ kind: "grid", result: i, label: `${i + 1} · ${count}` });
  });
  pushErrorsAt(sets.length);
  const stop = errors.find((e) => e.statement != null && e.statementCount != null);
  const skipped = stop ? stop.statementCount! - stop.statement! : 0;
  if (skipped > 0) slots.push({ kind: "skipped", count: skipped, label: `${skipped} skipped` });
  return slots;
}

export function batchNote(errors: SlotError[]): string | null {
  if (errors.length === 0) return null;
  const stop = errors.find((e) => e.statement != null && e.statementCount != null);
  if (stop) return `Stopped at statement ${stop.statement} of ${stop.statementCount}`;
  const failures = new Set(errors.map((e) => `${e.afterResult}:${errorLabel(e)}`)).size;
  return failures === 1 ? "Finished with an error" : `Finished with ${failures} errors`;
}
