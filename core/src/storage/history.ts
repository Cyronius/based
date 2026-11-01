// Traces: BASED-HISTORY
import type { Database } from "bun:sqlite";

export interface HistoryEntry {
  id: number;
  connectionId: string;
  database: string;
  sql: string;
  startedAt: string;
  durationMs: number | null;
  status: "ok" | "error" | "cancelled";
  error: string | null;
  /** Statements (or GO batches) in the run, when the engine split the text. */
  statementCount?: number | null;
  /** 1-based statement or batch that failed first, when the engine said. */
  failedStatement?: number | null;
}

export class HistoryStore {
  constructor(private readonly db: Database) {}

  add(entry: Omit<HistoryEntry, "id">): void {
    this.db.run(
      "INSERT INTO history (connection_id, database, sql, started_at, duration_ms, status, error, statement_count, failed_statement) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        entry.connectionId,
        entry.database,
        entry.sql,
        entry.startedAt,
        entry.durationMs,
        entry.status,
        entry.error,
        entry.statementCount ?? null,
        entry.failedStatement ?? null,
      ],
    );
  }

  list(connectionId: string, limit = 200): HistoryEntry[] {
    const rows = this.db
      .query<
        {
          id: number;
          connection_id: string;
          database: string;
          sql: string;
          started_at: string;
          duration_ms: number | null;
          status: string;
          error: string | null;
          statement_count: number | null;
          failed_statement: number | null;
        },
        [string, number]
      >("SELECT * FROM history WHERE connection_id = ? ORDER BY id DESC LIMIT ?")
      .all(connectionId, limit);
    return rows.map((r) => ({
      id: r.id,
      connectionId: r.connection_id,
      database: r.database,
      sql: r.sql,
      startedAt: r.started_at,
      durationMs: r.duration_ms,
      status: r.status as HistoryEntry["status"],
      error: r.error,
      statementCount: r.statement_count,
      failedStatement: r.failed_statement,
    }));
  }
}
