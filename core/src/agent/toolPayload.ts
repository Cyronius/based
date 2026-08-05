// Traces: BASED-AGENT-TOOL-PAYLOAD-CAP
//
// The size bound on rows handed to the model. Every row-returning tool already capped how MANY rows
// it returned; nothing capped how BIG a row was, and the two are not the same limit. 50 rows of a
// column holding 21K-character text is a quarter of a million tokens from one tool call — enough to
// blow a 262K-token window outright, and (because the result is persisted to the thread) to keep
// blowing it on every later turn until the conversation is thrown away.
//
// So: cap each cell, cap the whole payload, and say what was cut. The last part is not decoration.
// A model handed a silently clipped value will quote it back as the complete one; a model told the
// value was clipped will go get the rest.
//
// Vector and binary cells are NOT handled here — the adapters already summarize them on the wire as
// {$:"vec"} / {$:"bin"} (see db/types.ts), so they arrive small.
import type { WireValue } from "../db/types";

/** Characters kept per cell before the value is cut short. Matches the UI half's CELL_CAP
 *  (ui/src/agent/tabContext.ts), which has always done this for the frontend tools. */
export const TOOL_CELL_CAP = 300;

/** Characters one tool result may spend on rows, across all of its result sets. ~25K tokens: room
 *  for the system prompt, the workspace context block, and several more tool rounds inside a 262K
 *  window, with the smallest local models still able to take a couple of these back to back. */
export const TOOL_PAYLOAD_CAP = 100_000;

/** A spend-down budget shared by every result set in ONE tool call — `run_query` can return several,
 *  and per-set budgets would multiply the cap by the number of sets. */
export interface PayloadBudget {
  readonly cap: number;
  left: number;
}

export function payloadBudget(cap: number = TOOL_PAYLOAD_CAP): PayloadBudget {
  return { cap, left: cap };
}

export interface BoundedRows {
  rows: WireValue[][];
  /** Rows actually included (≤ the input length). */
  returned: number;
  cellsTruncated: number;
  droppedForSize: number;
  /** True when anything at all was cut — cells, rows, or both. */
  truncated: boolean;
  /** Present only when something was cut: what happened, in terms the model can act on. */
  note?: string;
}

/** Rough serialized cost of one cell, in characters. Exact JSON length doesn't matter — this only
 *  has to be proportional to what the value will cost in the prompt. */
function cellCost(v: WireValue): number {
  if (typeof v === "string") return v.length + 2;
  if (v === null) return 4;
  if (typeof v === "number" || typeof v === "boolean") return String(v).length;
  return JSON.stringify(v)?.length ?? 0;
}

/** Cap cell text and stop adding rows once the budget runs out. */
export function boundRows(
  rows: readonly WireValue[][],
  opts?: { cellCap?: number; budget?: PayloadBudget },
): BoundedRows {
  const cellCap = opts?.cellCap ?? TOOL_CELL_CAP;
  const budget = opts?.budget ?? payloadBudget();
  const out: WireValue[][] = [];
  let cellsTruncated = 0;

  for (const row of rows) {
    const capped = row.map((v) => {
      if (typeof v === "string" && v.length > cellCap) {
        cellsTruncated++;
        return `${v.slice(0, cellCap)}…`;
      }
      return v;
    });
    const cost = capped.reduce<number>((n, v) => n + cellCost(v), 0);
    // The first row always goes through even if it alone busts the budget: a result with zero rows
    // tells the model nothing about the shape of what it asked for, and it is already cell-capped,
    // so "one oversized row" is bounded by the column count rather than by the data.
    if (out.length > 0 && cost > budget.left) break;
    budget.left -= cost;
    out.push(capped);
  }

  const droppedForSize = rows.length - out.length;
  const parts: string[] = [];
  if (cellsTruncated > 0) {
    parts.push(`${cellsTruncated} cell value(s) longer than ${cellCap} characters were cut short (they end with …)`);
  }
  if (droppedForSize > 0) {
    parts.push(`${droppedForSize} of ${rows.length} rows were dropped to stay inside this tool's ${budget.cap.toLocaleString("en-US")}-character result budget`);
  }

  return {
    rows: out,
    returned: out.length,
    cellsTruncated,
    droppedForSize,
    truncated: cellsTruncated > 0 || droppedForSize > 0,
    ...(parts.length > 0
      ? {
          note: `${parts.join("; ")}. Do not present a cut-short value as the complete one — ask for fewer or narrower columns, or use export_data to write the full values to a file.`,
        }
      : {}),
  };
}
