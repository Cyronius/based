import { Database } from "bun:sqlite";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

export function dataDir(): string {
  const dir = process.env.BASED_DATA_DIR ?? join(process.env.APPDATA ?? ".", "based");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Idempotently adds a column to an existing table — `CREATE TABLE IF NOT EXISTS` doesn't alter a
 *  table that was already provisioned by an earlier app version. */
function ensureColumn(db: Database, table: string, column: string, ddl: string): void {
  const cols = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

export function openDb(path?: string): Database {
  const db = new Database(path ?? join(dataDir(), "app.db"));
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS connections (
      id TEXT PRIMARY KEY,
      json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tabs (
      id TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      file_path TEXT,
      position INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tabs_connection ON tabs(connection_id, position);
    CREATE TABLE IF NOT EXISTS window_state (
      sid TEXT PRIMARY KEY,
      connection_id TEXT,
      active_tab_id TEXT,
      schema_filter TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      connection_id TEXT NOT NULL,
      database TEXT NOT NULL,
      sql TEXT NOT NULL,
      started_at TEXT NOT NULL,
      duration_ms INTEGER,
      status TEXT NOT NULL,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_history_connection ON history(connection_id, id DESC);
    CREATE TABLE IF NOT EXISTS ai_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS app_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_instructions (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS embedding_profiles (
      id TEXT PRIMARY KEY,
      json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reranker_profiles (
      id TEXT PRIMARY KEY,
      json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ai_profiles (
      id TEXT PRIMARY KEY,
      json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      connection_id TEXT NOT NULL,
      database TEXT NOT NULL,
      kind TEXT NOT NULL,
      sql TEXT NOT NULL,
      approved INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL,
      duration_ms INTEGER,
      status TEXT NOT NULL,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_audit_connection ON agent_audit(connection_id, id DESC);
  `);
  ensureColumn(db, "tabs", "kind", "kind TEXT NOT NULL DEFAULT 'query'");
  ensureColumn(db, "tabs", "meta", "meta TEXT");
  return db;
}
