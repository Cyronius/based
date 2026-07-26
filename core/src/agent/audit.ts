// Traces: BASED-AGENT-AUDIT
// Local audit log of every SQL statement the agent causes to run — reads via run_query/read_table
// and user-approved mutations. Never records row data, only the statement and its outcome.
import type { Database } from "bun:sqlite";

export interface AuditEntry {
  id: number;
  connectionId: string;
  database: string;
  kind: "read" | "mutation";
  sql: string;
  approved: boolean;
  startedAt: string;
  durationMs: number | null;
  status: "ok" | "error";
  error: string | null;
}

/** The audit surface a tool run depends on. Deliberately the shape rather than the class: a run can
 *  then decorate it (see agent/subagent.ts, which tags every statement a subagent causes), which the
 *  class's private `db` field would make structurally impossible. */
export type AuditSink = Pick<AuditStore, "add" | "list">;

export class AuditStore {
  constructor(private readonly db: Database) {}

  add(entry: Omit<AuditEntry, "id">): void {
    this.db.run(
      "INSERT INTO agent_audit (connection_id, database, kind, sql, approved, started_at, duration_ms, status, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        entry.connectionId,
        entry.database,
        entry.kind,
        entry.sql,
        entry.approved ? 1 : 0,
        entry.startedAt,
        entry.durationMs,
        entry.status,
        entry.error,
      ],
    );
  }

  list(connectionId: string, limit = 200): AuditEntry[] {
    const rows = this.db
      .query<
        {
          id: number;
          connection_id: string;
          database: string;
          kind: string;
          sql: string;
          approved: number;
          started_at: string;
          duration_ms: number | null;
          status: string;
          error: string | null;
        },
        [string, number]
      >("SELECT * FROM agent_audit WHERE connection_id = ? ORDER BY id DESC LIMIT ?")
      .all(connectionId, limit);
    return rows.map((r) => ({
      id: r.id,
      connectionId: r.connection_id,
      database: r.database,
      kind: r.kind as AuditEntry["kind"],
      sql: r.sql,
      approved: r.approved === 1,
      startedAt: r.started_at,
      durationMs: r.duration_ms,
      status: r.status as AuditEntry["status"],
      error: r.error,
    }));
  }
}
