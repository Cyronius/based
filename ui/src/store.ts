import { create } from "zustand";
import {
  api,
  streamQuery,
  getSettings,
  saveSettings,
  fetchObjectDefinition,
  fetchRoutineParameters,
  fetchWindowState,
  saveWindowState,
} from "./api/client";
import { applyTheme, themeHint } from "./theme";
import { disposeModel, getModel } from "./editorModels";
import type {
  ColumnInfo,
  ConnectResponse,
  ConnectionConfig,
  ConnectionInput,
  ConnectionStatus,
  DbObject,
  RoutineParameter,
  TabKind,
  TabRecord,
  TableColumn,
  TestResult,
  WireValue,
} from "./api/types";
import { engineOf } from "./api/types";

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
  /** Actual execution plan XML captured for this run (one entry per statement in the batch), or
   *  null when Execution Plan wasn't toggled on for the run. */
  plan: string[] | null;
  /** bumped on streaming row appends so memoized grids re-read */
  version: number;
  /** Set when this tab is the hidden SQL view backing a table/view tab's "SQL" mode — see
   *  ensureSqlView. Excluded from TabStrip and from tab persistence. */
  parentTabId?: string;
}

export interface TableTabState {
  kind: "table";
  id: string;
  title: string;
  schema: string;
  table: string;
  objectType: "table" | "view";
  columns: TableColumn[] | null;
  /** View definition text (CREATE VIEW body). Only fetched for objectType "view". */
  definition: string | null;
  error: string | null;
  /** Details = column metadata; Edit Data = editable row grid; SQL = prepopulated/autorun query view. */
  view: "details" | "data" | "sql";
}

export interface RoutineTabState {
  kind: "routine";
  id: string;
  title: string;
  schema: string;
  name: string;
  routineType: "procedure" | "function";
  definition: string | null;
  parameters: RoutineParameter[] | null;
  error: string | null;
}

export type TabState = QueryTabState | TableTabState | RoutineTabState;

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
  theme: string;
  rowPageSize: number;
  /** Global, session-only — capture an actual execution plan / client statistics on the next run. */
  capturePlan: boolean;
  captureStats: boolean;

  loadSettings(): Promise<void>;
  setTheme(id: string): void;
  setRowPageSize(n: number): void;
  toggleCapturePlan(): void;
  toggleCaptureStats(): void;
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
  /** BASED-UI-SESSION-RESUME: the based server lost this window's session (process restart) while
   *  the UI still thought it was connected. Re-establishes it with bounded backoff, preserving tabs. */
  resumeSession(): void;

  newQueryTab(): void;
  openTableTab(schema: string, table: string, objectType: "table" | "view"): Promise<void>;
  setTableView(id: string, view: "details" | "data" | "sql"): void;
  openRoutineTab(schema: string, name: string, routineType: "procedure" | "function"): Promise<void>;
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
  /** BASED-WINDOW-RESTORE: called once at boot — reconnects this window to whatever connection/tab/
   *  schema-filter it last showed, if any. */
  restoreWindow(): Promise<void>;
}

/** Kind-specific fields persisted alongside a table tab (BASED-TABSTORE). */
interface TableTabMeta {
  schema: string;
  table: string;
  objectType: "table" | "view";
  view: "details" | "data" | "sql";
}

/** Kind-specific fields persisted alongside a routine tab (BASED-TABSTORE). */
interface RoutineTabMeta {
  schema: string;
  name: string;
  routineType: "procedure" | "function";
}

function tabMeta(t: TabState): TableTabMeta | RoutineTabMeta | null {
  if (t.kind === "table") return { schema: t.schema, table: t.table, objectType: t.objectType, view: t.view };
  if (t.kind === "routine") return { schema: t.schema, name: t.name, routineType: t.routineType };
  return null;
}

/** In-session, per-window cache of a connection's full view state — keyed by connectionId so
 *  switching back to a connection already visited this session is an instant swap instead of a
 *  server refetch (BASED-CONN-SWITCH-CACHE). Module-level: survives store re-renders, scoped to
 *  this window's own JS context (each Electrobun window has its own). */
