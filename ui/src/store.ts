import { create } from "zustand";
import { api, streamQuery } from "./api/client";
import { disposeModel, getModel } from "./editorModels";
import type {
  ColumnInfo,
  ConnectResponse,
  ConnectionConfig,
  ConnectionInput,
  ConnectionStatus,
  DbObject,
  TabRecord,
  TableColumn,
  TestResult,
  WireValue,
} from "./api/types";

export interface ResultSetData {
  columns: ColumnInfo[];
  rows: WireValue[][];
  rowCount: number;
  truncated: boolean;
  complete: boolean;
}

export interface OutputLine {
  kind: "message" | "error" | "system";
  text: string;
}

export interface QueryTabState {
  kind: "query";
  id: string;
  title: string;
  content: string;
  filePath: string | null;
  dirty: boolean;
  running: boolean;
  queryId: string | null;
  resultSets: ResultSetData[];
  activeResult: number;
  output: OutputLine[];
  stats: { durationMs: number; status: "ok" | "error" | "cancelled" } | null;
  /** bumped on streaming row appends so memoized grids re-read */
  version: number;
}

export interface TableTabState {
  kind: "table";
  id: string;
  title: string;
  schema: string;
  table: string;
  objectType: "table" | "view";
  columns: TableColumn[] | null;
  error: string | null;
}

export type TabState = QueryTabState | TableTabState;

export type DialogState = { mode: "closed" } | { mode: "new" } | { mode: "edit"; connection: ConnectionConfig };

interface AppState {
  connections: ConnectionConfig[];
  activeConnectionId: string | null;
  status: ConnectionStatus;
  statusDetail: string | null;
  databases: string[];
  database: string | null;
  schemas: string[];
  schemaFilter: string; // "" = all schemas
  objects: DbObject[];
  tabs: TabState[];
  activeTabId: string | null;
  dialog: DialogState;
  rightRailOpen: boolean;
  banner: string | null;

  loadConnections(): Promise<void>;
  saveConnection(input: ConnectionInput): Promise<ConnectionConfig>;
  deleteConnection(id: string): Promise<void>;
  testConnection(input: ConnectionInput): Promise<TestResult>;
  connect(connectionId: string, database?: string): Promise<void>;
  disconnect(): Promise<void>;
  setDatabase(database: string): Promise<void>;
  setSchemaFilter(schema: string): void;
  refreshObjects(): Promise<void>;
  setStatus(status: ConnectionStatus, detail?: string | null): void;

  newQueryTab(): void;
  openTableTab(schema: string, table: string, objectType: "table" | "view"): Promise<void>;
  closeTab(id: string): void;
  activateTab(id: string): void;
  setContent(id: string, content: string): void;
  setActiveResult(id: string, index: number): void;
  runQuery(id: string): Promise<void>;
  cancelQuery(id: string): Promise<void>;
  saveTab(id: string): Promise<void>;
  setDialog(dialog: DialogState): void;
  toggleRightRail(): void;
  setBanner(banner: string | null): void;
  insertSqlIntoEditor(sql: string): void;
  runSqlInNewTab(sql: string): Promise<void>;
}

