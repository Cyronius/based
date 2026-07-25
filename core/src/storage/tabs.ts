// Traces: BASED-TABSTORE
import type { Database } from "bun:sqlite";

// Traces: BASED-TABSTORE — kind set includes "diagram" (BASED-DIAGRAM-UI).
export type TabKind = "query" | "table" | "routine" | "diagram";

export interface TabRecord {
  id: string;
  connectionId: string;
  title: string;
  content: string;
  filePath: string | null;
  position: number;
  kind: TabKind;
  /** Kind-specific fields: null for query tabs; {schema,table,objectType,view} for table tabs;
   *  {schema,name,routineType} for routine tabs. */
  meta: unknown | null;
  updatedAt: string;
}

interface TabRow {
  id: string;
  connection_id: string;
  title: string;
  content: string;
  file_path: string | null;
  position: number;
  kind: string;
  meta: string | null;
  updated_at: string;
}

function toRecord(r: TabRow): TabRecord {
  return {
    id: r.id,
    connectionId: r.connection_id,
    title: r.title,
    content: r.content,
    filePath: r.file_path,
    position: r.position,
    kind: r.kind as TabKind,
    meta: r.meta != null ? JSON.parse(r.meta) : null,
    updatedAt: r.updated_at,
  };
}

export class TabStore {
  constructor(private readonly db: Database) {}

  list(connectionId: string): TabRecord[] {
    const rows = this.db
      .query<TabRow, [string]>("SELECT * FROM tabs WHERE connection_id = ? ORDER BY position, updated_at")
      .all(connectionId);
    return rows.map(toRecord);
  }

  upsert(tab: Omit<TabRecord, "updatedAt">): TabRecord {
    const updatedAt = new Date().toISOString();
    const meta = tab.meta != null ? JSON.stringify(tab.meta) : null;
    this.db.run(
      `INSERT INTO tabs (id, connection_id, title, content, file_path, position, kind, meta, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         connection_id = excluded.connection_id, title = excluded.title, content = excluded.content,
         file_path = excluded.file_path, position = excluded.position, kind = excluded.kind,
         meta = excluded.meta, updated_at = excluded.updated_at`,
      [tab.id, tab.connectionId, tab.title, tab.content, tab.filePath, tab.position, tab.kind, meta, updatedAt],
    );
    return { ...tab, updatedAt };
  }

  delete(id: string): void {
    this.db.run("DELETE FROM tabs WHERE id = ?", [id]);
  }

  /** Replace the full tab set for a connection: prune rows absent from `tabs`, then upsert the
   *  rest. Makes the persisted set a mirror of the open set (an empty array clears the
   *  connection). Runs in a transaction so restore never sees a partial state. */
  replaceForConnection(connectionId: string, tabs: Array<Omit<TabRecord, "updatedAt">>): TabRecord[] {
    const run = this.db.transaction((list: Array<Omit<TabRecord, "updatedAt">>) => {
      const keep = new Set(list.map((t) => t.id));
      const existing = this.db
        .query<{ id: string }, [string]>("SELECT id FROM tabs WHERE connection_id = ?")
        .all(connectionId);
      for (const row of existing) if (!keep.has(row.id)) this.db.run("DELETE FROM tabs WHERE id = ?", [row.id]);
      return list.map((t) => this.upsert(t));
    });
    return run(tabs);
  }
}
