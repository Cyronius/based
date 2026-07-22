// Collect a streamed adapter execution into a bounded, JSON-friendly result. Shared by the agent
// tools (run_query / sample_rows) and the approval-gated mutation endpoint. Applies an agent-side
// row cap on top of the adapter's own cap so tool output stays small for the model's context.
import type { ColumnInfo, QueryChunk, WireValue } from "../db/types";

export const AGENT_ROW_CAP = 1000;

export interface CollectedResultSet {
  columns: ColumnInfo[];
  rows: WireValue[][];
  rowCount: number;
  truncated: boolean;
}

export interface CollectedResult {
  status: "ok" | "error" | "cancelled";
  durationMs: number;
  resultSets: CollectedResultSet[];
  messages: string[];
  errors: string[];
}

interface Adapter {
  execute(sql: string, onChunk: (chunk: QueryChunk) => void): { completion: Promise<{ status: "ok" | "error" | "cancelled"; durationMs: number }> };
}

export async function collectQuery(adapter: Adapter, sql: string, opts?: { rowCap?: number }): Promise<CollectedResult> {
  const rowCap = opts?.rowCap ?? AGENT_ROW_CAP;
  const resultSets: CollectedResultSet[] = [];
  const messages: string[] = [];
  const errors: string[] = [];
  let current: CollectedResultSet | null = null;

  const exec = adapter.execute(sql, (chunk) => {
    switch (chunk.type) {
      case "resultset":
        current = { columns: chunk.columns, rows: [], rowCount: 0, truncated: false };
        resultSets.push(current);
        break;
      case "rows":
        if (!current) break;
        for (const row of chunk.rows) {
          if (current.rows.length < rowCap) current.rows.push(row);
          else current.truncated = true;
        }
        break;
      case "resultsetEnd":
        if (current) {
          current.rowCount = chunk.rowCount;
          if (chunk.truncated) current.truncated = true;
        }
        break;
      case "message":
        messages.push(chunk.text);
        break;
      case "error":
        errors.push(chunk.line != null ? `Error${chunk.code ? ` ${chunk.code}` : ""} (line ${chunk.line}): ${chunk.message}` : chunk.message);
        break;
    }
  });

  const { status, durationMs } = await exec.completion;
  return { status, durationMs, resultSets, messages, errors };
}