interface ConnectionSnapshot {
  database: string | null;
  databases: string[];
  schemas: string[];
  schemaFilter: string;
  objects: DbObject[];
  tabs: TabState[];
  activeTabId: string | null;
}
const connectionCache = new Map<string, ConnectionSnapshot>();

// BASED-UI-SESSION-RESUME backoff — mirrors core's MAX_RECONNECT_ATTEMPTS/backoff shape (separate
// runtime, so not literally shared code): capped exponential delay, ~23s total before giving up.
const RESUME_MAX_ATTEMPTS = 6;
const RESUME_BASE_DELAY_MS = 1000;
const RESUME_MAX_DELAY_MS = 8000;
let resumingSession = false;

function resumeDelay(attempt: number): Promise<void> {
  const ms = Math.min(RESUME_BASE_DELAY_MS * 2 ** (attempt - 1), RESUME_MAX_DELAY_MS);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function updateTab(tabs: TabState[], id: string, patch: Partial<QueryTabState>): TabState[] {
  return tabs.map((t) => (t.id === id && t.kind === "query" ? { ...t, ...patch } : t));
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;

/** All persistable tabs (every kind, excluding the hidden SQL-view tabs `ensureSqlView` creates
 *  behind a table/view tab's "SQL" mode) as the wire shape `/api/tabs` expects. */
function buildTabPayload(tabs: TabState[], connectionId: string): Array<Omit<TabRecord, "updatedAt">> {
  return tabs
    .filter((t) => !(t.kind === "query" && t.parentTabId))
    .map((t, i) => ({
      id: t.id,
      connectionId,
      title: t.title,
      content: t.kind === "query" ? t.content : "",
      filePath: t.kind === "query" ? t.filePath : null,
      position: i,
      kind: t.kind as TabKind,
      meta: tabMeta(t),
    }));
}

export const useStore = create<AppState>((set, get) => {
  function flushPendingTabs(): void {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    const { tabs, activeConnectionId } = get();
    if (!activeConnectionId) return;
    const payload = buildTabPayload(tabs, activeConnectionId);
    if (payload.length > 0) void api("/api/tabs", { method: "POST", body: JSON.stringify({ tabs: payload }) }).catch(() => {});
  }

  function persistTabsSoon(): void {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(flushPendingTabs, 700);
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
      plan: null,
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

  // Traces: BASED-TABLE-SQL-VIEW — lazily creates the hidden query tab backing a table/view tab's
  // "SQL" mode and runs it once.
  // Reruns are left to the user (F5/Ctrl+Enter) — revisiting "SQL" after this just re-renders the
  // same tab, so its resultSets (already cached on the object) show up with no extra bookkeeping.
  function ensureSqlView(tableTab: TableTabState): void {
    const linkedId = `sql:${tableTab.id}`;
    if (get().tabs.some((t) => t.id === linkedId)) return;
    const linked: QueryTabState = {
      ...freshQueryTab(`SQL: ${tableTab.title}`),
      id: linkedId,
      content: `SELECT * FROM [${tableTab.schema}].[${tableTab.table}]`,
      parentTabId: tableTab.id,
    };
    set({ tabs: [...get().tabs, linked] });
    void get().runQuery(linkedId);
  }

  // Fetches column metadata (+ view definition) for a table/view tab and patches it in — shared by
  // openTableTab (opening fresh from the explorer) and restoreWindow (rehydrating a persisted tab).
  function fetchTableTabDetails(id: string, schema: string, table: string, objectType: "table" | "view"): Promise<void> {
    const patchTab = (patch: Partial<TableTabState>) =>
      set({ tabs: get().tabs.map((t) => (t.id === id && t.kind === "table" ? { ...t, ...patch } : t)) });
    const columnsFetch = api<TableColumn[]>(
      `/api/session/columns?schema=${encodeURIComponent(schema)}&table=${encodeURIComponent(table)}`,
    )
      .then((columns) => patchTab({ columns }))
      .catch((err) => patchTab({ error: err instanceof Error ? err.message : String(err) }));
    const definitionFetch =
      objectType === "view"
        ? fetchObjectDefinition(schema, table)
            .then(({ definition }) => patchTab({ definition }))
            .catch(() => {})
        : Promise.resolve();
    return Promise.all([columnsFetch, definitionFetch]).then(() => {});
  }

  // Fetches definition + parameters for a routine tab and patches it in — shared by openRoutineTab
  // and restoreWindow.
  function fetchRoutineTabDetails(id: string, schema: string, name: string): Promise<void> {
    return Promise.all([fetchObjectDefinition(schema, name), fetchRoutineParameters(schema, name)])
      .then(([{ definition }, parameters]) => {
        set({ tabs: get().tabs.map((t) => (t.id === id && t.kind === "routine" ? { ...t, definition, parameters } : t)) });
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        set({ tabs: get().tabs.map((t) => (t.id === id && t.kind === "routine" ? { ...t, error: message } : t)) });
      });
  }

  // Rebuilds this connection's persisted tabs (all kinds) after a cache-miss connect — table/routine
  // tabs come back as stubs; their details are hydrated separately once they're in state (see callers).
  async function hydrateTabsForConnection(connectionId: string): Promise<{ tabs: TabState[]; activeTabId: string }> {
    const records = await api<TabRecord[]>(`/api/tabs?connectionId=${connectionId}`);
    const tabs: TabState[] = records.map((r) => {
      if (r.kind === "table") {
        const meta = r.meta as TableTabMeta;
        const tab: TableTabState = {
          kind: "table",
          id: r.id,
          title: r.title,
          schema: meta.schema,
          table: meta.table,
          objectType: meta.objectType,
          columns: null,
          definition: null,
          error: null,
          view: meta.view,
        };
        return tab;
      }
      if (r.kind === "routine") {
        const meta = r.meta as RoutineTabMeta;
        const tab: RoutineTabState = {
          kind: "routine",
          id: r.id,
          title: r.title,
          schema: meta.schema,
          name: meta.name,
          routineType: meta.routineType,
          definition: null,
          parameters: null,
          error: null,
        };
        return tab;
      }
      return { ...freshQueryTab(r.title), id: r.id, content: r.content, filePath: r.filePath };
    });
    if (tabs.length === 0) tabs.push(freshQueryTab("Query 1"));
    return { tabs, activeTabId: tabs[0]!.id };
  }

  // Kicks off the lazy per-kind detail fetch for each restored table/routine tab; query tabs need
  // nothing further.
  function hydrateTabDetails(tabs: TabState[]): void {
    for (const t of tabs) {
      if (t.kind === "table") void fetchTableTabDetails(t.id, t.schema, t.table, t.objectType);
      else if (t.kind === "routine") void fetchRoutineTabDetails(t.id, t.schema, t.name);
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
    theme: themeHint(),
    rowPageSize: 500,
    capturePlan: false,
    captureStats: false,

    // Theme is applied to <html> before React mounts (main.tsx) from the localStorage hint; the server
    // value is the source of truth and reconciles it here on boot.
    async loadSettings() {
      try {
        const s = await getSettings();
        applyTheme(s.theme);
        set({ theme: s.theme, rowPageSize: s.rowPageSize });
      } catch {
        // keep the hinted theme if the server is unreachable
      }
    },

    setTheme(id) {
      applyTheme(id);
      set({ theme: id });
      void saveSettings({ theme: id }).catch(() => {});
    },

    setRowPageSize(n) {
      set({ rowPageSize: n });
      void saveSettings({ rowPageSize: n }).catch(() => {});
    },

    toggleCapturePlan() {
      set({ capturePlan: !get().capturePlan });
    },

    toggleCaptureStats() {
      set({ captureStats: !get().captureStats });
    },

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
      connectionCache.delete(id);
      if (get().activeConnectionId === id) await get().disconnect();
      await get().loadConnections();
    },

    async testConnection(input) {
      return api<TestResult>("/api/connections/test", { method: "POST", body: JSON.stringify(input) });
    },

    async connect(connectionId, database) {
      const outgoingId = get().activeConnectionId;
      flushPendingTabs();
      if (outgoingId) {
        const s = get();
        connectionCache.set(outgoingId, {
          database: s.database,
          databases: s.databases,
          schemas: s.schemas,
          schemaFilter: s.schemaFilter,
          objects: s.objects,
          tabs: s.tabs,
          activeTabId: s.activeTabId,
        });
      }
      set({ status: "connecting", statusDetail: null, banner: null });
      try {
        const res = await api<ConnectResponse>("/api/session/connect", {
          method: "POST",
          body: JSON.stringify({ connectionId, database }),
        });
        // BASED-CONN-SWITCH-CACHE: a connection already visited this session (in this window)
        // restores instantly from the in-memory cache instead of refetching/discarding its tabs.
        const cached = database === undefined ? connectionCache.get(connectionId) : undefined;
        if (cached) {
          set({
            activeConnectionId: connectionId,
            status: "connected",
            database: res.database,
            databases: res.databases,
            schemas: res.schemas,
            schemaFilter: cached.schemaFilter,
            objects: res.objects,
            tabs: cached.tabs,
            activeTabId: cached.activeTabId,
          });
          return;
        }
        const { tabs, activeTabId } = await hydrateTabsForConnection(connectionId);
        set({
          activeConnectionId: connectionId,
          status: "connected",
          database: res.database,
          databases: res.databases,
          schemas: res.schemas,
          schemaFilter: "",
          objects: res.objects,
          tabs,
          activeTabId,
        });
        hydrateTabDetails(tabs);
      } catch (err) {
        set({ status: "disconnected", banner: err instanceof Error ? err.message : String(err) });
      }
    },

    async disconnect() {
      await api("/api/session/disconnect", { method: "POST" }).catch(() => {});
      const { activeConnectionId } = get();
      if (activeConnectionId) connectionCache.delete(activeConnectionId);
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
      void saveWindowState({ schemaFilter: schema }).catch(() => {});
    },

    async refreshObjects() {
      const res = await api<{ schemas: string[]; objects: DbObject[] }>("/api/session/objects");
      set({ schemas: res.schemas, objects: res.objects });
    },

    setStatus(status, detail) {
      set({ status, statusDetail: detail ?? null });
    },

    resumeSession() {
      if (resumingSession) return;
      const { activeConnectionId, database } = get();
      if (!activeConnectionId) return;
      resumingSession = true;
      set({ status: "reconnecting", statusDetail: "server connection lost" });
      void (async () => {
        try {
          for (let attempt = 1; attempt <= RESUME_MAX_ATTEMPTS; attempt++) {
            await get().connect(activeConnectionId, database ?? undefined);
            if (get().status === "connected") return;
            if (attempt < RESUME_MAX_ATTEMPTS) {
              set({ status: "reconnecting", statusDetail: "server connection lost" });
              await resumeDelay(attempt);
            }
          }
          set({
            status: "disconnected",
            banner: "Lost connection to the based server and couldn't reconnect automatically. Click Reconnect to try again.",
          });
        } finally {
          resumingSession = false;
        }
      })();
    },

    newQueryTab() {
      const { tabs, connections, activeConnectionId } = get();
      const conn = connections.find((c) => c.id === activeConnectionId);
      // LanceDB has no SQL editor; the object browser + agent search are the query surface.
      if (conn && engineOf(conn) === "lancedb") return;
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
        definition: null,
        error: null,
        view: "details",
      };
      set({ tabs: [...get().tabs, tab], activeTabId: id });
      persistTabsSoon();
      await fetchTableTabDetails(id, schema, table, objectType);
    },

    setTableView(id, view) {
      set({ tabs: get().tabs.map((t) => (t.id === id && t.kind === "table" ? { ...t, view } : t)) });
      persistTabsSoon();
      if (view === "sql") {
        const t = get().tabs.find((t) => t.id === id);
        if (t && t.kind === "table") ensureSqlView(t);
      }
    },

    async openRoutineTab(schema, name, routineType) {
      const id = `routine:${schema}.${name}`;
      const existing = get().tabs.find((t) => t.id === id);
      if (existing) {
        set({ activeTabId: id });
        return;
      }
      const tab: RoutineTabState = {
        kind: "routine",
        id,
        title: `${schema}.${name}`,
        schema,
        name,
        routineType,
        definition: null,
        parameters: null,
        error: null,
      };
      set({ tabs: [...get().tabs, tab], activeTabId: id });
      persistTabsSoon();
      await fetchRoutineTabDetails(id, schema, name);
    },

    closeTab(id) {
      const { tabs, activeTabId } = get();
      const closing = tabs.find((t) => t.id === id);
      const linked = tabs.filter((t): t is QueryTabState => t.kind === "query" && t.parentTabId === id);
      const idsToRemove = new Set([id, ...linked.map((t) => t.id)]);
      const remaining = tabs.filter((t) => !idsToRemove.has(t.id));
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
      for (const l of linked) disposeModel(l.id);
    },

    activateTab(id) {
      set({ activeTabId: id });
      void saveWindowState({ activeTabId: id }).catch(() => {});
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
          plan: null,
          version: 0,
        }),
      });

      const patch = (p: Partial<QueryTabState>) => set({ tabs: updateTab(get().tabs, id, p) });
      const current = () => get().tabs.find((t) => t.id === id) as QueryTabState | undefined;
      const { capturePlan, captureStats, rowPageSize } = get();

      try {
        await streamQuery(
          tab.content,
          (chunk) => {
            const t = current();
            if (!t) return;
            switch (chunk.type) {
              case "start":
                patch({ queryId: chunk.queryId });
                break;
              case "plan":
                patch({ plan: [...(t.plan ?? []), chunk.xml] });
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
          },
          { capturePlan, captureStats, rowCap: rowPageSize },
        );
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
      // pushEditOperations (not setValue) keeps the model's undo stack and lets the cursor land
      // at the end of the insert instead of jumping to (1,1).
      model.pushEditOperations([], [{ range: model.getFullModelRange(), text: next }], () => null);
      get().setContent(target.id, next);
    },

    // Open a fresh query tab with the given SQL and run it immediately (chat "Run" affordance).
    async runSqlInNewTab(sql) {
      const state = get();
      const tab: QueryTabState = { ...freshQueryTab(nextQueryTitle(state.tabs)), content: sql };
      set({ tabs: [...state.tabs, tab], activeTabId: tab.id });
      const model = getModel(tab.id, sql);
      model.pushEditOperations([], [{ range: model.getFullModelRange(), text: sql }], () => null);
      await get().runQuery(tab.id);
    },

    async restoreWindow() {
      try {
        const ws = await fetchWindowState();
        if (!ws.connectionId || !get().connections.some((c) => c.id === ws.connectionId)) return;
        await get().connect(ws.connectionId);
        const patch: Partial<Pick<AppState, "activeTabId" | "schemaFilter">> = {};
        if (ws.activeTabId && get().tabs.some((t) => t.id === ws.activeTabId)) patch.activeTabId = ws.activeTabId;
        if (ws.schemaFilter) patch.schemaFilter = ws.schemaFilter;
        if (Object.keys(patch).length > 0) set(patch);
      } catch {
        // best-effort restore — leave the window at EmptyState on any failure
      }
    },
  };
});

export function activeQueryTab(state: AppState): QueryTabState | null {
  const tab = state.tabs.find((t) => t.id === state.activeTabId);
  return tab?.kind === "query" ? tab : null;
}
