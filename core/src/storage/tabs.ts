// Traces: BASED-TABSTORE
import type { Database } from "bun:sqlite";

export interface TabRecord {
  id: string;
  connectionId: string;
  title: string;
  content: string;
  filePath: string | null;
  position: number;
  updatedAt: string;
}

interface TabRow {
  id: string;
  connection_id: string;
  title: string;
  content: string;
  file_path: string | null;
  position: number;
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
    this.db.run(
      `INSERT INTO tabs (id, connection_id, title, content, file_path, position, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         connection_id = excluded.connection_id, title = excluded.title, content = excluded.content,
         file_path = excluded.file_path, position = excluded.position, updated_at = excluded.updated_at`,
      [tab.id, tab.connectionId, tab.title, tab.content, tab.filePath, tab.position, updatedAt],
    );
    return { ...tab, updatedAt };
  }

  delete(id: string): void {
    this.db.run("DELETE FROM tabs WHERE id = ?", [id]);
  }
}
