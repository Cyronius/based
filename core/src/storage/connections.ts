// Traces: BASED-CONN-STORE
import type { Database } from "bun:sqlite";
import type { ConnectionConfig, ConnectionInput } from "../db/types";

export class ConnectionStore {
  constructor(private readonly db: Database) {}

  list(): ConnectionConfig[] {
    const rows = this.db.query<{ json: string }, []>("SELECT json FROM connections").all();
    return rows
      .map((r) => JSON.parse(r.json) as ConnectionConfig)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id: string): ConnectionConfig | null {
    const row = this.db.query<{ json: string }, [string]>("SELECT json FROM connections WHERE id = ?").get(id);
    return row ? (JSON.parse(row.json) as ConnectionConfig) : null;
  }

  /** Persists metadata only — the transient `secret` on ConnectionInput never reaches this store. */
  save(input: ConnectionInput): ConnectionConfig {
    const now = new Date().toISOString();
    const existing = input.id ? this.get(input.id) : null;
    const { secret: _secret, ...meta } = input;
    const cfg: ConnectionConfig = {
      ...meta,
      id: input.id ?? crypto.randomUUID(),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.db.run(
      "INSERT INTO connections (id, json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json",
      [cfg.id, JSON.stringify(cfg)],
    );
    return cfg;
  }

  delete(id: string): void {
    this.db.run("DELETE FROM connections WHERE id = ?", [id]);
    this.db.run("DELETE FROM tabs WHERE connection_id = ?", [id]);
  }
}
