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
  /** Active AI provider profile id (see BASED-AI-PROVIDER-PROFILES); null until one exists. */
  activeAiProfileId: string | null;
  /** Explorer double-click action for tables/views (BASED-EXPLORER-ACTION). */
  explorerTableAction: "details" | "data" | "sql" | "script-create";
  /** Explorer double-click action for procedures/functions (no Data view). */
  explorerRoutineAction: "details" | "script-create";
  /** Query-editor keymap (BASED-EDITOR-VIM): stock Monaco bindings, or modal vim. */
  editorKeymap: "default" | "vim";
  /** Where an OS .sql file-open lands (BASED-SQL-OPEN-TARGET): a tab in the last-focused window,
   *  or a new window. Multi-selected files always share one window either way. */
  sqlFileOpenTarget: "current-window" | "new-window";
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: "ledger",
  rowPageSize: 500,
  fontScale: 1,
  activeAiProfileId: null,
  explorerTableAction: "details",
  explorerRoutineAction: "details",
  editorKeymap: "default",
  sqlFileOpenTarget: "current-window",
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
