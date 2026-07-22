// Traces: BASED-WINDOW-RESTORE
import type { Database } from "bun:sqlite";

export interface WindowStateRecord {
  sid: string;
  connectionId: string | null;
  activeTabId: string | null;
  schemaFilter: string;
  updatedAt: string;
}

interface WindowStateRow {
  sid: string;
  connection_id: string | null;
  active_tab_id: string | null;
  schema_filter: string;
  updated_at: string;
}

function toRecord(r: WindowStateRow): WindowStateRecord {
  return {
    sid: r.sid,
    connectionId: r.connection_id,
    activeTabId: r.active_tab_id,
    schemaFilter: r.schema_filter,
    updatedAt: r.updated_at,
  };
}

export class WindowStateStore {
  constructor(private readonly db: Database) {}

  list(): WindowStateRecord[] {
    const rows = this.db.query<WindowStateRow, []>("SELECT * FROM window_state ORDER BY updated_at").all();
    return rows.map(toRecord);
  }

  get(sid: string): WindowStateRecord | null {
    const row = this.db.query<WindowStateRow, [string]>("SELECT * FROM window_state WHERE sid = ?").get(sid);
    return row ? toRecord(row) : null;
  }

  save(sid: string, patch: Partial<Omit<WindowStateRecord, "sid" | "updatedAt">>): WindowStateRecord {
    const current = this.get(sid);
    const next: Omit<WindowStateRecord, "updatedAt"> = {
      sid,
      connectionId: patch.connectionId !== undefined ? patch.connectionId : (current?.connectionId ?? null),
      activeTabId: patch.activeTabId !== undefined ? patch.activeTabId : (current?.activeTabId ?? null),
      schemaFilter: patch.schemaFilter !== undefined ? patch.schemaFilter : (current?.schemaFilter ?? ""),
    };
    const updatedAt = new Date().toISOString();
    this.db.run(
      `INSERT INTO window_state (sid, connection_id, active_tab_id, schema_filter, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(sid) DO UPDATE SET
         connection_id = excluded.connection_id, active_tab_id = excluded.active_tab_id,
         schema_filter = excluded.schema_filter, updated_at = excluded.updated_at`,
      [next.sid, next.connectionId, next.activeTabId, next.schemaFilter, updatedAt],
    );
    return { ...next, updatedAt };
  }

  delete(sid: string): void {
    this.db.run("DELETE FROM window_state WHERE sid = ?", [sid]);
  }

  deleteByConnection(connectionId: string): void {
    this.db.run("DELETE FROM window_state WHERE connection_id = ?", [connectionId]);
  }
}
