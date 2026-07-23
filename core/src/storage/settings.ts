// Traces: BASED-SETTINGS
// App-wide user preferences (theme, and future UI settings). Single-row JSON store, mirroring
// AiConfigStore — the webview holds no durable state, everything persists here in app.db.
import type { Database } from "bun:sqlite";

export interface AppSettings {
  /** Active theme id (see ui/src/theme.ts). */
  theme: string;
  /** Rows fetched per page in the table Data view. */
  rowPageSize: number;
  /** App-wide font-size multiplier (see ui/src/theme.ts). */
  fontScale: number;
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: "ledger",
  rowPageSize: 500,
  fontScale: 1,
};

export class SettingsStore {
  constructor(private readonly db: Database) {}

  get(): AppSettings {
    const row = this.db.query<{ json: string }, []>("SELECT json FROM app_settings WHERE id = 1").get();
    return row ? { ...DEFAULT_SETTINGS, ...(JSON.parse(row.json) as Partial<AppSettings>) } : DEFAULT_SETTINGS;
  }

  save(patch: Partial<AppSettings>): AppSettings {
    const next = { ...this.get(), ...patch };
    this.db.run("INSERT INTO app_settings (id, json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json", [
      JSON.stringify(next),
    ]);
    return next;
  }
}