function updateTab(tabs: TabState[], id: string, patch: Partial<QueryTabState>): TabState[] {
  return tabs.map((t) => (t.id === id && t.kind === "query" ? { ...t, ...patch } : t));
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;

export const useStore = create<AppState>((set, get) => {
  function persistTabsSoon(): void {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      const { tabs, activeConnectionId } = get();
      if (!activeConnectionId) return;
      const payload = tabs
        .filter((t): t is QueryTabState => t.kind === "query")
        .map((t, i) => ({
          id: t.id,
          connectionId: activeConnectionId,
          title: t.title,
          content: t.content,
          filePath: t.filePath,
          position: i,
        }));
      if (payload.length > 0) void api("/api/tabs", { method: "POST", body: JSON.stringify({ tabs: payload }) }).catch(() => {});
    }, 700);
  }

  function freshQueryTab(title: string): QueryTabState {
    return {
      kind: "query",
      id: crypto.randomUUID(),
      title,
      content: "",
      filePath: null,
      dirty: false,
      running: false,
      queryId: null,
      resultSets: [],
      activeResult: 0,
      output: [],
      stats: null,
      version: 0,
    };
  }

  function nextQueryTitle(tabs: TabState[]): string {
    const used = new Set(tabs.map((t) => t.title));
    for (let i = 1; ; i++) {
      const title = `Query ${i}`;
      if (!used.has(title)) return title;
    }
  }

  return {
    connections: [],
    activeConnectionId: null,
    status: "disconnected",
    statusDetail: null,
    databases: [],
    database: null,
    schemas: [],
    schemaFilter: "",
    objects: [],
    tabs: [],
    activeTabId: null,
    dialog: { mode: "closed" },
    rightRailOpen: false,
    banner: null,

    async loadConnections() {
      set({ connections: await api<ConnectionConfig[]>("/api/connections") });
    },

    async saveConnection(input) {
      const saved = await api<ConnectionConfig>("/api/connections", { method: "POST", body: JSON.stringify(input) });
      await get().loadConnections();
      return saved;
    },

    async deleteConnection(id) {
      await api(`/api/connections/${id}`, { method: "DELETE" });
      if (get().activeConnectionId === id) await get().disconnect();
      await get().loadConnections();
    },

    async testConnection(input) {
      return api<TestResult>("/api/connections/test", { method: "POST", body: JSON.stringify(input) });
    },

    async connect(connectionId, database) {
      set({ status: "connecting", statusDetail: null, banner: null });
      try {
        const res = await api<ConnectResponse>("/api/session/connect", {
          method: "POST",
          body: JSON.stringify({ connectionId, database }),
        });
        const records = await api<TabRecord[]>(`/api/tabs?connectionId=${connectionId}`);
        const tabs: TabState[] = records.map((r) => ({
          ...freshQueryTab(r.title),
          id: r.id,
          content: r.content,
          filePath: r.filePath,
        }));
        if (tabs.length === 0) tabs.push(freshQueryTab("Query 1"));
        set({
          activeConnectionId: connectionId,
          status: "connected",
          database: res.database,
          databases: res.databases,
          schemas: res.schemas,
          schemaFilter: "",
          objects: res.objects,
          tabs,
          activeTabId: tabs[0]!.id,
        });
      } catch (err) {
        set({ status: "disconnected", banner: err instanceof Error ? err.message : String(err) });
      }
    },

    async disconnect() {
      await api("/api/session/disconnect", { method: "POST" }).catch(() => {});
      set({
        activeConnectionId: null,
        status: "disconnected",
        database: null,
        databases: [],
        schemas: [],
        objects: [],
        tabs: [],
        activeTabId: null,
      });
    },

    async setDatabase(database) {
      const { activeConnectionId } = get();
      if (!activeConnectionId) return;
      set({ status: "connecting" });
      try {
        const res = await api<ConnectResponse>("/api/session/connect", {
          method: "POST",
          body: JSON.stringify({ connectionId: activeConnectionId, database }),
        });
        set({
          status: "connected",
          database: res.database,
          databases: res.databases,
          schemas: res.schemas,
          schemaFilter: "",
          objects: res.objects,
        });
      } catch (err) {
        set({ status: "connected", banner: err instanceof Error ? err.message : String(err) });
      }
    },

    setSchemaFilter(schema) {
      set({ schemaFilter: schema });
    },

    async refreshObjects() {
      const res = await api<{ schemas: string[]; objects: DbObject[] }>("/api/session/objects");
      set({ schemas: res.schemas, objects: res.objects });
    },

    setStatus(status, detail) {
      set({ status, statusDetail: detail ?? null });
    },

    newQueryTab() {
      const tabs = get().tabs;
      const tab = freshQueryTab(nextQueryTitle(tabs));
      set({ tabs: [...tabs, tab], activeTabId: tab.id });
      persistTabsSoon();
    },

    async openTableTab(schema, table, objectType) {
      const id = `table:${schema}.${table}`;
      const existing = get().tabs.find((t) => t.id === id);
      if (existing) {
        set({ activeTabId: id });
        return;
      }
      const tab: TableTabState = {
        kind: "table",
        id,
        title: `${schema}.${table}`,
        schema,
        table,
        objectType,
        columns: null,
        error: null,
      };
      set({ tabs: [...get().tabs, tab], activeTabId: id });
      try {
        const columns = await api<TableColumn[]>(
          `/api/session/columns?schema=${encodeURIComponent(schema)}&table=${encodeURIComponent(table)}`,
        );
        set({ tabs: get().tabs.map((t) => (t.id === id && t.kind === "table" ? { ...t, columns } : t)) });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        set({ tabs: get().tabs.map((t) => (t.id === id && t.kind === "table" ? { ...t, error: message } : t)) });
      }
    },

    closeTab(id) {
      const { tabs, activeTabId } = get();
      const closing = tabs.find((t) => t.id === id);
      const remaining = tabs.filter((t) => t.id !== id);
      let nextActive = activeTabId;
      if (activeTabId === id) {
        const idx = tabs.findIndex((t) => t.id === id);
        nextActive = remaining[Math.min(idx, remaining.length - 1)]?.id ?? null;
      }
      set({ tabs: remaining, activeTabId: nextActive });
      if (closing?.kind === "query") {
        disposeModel(id);
        void api(`/api/tabs/${id}`, { method: "DELETE" }).catch(() => {});
      }
    },

    activateTab(id) {
      set({ activeTabId: id });
    },

    setContent(id, content) {
      set({ tabs: updateTab(get().tabs, id, { content, dirty: true }) });
      persistTabsSoon();
    },

    setActiveResult(id, index) {
      set({ tabs: updateTab(get().tabs, id, { activeResult: index }) });
    },

    async runQuery(id) {
      const tab = get().tabs.find((t) => t.id === id);
      if (!tab || tab.kind !== "query" || tab.running) return;
      if (get().status === "disconnected" || get().status === "connecting") return;
      if (!tab.content.trim()) return;

      set({
        tabs: updateTab(get().tabs, id, {
          running: true,
          queryId: null,
          resultSets: [],
          activeResult: 0,
          output: [],
          stats: null,
          version: 0,
        }),
      });

      const patch = (p: Partial<QueryTabState>) => set({ tabs: updateTab(get().tabs, id, p) });
      const current = () => get().tabs.find((t) => t.id === id) as QueryTabState | undefined;

      try {
        await streamQuery(tab.content, (chunk) => {
          const t = current();
          if (!t) return;
          switch (chunk.type) {
            case "start":
              patch({ queryId: chunk.queryId });
              break;
            case "resultset": {
              const sets = [...t.resultSets, { columns: chunk.columns, rows: [], rowCount: 0, truncated: false, complete: false }];
              patch({ resultSets: sets, version: t.version + 1 });
              break;
            }
            case "rows": {
              const last = t.resultSets[t.resultSets.length - 1];
              if (last) {
                last.rows.push(...chunk.rows); // mutate the big array in place; version bump triggers re-read
                patch({ version: t.version + 1 });
              }
              break;
            }
            case "resultsetEnd": {
              const sets = t.resultSets.map((s, i) =>
                i === t.resultSets.length - 1 ? { ...s, rowCount: chunk.rowCount, truncated: chunk.truncated, complete: true } : s,
              );
              patch({ resultSets: sets, version: t.version + 1 });
              break;
            }
            case "message":
              patch({ output: [...t.output, { kind: "message", text: chunk.text }] });
              break;
            case "error":
              patch({
                output: [
                  ...t.output,
                  { kind: "error", text: chunk.line != null ? `Error${chunk.code ? ` ${chunk.code}` : ""} (line ${chunk.line}): ${chunk.message}` : chunk.message },
                ],
              });
              break;
            case "cancelled":
              patch({ output: [...t.output, { kind: "system", text: "Query cancelled." }] });
              break;
            case "done":
              patch({ stats: { durationMs: chunk.durationMs, status: chunk.status }, running: false, queryId: null });
              break;
          }
        });
      } catch (err) {
        const t = current();
        patch({
          running: false,
          queryId: null,
          stats: { durationMs: 0, status: "error" },
          output: [...(t?.output ?? []), { kind: "error", text: err instanceof Error ? err.message : String(err) }],
        });
      }
    },

    async cancelQuery(id) {
      const tab = get().tabs.find((t) => t.id === id);
      if (!tab || tab.kind !== "query" || !tab.queryId) return;
      await api("/api/session/cancel", { method: "POST", body: JSON.stringify({ queryId: tab.queryId }) }).catch(() => {});
    },

    async saveTab(id) {
      const tab = get().tabs.find((t) => t.id === id);
      if (!tab || tab.kind !== "query") return;
      const res = await api<{ path: string | null }>("/api/file/save-sql", {
        method: "POST",
        body: JSON.stringify({
          content: tab.content,
          path: tab.filePath ?? undefined,
          defaultName: tab.filePath ? undefined : `${tab.title.replace(/[^\w.-]+/g, "-").toLowerCase()}.sql`,
        }),
      });
      if (res.path) {
        const title = res.path.split(/[\\/]/).pop() ?? tab.title;
        set({ tabs: updateTab(get().tabs, id, { filePath: res.path, title, dirty: false }) });
        persistTabsSoon();
      }
    },

    setDialog(dialog) {
      set({ dialog });
    },

    toggleRightRail() {
      set({ rightRailOpen: !get().rightRailOpen });
    },

    setBanner(banner) {
      set({ banner });
    },

    // Insert agent-generated SQL into the active query tab (creating one if needed). Writes through
    // the Monaco model so the visible editor updates and content persists.
    insertSqlIntoEditor(sql) {
      const state = get();
      let target = state.tabs.find((t) => t.id === state.activeTabId && t.kind === "query") as QueryTabState | undefined;
      if (!target) target = state.tabs.find((t): t is QueryTabState => t.kind === "query");
      if (!target) {
        const tab = freshQueryTab(nextQueryTitle(state.tabs));
        set({ tabs: [...state.tabs, tab], activeTabId: tab.id });
        target = tab;
      } else {
        set({ activeTabId: target.id });
      }
      const model = getModel(target.id, target.content);
      const existing = model.getValue();
      const next = existing.trim() ? `${existing.replace(/\s*$/, "")}\n\n${sql}\n` : `${sql}\n`;
      model.setValue(next);
      get().setContent(target.id, next);
    },

    // Open a fresh query tab with the given SQL and run it immediately (chat "Run" affordance).
    async runSqlInNewTab(sql) {
      const state = get();
      const tab: QueryTabState = { ...freshQueryTab(nextQueryTitle(state.tabs)), content: sql };
      set({ tabs: [...state.tabs, tab], activeTabId: tab.id });
      getModel(tab.id, sql).setValue(sql);
      await get().runQuery(tab.id);
    },
  };
});

export function activeQueryTab(state: AppState): QueryTabState | null {
  const tab = state.tabs.find((t) => t.id === state.activeTabId);
  return tab?.kind === "query" ? tab : null;
}
