// Traces: BASED-CONN-STORE, BASED-CONN-SETTINGS-BAG
// Rows are read through migrateConnection, so a connection saved before engine-specific fields
// moved into `settings` still resolves; it is rewritten in the new shape the next time it is saved.
import type { Database } from "bun:sqlite";
import { migrateConnection } from "../db/connectionSettings";
import type { ConnectionConfig, ConnectionInput } from "../db/types";

export class ConnectionStore {
  constructor(private readonly db: Database) {}

  list(): ConnectionConfig[] {
    const rows = this.db.query<{ json: string }, []>("SELECT json FROM connections").all();
    return rows
      .map((r) => migrateConnection(JSON.parse(r.json) as ConnectionConfig))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id: string): ConnectionConfig | null {
    const row = this.db.query<{ json: string }, [string]>("SELECT json FROM connections WHERE id = ?").get(id);
    return row ? migrateConnection(JSON.parse(row.json) as ConnectionConfig) : null;
  }

  /** Persists metadata only — the transient `secret` on ConnectionInput never reaches this store. */
  save(input: ConnectionInput): ConnectionConfig {
    const now = new Date().toISOString();
    const existing = input.id ? this.get(input.id) : null;
    const { secret: _secret, ...meta } = input;
    const cfg: ConnectionConfig = migrateConnection({
      ...meta,
      settings: meta.settings ?? {},
      id: input.id ?? crypto.randomUUID(),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
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

  /** Traces: BASED-LANCE-CONN-DEFAULT-PROFILES — a deleted embedding/reranker profile must stop
   *  being any connection's default. Profile ids are uuids unique across both stores, so one sweep
   *  covers whichever kind was deleted. Resolution tolerates a dangling id anyway; this keeps the
   *  stored config honest (and the connection dialog showing "None"). */
  clearSearchProfileRefs(profileId: string): void {
    for (const cfg of this.list()) {
      const embedding = cfg.defaultEmbeddingProfileId === profileId;
      const reranker = cfg.defaultRerankerProfileId === profileId;
      if (!embedding && !reranker) continue;
      this.db.run("UPDATE connections SET json = ? WHERE id = ?", [
        JSON.stringify({
          ...cfg,
          defaultEmbeddingProfileId: embedding ? null : (cfg.defaultEmbeddingProfileId ?? null),
          defaultRerankerProfileId: reranker ? null : (cfg.defaultRerankerProfileId ?? null),
        }),
        cfg.id,
      ]);
    }
  }
}
