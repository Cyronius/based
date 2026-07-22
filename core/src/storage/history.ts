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
}

export class HistoryStore {
  constructor(private readonly db: Database) {}

  add(entry: Omit<HistoryEntry, "id">): void {
    this.db.run(
      "INSERT INTO history (connection_id, database, sql, started_at, duration_ms, status, error) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [entry.connectionId, entry.database, entry.sql, entry.startedAt, entry.durationMs, entry.status, entry.error],
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
    }));
  }
}
