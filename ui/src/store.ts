import { create } from "zustand";
import {
  api,
  streamQuery,
  getSettings,
  saveSettings,
  fetchObjectDefinition,
  fetchRelations,
  fetchRoutineParameters,
  fetchTableDetails,
  fetchTableIndexes,
  fetchRowCount,
  postScript,
  fetchWindowState,
  saveWindowState,
  listEmbeddingProfiles,
  listEngines,
  saveEmbeddingProfile as apiSaveEmbeddingProfile,
  deleteEmbeddingProfile as apiDeleteEmbeddingProfile,
  listRerankerProfiles,
  saveRerankerProfile as apiSaveRerankerProfile,
  deleteRerankerProfile as apiDeleteRerankerProfile,
  listAiProfiles,
  saveAiProfile as apiSaveAiProfile,
  deleteAiProfile as apiDeleteAiProfile,
  setActiveAiProfile as apiSetActiveAiProfile,
  openSqlFileApi,
  newWindowApi,
  setSessionHealer,
} from "./api/client";
import { applyTheme, themeHint, applyFontScale, fontScaleHint, clampFontScale } from "./theme";
import { disposeModel, getModel } from "./editorModels";
import { newChatThreadId } from "./agent/threadIds";
import { deriveTabTitle } from "./lib/deriveTabTitle";
import { profileFor, quoteIdent } from "./lib/engineProfile";
import type {
  AiProfile,
  AiProfileInput,
  ColumnInfo,
  ConnectResponse,
  ConnectionConfig,
  ConnectionInput,
  ConnectionStatus,
  DbObject,
  EmbeddingProfile,
  EngineProfile,
  EmbeddingProfileInput,
  EngineCapabilities,
  RelationsGraph,
  RerankerProfile,
  RerankerProfileInput,
  RoutineParameter,
  ScriptAction,
  TabKind,
  TabRecord,
  TableColumn,
  TableDetails,
  TableIndex,
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

/** One captured execution plan, tagged by source format so PlanView dispatches to the right parser
 *  (SQL Server showplan XML vs DuckDB profiling JSON). `data` is the raw payload for that format. */
export interface PlanDoc {
  format: "showplan-xml" | "duckdb-json";
  data: string;
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
  /** Actual execution plans captured for this run (one entry per statement in the batch), or null
   *  when Execution Plan wasn't toggled on. Each doc is engine-tagged so PlanView picks the right
   *  parser: SQL Server showplan XML vs DuckDB profiling JSON. */
  plan: PlanDoc[] | null;
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
  /** Full introspection for the enriched Details view (BASED-TABLE-DETAILS-UI); engines with
   *  capabilities.script only, null otherwise/until fetched. */
  details: TableDetails | null;
  /** Server-computed CREATE TABLE script (tables only). */
  createScript: string | null;
  /** Traces: BASED-INDEX-INTROSPECT — the table's indexes, on every engine that exposes them (not
   *  just DDL-scriptable ones). Null until fetched, [] when the table genuinely has none — which is
   *  itself the actionable fact on a vector table. */
  indexes: TableIndex[] | null;
  /** Traces: BASED-LANCE-SCAN — exact total row count, null until fetched or if unsupported. */
  rowCount: number | null;
  /** Traces: BASED-AGENT-SHOW-RESULTS — a browse predicate the agent asked for, consumed once by
   *  TableDataGrid on mount. This is how `show_results` lands rows in a real grid on a connection
   *  with no SQL editor to open a query tab in. */
  prefillWhere: string | null;
  error: string | null;
  /** Details = column metadata; Edit Data = editable row grid; SQL = prepopulated/autorun query
   *  view; Embeddings = the vector scatter (BASED-EMBED-UI, vector tables only). */
  view: TableViewId;
}

/** Sub-views of a table tab. "embeddings" renders only for tables with a vector column. */
export type TableViewId = "details" | "data" | "sql" | "embeddings";

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

// Traces: BASED-DIAGRAM-UI — ER diagram tab (mssql only, capabilities.relations).
export interface DiagramTabState {
  kind: "diagram";
  id: string;
  title: string;
  /** "" = whole database. */
  schemaScope: string;
  graph: RelationsGraph | null;
  error: string | null;
}

// Traces: BASED-HELP-DOCS — the help tab. No metadata and nothing to fetch: DocsView renders
// static content, so the tab is its own identity.
export interface DocsTabState {
  kind: "docs";
  id: string;
  title: string;
}

export type TabState = QueryTabState | TableTabState | RoutineTabState | DiagramTabState | DocsTabState;

export type DialogState = { mode: "closed" } | { mode: "new" } | { mode: "edit"; connection: ConnectionConfig };

export interface AppState {
  connections: ConnectionConfig[];
  /** Traces: BASED-ENGINE-PROFILE-WIRE — the engine catalog served by core. The UI enumerates no
   *  engines of its own; the connection dialog renders entirely from these profiles. */
  engines: EngineProfile[];
  activeConnectionId: string | null;
  status: ConnectionStatus;
  statusDetail: string | null;
  capabilities: EngineCapabilities | null;
  embeddingProfiles: EmbeddingProfile[];
  rerankerProfiles: RerankerProfile[];
  aiProfiles: AiProfile[];
  activeAiProfileId: string | null;
  databases: string[];
  database: string | null;
  schemas: string[];
  schemaFilter: string; // "" = all schemas
  objects: DbObject[];
  tabs: TabState[];
  activeTabId: string | null;
  /** This window's active capi conversation per connection (BASED-CHAT-HISTORY-PICKER). The
   *  current connection's entry is mirrored into window state so a restart reopens the same one. */
  capiThreads: Record<string, string>;
  dialog: DialogState;
  /** New Table dialog visibility (BASED-LANCE-CREATE-TABLE-UI). */
  newTableOpen: boolean;
  rightRailOpen: boolean;
  banner: string | null;
  theme: string;
  rowPageSize: number;
  fontScale: number;
  /** Explorer double-click actions (BASED-EXPLORER-ACTION). */
  explorerTableAction: "details" | "data" | "sql" | "script-create";
  explorerRoutineAction: "details" | "script-create";
  /** Query-editor keymap (BASED-EDITOR-VIM). */
  editorKeymap: "default" | "vim";
  /** Global, session-only — capture an actual execution plan / client statistics on the next run. */
  capturePlan: boolean;
  captureStats: boolean;

  loadSettings(): Promise<void>;
  setTheme(id: string): void;
  setFontScale(n: number): void;
  setRowPageSize(n: number): void;
  setExplorerActions(table: AppState["explorerTableAction"], routine: AppState["explorerRoutineAction"]): void;
  setEditorKeymap(k: AppState["editorKeymap"]): void;
  toggleCapturePlan(): void;
  toggleCaptureStats(): void;
  loadConnections(): Promise<void>;
  saveConnection(input: ConnectionInput): Promise<ConnectionConfig>;
  deleteConnection(id: string): Promise<void>;
  testConnection(input: ConnectionInput): Promise<TestResult>;
  loadEngines(): Promise<void>;
  loadEmbeddingProfiles(): Promise<void>;
  saveEmbeddingProfile(input: EmbeddingProfileInput): Promise<EmbeddingProfile>;
  deleteEmbeddingProfile(id: string): Promise<void>;
  loadRerankerProfiles(): Promise<void>;
  saveRerankerProfile(input: RerankerProfileInput): Promise<RerankerProfile>;
  deleteRerankerProfile(id: string): Promise<void>;
  loadAiProfiles(): Promise<void>;
  saveAiProfile(input: AiProfileInput): Promise<AiProfile>;
  deleteAiProfile(id: string): Promise<void>;
  setActiveAiProfile(id: string): Promise<void>;
  connect(connectionId: string, database?: string): Promise<void>;
  disconnect(): Promise<void>;
  setDatabase(database: string): Promise<void>;
  setSchemaFilter(schema: string): void;
  refreshObjects(): Promise<void>;
  setStatus(status: ConnectionStatus, detail?: string | null): void;
  /** BASED-UI-SESSION-RESUME: the based server lost this window's session (process restart) while
   *  the UI still thought it was connected. Re-establishes it with bounded backoff, preserving tabs.
   *  Resolves true once reconnected, false if the backoff cap was exhausted. Concurrent callers
   *  (SSE snapshot + a healing API retry) share one in-flight attempt. */
  resumeSession(): Promise<boolean>;

  newQueryTab(): void;
  /** `view` sets the initial sub-view on creation (BASED-EXPLORER-ACTION); an existing tab is
   *  activated as-is. Returns the tab id — ids are random, so callers that need to patch the tab
   *  afterwards (openTableTabWithQuery) can only get it from here. */
  openTableTab(schema: string, table: string, objectType: "table" | "view", view?: TableViewId): Promise<string>;
  setTableView(id: string, view: TableViewId): void;
  openRoutineTab(schema: string, name: string, routineType: "procedure" | "function"): Promise<string>;
  closeTab(id: string): void;
  closeTabs(ids: string[]): void;
  activateTab(id: string): void;
  reorderTab(draggedId: string, targetId: string, position: "before" | "after"): void;
  setContent(id: string, content: string): void;
  setActiveResult(id: string, index: number): void;
  runQuery(id: string): Promise<void>;
  cancelQuery(id: string): Promise<void>;
  /** `as: true` always pops the save dialog (Save As), even on a file-backed tab. */
  saveTab(id: string, opts?: { as?: boolean }): Promise<void>;
  /** Open a .sql file into a new query tab (BASED-FILE-OPEN-SQL); a tab already backed by the
   *  chosen file is activated instead. No `path` → native dialog; explicit `path` skips it
   *  (BASED-OPEN-SQL-ARGV: OS file-association launches). */
  openSqlFile(path?: string): Promise<void>;
  /** BASED-CTRL-N: asks the shell to open a new native window; a no-op under BASED_DEV_URL dev mode. */
  newWindow(): Promise<void>;
  setDialog(dialog: DialogState): void;
  setNewTableOpen(open: boolean): void;
  toggleRightRail(): void;
  setBanner(banner: string | null): void;
  insertSqlIntoEditor(sql: string): void;
  /** Returns the new tab's id (so the agent's show_results can report it). */
  runSqlInNewTab(sql: string, title?: string | null): Promise<string>;
  /** Open a fresh query tab with the given content WITHOUT running it (history "Open in new tab",
   *  Script-as output). `title` null → next "Query N". Returns the new tab's id, or null when the
   *  engine has no SQL surface. */
  newQueryTabWithContent(title: string | null, content: string): string | null;
  /** Traces: BASED-AGENT-SHOW-RESULTS — open (or reuse) a table tab in its Data view, optionally
   *  pre-filtered by an engine `where` predicate. This is `show_results` on a connection with no SQL
   *  editor: without it, a Cloud session loses the "rows land in a real grid" norm exactly where it
   *  also can't aggregate, and every answer degrades to rows pasted into chat. Returns the tab id. */
  openTableTabWithQuery(schema: string, table: string, where?: string): Promise<string>;
  /** Move this window's active conversation for a connection — "New chat" mints a fresh id, the
   *  history picker reactivates a past one (BASED-CHAT-HISTORY-PICKER). */
  setCapiThread(connectionId: string, threadId: string): void;
  /** Script objects as CREATE/DROP/etc. into one new query tab (BASED-UI-SCRIPT-AS). */
  scriptObjects(objects: Array<{ schema: string; name: string; type: "table" | "view" | "procedure" | "function" }>, action: ScriptAction): Promise<void>;
  /** Open (or focus) the ER diagram tab for a schema scope (BASED-DIAGRAM-UI). "" = whole database.
   *  Returns the tab id, or null when the engine has no relations capability. */
  openDiagramTab(scope: string): string | null;
  /** Open (or focus) the help tab (BASED-HELP-DOCS). One per window, and the only tab that may be
   *  opened with no connection active. */
  openDocsTab(): void;
  /** Change a diagram tab's schema scope and refetch its graph. */
  setDiagramScope(id: string, scope: string): void;
  /** BASED-WINDOW-RESTORE: called once at boot — reconnects this window to whatever connection/tab/
   *  schema-filter it last showed, if any. */
  restoreWindow(): Promise<void>;
}

/** Kind-specific fields persisted alongside a table tab (BASED-TABSTORE). */
interface TableTabMeta {
  schema: string;
  table: string;
  objectType: "table" | "view";
  view: TableViewId;
}

/** Kind-specific fields persisted alongside a routine tab (BASED-TABSTORE). */
interface RoutineTabMeta {
  schema: string;
  name: string;
  routineType: "procedure" | "function";
}

/** Kind-specific fields persisted alongside a diagram tab (BASED-DIAGRAM-UI). */
interface DiagramTabMeta {
  schemaScope: string;
}

function tabMeta(t: TabState): TableTabMeta | RoutineTabMeta | DiagramTabMeta | null {
  if (t.kind === "table") return { schema: t.schema, table: t.table, objectType: t.objectType, view: t.view };
  if (t.kind === "routine") return { schema: t.schema, name: t.name, routineType: t.routineType };
  if (t.kind === "diagram") return { schemaScope: t.schemaScope };
  return null;
}

/** In-session, per-window cache of a connection's full view state — keyed by connectionId so
 *  switching back to a connection already visited this session is an instant swap instead of a
 *  server refetch (BASED-CONN-SWITCH-CACHE). Module-level: survives store re-renders, scoped to
 *  this window's own JS context (each shell window has its own). */
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
// The single in-flight resume attempt, shared by every caller (an SSE divergent-snapshot trigger and
// any number of session-lost API retries) so a burst of failed requests collapses to one reconnect.
let resumePromise: Promise<boolean> | null = null;

function resumeDelay(attempt: number): Promise<void> {
  const ms = Math.min(RESUME_BASE_DELAY_MS * 2 ** (attempt - 1), RESUME_MAX_DELAY_MS);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function updateTab(tabs: TabState[], id: string, patch: Partial<QueryTabState>): TabState[] {
  return tabs.map((t) => (t.id === id && t.kind === "query" ? { ...t, ...patch } : t));
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;

// Traces: BASED-UI-FONT-ZOOM — font scale arrives as a stream of events (a wheel gesture or a
// slider drag is dozens), so the local apply is immediate but the server write trails the gesture.
let fontScaleTimer: ReturnType<typeof setTimeout> | null = null;
function persistFontScaleSoon(fontScale: number): void {
  if (fontScaleTimer) clearTimeout(fontScaleTimer);
  fontScaleTimer = setTimeout(() => {
    fontScaleTimer = null;
    void saveSettings({ fontScale }).catch(() => {});
  }, 400);
}

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
    // Always POST (even an empty set) so the server can prune closed tabs — the persisted set
    // mirrors the open set. connectionId is sent explicitly so an empty payload still scopes.
    void api("/api/tabs", {
      method: "POST",
      body: JSON.stringify({ connectionId: activeConnectionId, tabs: payload }),
    }).catch(() => {});
  }

  function persistTabsSoon(): void {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(flushPendingTabs, 700);
  }

  // Traces: BASED-CHAT-HISTORY-PICKER — every connect leaves the window with an active
  // conversation for that connection (minting one if it has none) and mirrors it into window
  // state, so a restart reopens the same conversation and a connection switch never leaves the
  // persisted pointer pointing at another connection's thread.
  function ensureCapiThread(connectionId: string): void {
    const existing = get().capiThreads[connectionId];
    const threadId = existing ?? newChatThreadId();
    if (!existing) set({ capiThreads: { ...get().capiThreads, [connectionId]: threadId } });
    void saveWindowState({ capiThreadId: threadId }).catch(() => {});
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

  /** Tab title for a schema-qualified object; schemaless engines (LanceDB) get the bare name
   *  rather than a dangling ".name". */
  function objectTabTitle(schema: string, name: string): string {
    return schema ? `${schema}.${name}` : name;
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
    // The link is `parentTabId`, not a derived id — same lookup TableDetailsView uses to find it.
    if (get().tabs.some((t) => t.kind === "query" && t.parentTabId === tableTab.id)) return;
    const { connections, activeConnectionId, engines } = get();
    const conn = connections.find((c) => c.id === activeConnectionId);
    // Engine-appropriate quoting comes from the served engine profile, not from an id comparison.
    // LanceDB is the one shape that also needs a middle `main` qualifier, and its `schema` is the
    // base-folder namespace (empty for a single-db dir) (BASED-LANCE-SQL-GATING).
    const profile = conn ? profileFor(conn, engines) : undefined;
    const q = (name: string) => quoteIdent(name, profile);
    const content =
      conn && engineOf(conn) === "lancedb"
        ? tableTab.schema
          ? `SELECT * FROM ${q(tableTab.schema)}.main.${q(tableTab.table)}`
          : `SELECT * FROM ${q(tableTab.table)}`
        : `SELECT * FROM ${q(tableTab.schema)}.${q(tableTab.table)}`;
    const linked: QueryTabState = {
      ...freshQueryTab(`SQL: ${tableTab.title}`),
      content,
      parentTabId: tableTab.id,
    };
    set({ tabs: [...get().tabs, linked] });
    void get().runQuery(linked.id);
  }

  // Fetches column metadata (+ view definition) for a table/view tab and patches it in — shared by
  // openTableTab (opening fresh from the explorer) and restoreWindow (rehydrating a persisted tab).
  function fetchTableTabDetails(id: string, schema: string, table: string, objectType: "table" | "view"): Promise<void> {
    const patchTab = (patch: Partial<TableTabState>) =>
      set({ tabs: get().tabs.map((t) => (t.id === id && t.kind === "table" ? { ...t, ...patch } : t)) });
    // Traces: BASED-TABLE-DETAILS-UI — engines with `script` get the full introspection in one call
    // (its columns are a superset of TableColumn, so they patch `columns` too); others keep the
    // plain columns path (LanceDB unchanged).
    const columnsFetch = get().capabilities?.script
      ? fetchTableDetails(schema, table)
          .then(({ details, createScript }) => patchTab({ details, createScript, columns: details.columns }))
          .catch((err) => patchTab({ error: err instanceof Error ? err.message : String(err) }))
      : api<TableColumn[]>(`/api/session/columns?schema=${encodeURIComponent(schema)}&table=${encodeURIComponent(table)}`)
          .then((columns) => patchTab({ columns }))
          .catch((err) => patchTab({ error: err instanceof Error ? err.message : String(err) }));
    const definitionFetch =
      objectType === "view"
        ? fetchObjectDefinition(schema, table)
            .then(({ definition }) => patchTab({ definition }))
            .catch(() => {})
        : Promise.resolve();
    // Traces: BASED-INDEX-INTROSPECT, BASED-LANCE-SCAN — both engines, not just DDL-scriptable ones.
    // Either failing is cosmetic: the panel just doesn't render, it never blocks the tab.
    const indexFetch = get().capabilities?.indexIntrospect
      ? fetchTableIndexes(schema, table)
          .then(({ indexes }) => patchTab({ indexes }))
          .catch(() => {})
      : Promise.resolve();
    const countFetch = get().capabilities?.countRows
      ? fetchRowCount(schema, table)
          .then(({ count }) => patchTab({ rowCount: count }))
          .catch(() => {})
      : Promise.resolve();
    return Promise.all([columnsFetch, definitionFetch, indexFetch, countFetch]).then(() => {});
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
          title: objectTabTitle(meta.schema, meta.table),
          schema: meta.schema,
          table: meta.table,
          objectType: meta.objectType,
          columns: null,
          definition: null,
          details: null,
          createScript: null,
          indexes: null,
          rowCount: null,
          prefillWhere: null,
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
          title: objectTabTitle(meta.schema, meta.name),
          schema: meta.schema,
          name: meta.name,
          routineType: meta.routineType,
          definition: null,
          parameters: null,
          error: null,
        };
        return tab;
      }
      if (r.kind === "diagram") {
        const meta = r.meta as DiagramTabMeta;
        const tab: DiagramTabState = {
          kind: "diagram",
          id: r.id,
          title: r.title,
          schemaScope: meta?.schemaScope ?? "",
          graph: null,
          error: null,
        };
        return tab;
      }
      // No meta and no detail fetch — the help tab restores whole (BASED-HELP-DOCS).
      if (r.kind === "docs") return { kind: "docs", id: r.id, title: r.title } satisfies DocsTabState;
      // (A legacy originThreadId in old rows' meta is ignored — per-tab thread aliasing is gone.)
      return {
        ...freshQueryTab(r.title),
        id: r.id,
        content: r.content,
        filePath: r.filePath,
      };
    });
    if (tabs.length === 0) tabs.push(freshQueryTab("Query 1"));
    return { tabs, activeTabId: tabs[0]!.id };
  }

  // Kicks off the lazy per-kind detail fetch for each restored table/routine/diagram tab; query
  // tabs need nothing further.
  function hydrateTabDetails(tabs: TabState[]): void {
    for (const t of tabs) {
      if (t.kind === "table") void fetchTableTabDetails(t.id, t.schema, t.table, t.objectType);
      else if (t.kind === "routine") void fetchRoutineTabDetails(t.id, t.schema, t.name);
      else if (t.kind === "diagram") void fetchDiagramGraph(t.id, t.schemaScope);
    }
  }

  // Traces: BASED-DIAGRAM-UI — fetch + patch a diagram tab's relations graph.
  function fetchDiagramGraph(id: string, scope: string): Promise<void> {
    const patch = (p: Partial<DiagramTabState>) =>
      set({ tabs: get().tabs.map((t) => (t.id === id && t.kind === "diagram" ? { ...t, ...p } : t)) });
    return fetchRelations(scope || undefined)
      .then((graph) => patch({ graph, error: null }))
      .catch((err) => patch({ error: err instanceof Error ? err.message : String(err) }));
  }

  return {
    connections: [],
    engines: [],
    activeConnectionId: null,
    status: "disconnected",
    statusDetail: null,
    capabilities: null,
    embeddingProfiles: [],
    rerankerProfiles: [],
    aiProfiles: [],
    activeAiProfileId: null,
    databases: [],
    database: null,
    schemas: [],
    schemaFilter: "",
    objects: [],
    tabs: [],
    activeTabId: null,
    capiThreads: {},
    dialog: { mode: "closed" },
    newTableOpen: false,
    rightRailOpen: false,
    banner: null,
    theme: themeHint(),
    rowPageSize: 500,
    fontScale: fontScaleHint(),
    explorerTableAction: "details",
    explorerRoutineAction: "details",
    editorKeymap: "default",
    capturePlan: false,
    captureStats: false,

    // Theme is applied to <html> before React mounts (main.tsx) from the localStorage hint; the server
    // value is the source of truth and reconciles it here on boot.
    async loadSettings() {
      try {
        const s = await getSettings();
        applyTheme(s.theme);
        applyFontScale(s.fontScale);
        set({
          theme: s.theme,
          rowPageSize: s.rowPageSize,
          fontScale: s.fontScale,
          activeAiProfileId: s.activeAiProfileId,
          explorerTableAction: s.explorerTableAction ?? "details",
          explorerRoutineAction: s.explorerRoutineAction ?? "details",
          editorKeymap: s.editorKeymap ?? "default",
        });
      } catch {
        // keep the hinted theme if the server is unreachable
      }
    },

    setTheme(id) {
      applyTheme(id);
      set({ theme: id });
      void saveSettings({ theme: id }).catch(() => {});
    },

    // Traces: BASED-UI-FONT-ZOOM — the one entry point for every font-size input (settings slider,
    // Ctrl+wheel, Ctrl+±/0); it owns the clamp so unbounded wheel input can't run off the scale.
    setFontScale(n) {
      const scale = clampFontScale(n);
      if (scale === get().fontScale) return;
      applyFontScale(scale);
      set({ fontScale: scale });
      persistFontScaleSoon(scale);
    },

    setRowPageSize(n) {
      set({ rowPageSize: n });
      void saveSettings({ rowPageSize: n }).catch(() => {});
    },

    setExplorerActions(table, routine) {
      set({ explorerTableAction: table, explorerRoutineAction: routine });
      void saveSettings({ explorerTableAction: table, explorerRoutineAction: routine }).catch(() => {});
    },

    setEditorKeymap(k) {
      set({ editorKeymap: k });
      void saveSettings({ editorKeymap: k }).catch(() => {});
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

    async loadEngines() {
      set({ engines: await listEngines() });
    },

    async loadEmbeddingProfiles() {
      set({ embeddingProfiles: await listEmbeddingProfiles() });
    },

    async saveEmbeddingProfile(input) {
      const saved = await apiSaveEmbeddingProfile(input);
      await get().loadEmbeddingProfiles();
      return saved;
    },

    async deleteEmbeddingProfile(id) {
      await apiDeleteEmbeddingProfile(id);
      await get().loadEmbeddingProfiles();
    },

    async loadRerankerProfiles() {
      set({ rerankerProfiles: await listRerankerProfiles() });
    },

    async saveRerankerProfile(input) {
      const saved = await apiSaveRerankerProfile(input);
      await get().loadRerankerProfiles();
      return saved;
    },

    async deleteRerankerProfile(id) {
      await apiDeleteRerankerProfile(id);
      await get().loadRerankerProfiles();
    },

    async loadAiProfiles() {
      set({ aiProfiles: await listAiProfiles() });
    },

    async saveAiProfile(input) {
      const saved = await apiSaveAiProfile(input);
      await get().loadAiProfiles();
      return saved;
    },

    async deleteAiProfile(id) {
      await apiDeleteAiProfile(id);
      await get().loadAiProfiles();
      if (get().activeAiProfileId === id) set({ activeAiProfileId: null });
    },

    async setActiveAiProfile(id) {
      const s = await apiSetActiveAiProfile(id);
      set({ activeAiProfileId: s.activeAiProfileId });
    },

    async connect(connectionId, database) {
      const outgoingId = get().activeConnectionId;
      // Traces: BASED-HELP-DOCS — a help tab opened with no connection had nowhere to persist to,
      // and connecting replaces the whole tab set. Carry it into the incoming connection (where it
      // then persists) instead of yanking it out from under someone mid-read. Only from the
      // no-connection state: switching A → B must NOT drag A's help tab along, since A's set is
      // cached and restored intact when you switch back.
      const carriedDocs = outgoingId ? null : (get().tabs.find((t) => t.kind === "docs") ?? null);
      const carriedDocsActive = carriedDocs != null && get().activeTabId === carriedDocs.id;
      const withCarriedDocs = (incoming: TabState[]) =>
        carriedDocs && !incoming.some((t) => t.kind === "docs") ? [...incoming, carriedDocs] : incoming;
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
          const tabs = withCarriedDocs(cached.tabs);
          set({
            activeConnectionId: connectionId,
            status: "connected",
            database: res.database,
            databases: res.databases,
            schemas: res.schemas,
            schemaFilter: cached.schemaFilter,
            objects: res.objects,
            tabs,
            activeTabId: carriedDocsActive ? carriedDocs!.id : cached.activeTabId,
            capabilities: res.capabilities,
          });
          if (tabs !== cached.tabs) persistTabsSoon();
          ensureCapiThread(connectionId);
          return;
        }
        const hydrated = await hydrateTabsForConnection(connectionId);
        const tabs = withCarriedDocs(hydrated.tabs);
        set({
          activeConnectionId: connectionId,
          status: "connected",
          database: res.database,
          databases: res.databases,
          schemas: res.schemas,
          schemaFilter: "",
          objects: res.objects,
          tabs,
          activeTabId: carriedDocsActive ? carriedDocs!.id : hydrated.activeTabId,
          capabilities: res.capabilities,
        });
        if (tabs !== hydrated.tabs) persistTabsSoon();
        ensureCapiThread(connectionId);
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
        capabilities: null,
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
          capabilities: res.capabilities,
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
      if (resumePromise) return resumePromise;
      const { activeConnectionId, database } = get();
      if (!activeConnectionId) return Promise.resolve(false);
      set({ status: "reconnecting", statusDetail: "server connection lost" });
      resumePromise = (async () => {
        try {
          for (let attempt = 1; attempt <= RESUME_MAX_ATTEMPTS; attempt++) {
            await get().connect(activeConnectionId, database ?? undefined);
            if (get().status === "connected") return true;
            if (attempt < RESUME_MAX_ATTEMPTS) {
              set({ status: "reconnecting", statusDetail: "server connection lost" });
              await resumeDelay(attempt);
            }
          }
          set({
            status: "disconnected",
            banner: "Lost connection to the based server and couldn't reconnect automatically. Click Reconnect to try again.",
          });
          return false;
        } finally {
          resumePromise = null;
        }
      })();
      return resumePromise;
    },

    newQueryTab() {
      const { tabs, capabilities } = get();
      // Traces: BASED-LANCE-SQL-GATING — capability-driven: only an engine without SQL (e.g.
      // LanceDB Cloud) has no query editor; local LanceDB runs SQL via the embedded DuckDB.
      if (capabilities && !capabilities.sql) return;
      const tab = freshQueryTab(nextQueryTitle(tabs));
      set({ tabs: [...tabs, tab], activeTabId: tab.id });
      persistTabsSoon();
    },

    // Traces: BASED-AGENT-SHOW-RESULTS — the no-SQL half of show_results. Reuses an already-open
    // tab rather than stacking duplicates, and re-stamps prefillWhere so a second agent call with a
    // different predicate actually re-filters instead of silently showing the first one's rows.
    async openTableTabWithQuery(schema, table, where) {
      const id = await get().openTableTab(schema, table, "table", "data");
      set({
        tabs: get().tabs.map((t) =>
          t.id === id && t.kind === "table" ? { ...t, view: "data" as TableViewId, prefillWhere: where ?? null } : t,
        ),
        activeTabId: id,
      });
      persistTabsSoon();
      return id;
    },

    async openTableTab(schema, table, objectType, view) {
      const existing = get().tabs.find((t) => t.kind === "table" && t.schema === schema && t.table === table);
      if (existing) {
        set({ activeTabId: existing.id });
        return existing.id;
      }
      const id = crypto.randomUUID();
      const tab: TableTabState = {
        kind: "table",
        id,
        title: objectTabTitle(schema, table),
        schema,
        table,
        objectType,
        columns: null,
        definition: null,
        details: null,
        createScript: null,
        indexes: null,
        rowCount: null,
        prefillWhere: null,
        error: null,
        view: view ?? "details",
      };
      set({ tabs: [...get().tabs, tab], activeTabId: id });
      persistTabsSoon();
      if (tab.view === "sql") get().setTableView(id, "sql");
      await fetchTableTabDetails(id, schema, table, objectType);
      return id;
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
      const existing = get().tabs.find((t) => t.kind === "routine" && t.schema === schema && t.name === name);
      if (existing) {
        set({ activeTabId: existing.id });
        return existing.id;
      }
      const id = crypto.randomUUID();
      const tab: RoutineTabState = {
        kind: "routine",
        id,
        title: objectTabTitle(schema, name),
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
      return id;
    },

    closeTab(id) {
      get().closeTabs([id]);
    },

    closeTabs(ids) {
      if (ids.length === 0) return;
      const { tabs, activeTabId } = get();
      const idSet = new Set(ids);
      for (const t of tabs) {
        if (t.kind === "query" && t.parentTabId && idSet.has(t.parentTabId)) idSet.add(t.id);
      }
      const remaining = tabs.filter((t) => !idSet.has(t.id));
      if (remaining.length === tabs.length) return;
      let nextActive = activeTabId;
      if (activeTabId && idSet.has(activeTabId)) {
        const idx = tabs.findIndex((t) => t.id === activeTabId);
        nextActive = remaining[Math.min(idx, remaining.length - 1)]?.id ?? null;
      }
      set({ tabs: remaining, activeTabId: nextActive });
      for (const t of tabs) {
        if (idSet.has(t.id) && t.kind === "query") disposeModel(t.id);
      }
      // Reconcile the persisted set — the flush prunes closed tabs of every kind (not just
      // query), so restore no longer accumulates every table ever opened.
      persistTabsSoon();
    },

    activateTab(id) {
      set({ activeTabId: id });
      void saveWindowState({ activeTabId: id }).catch(() => {});
    },

    reorderTab(draggedId, targetId, position) {
      if (draggedId === targetId) return;
      const { tabs } = get();
      const fromIndex = tabs.findIndex((t) => t.id === draggedId);
      if (fromIndex === -1) return;
      const next = [...tabs];
      const [moved] = next.splice(fromIndex, 1);
      let targetIndex = next.findIndex((t) => t.id === targetId);
      if (targetIndex === -1) return;
      if (position === "after") targetIndex += 1;
      next.splice(targetIndex, 0, moved);
      set({ tabs: next });
      persistTabsSoon();
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
              case "plan": {
                const doc: PlanDoc =
                  chunk.format === "duckdb-json"
                    ? { format: "duckdb-json", data: chunk.json }
                    : { format: "showplan-xml", data: chunk.xml };
                patch({ plan: [...(t.plan ?? []), doc] });
                break;
              }
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
              case "done": {
                patch({ stats: { durationMs: chunk.durationMs, status: chunk.status }, running: false, queryId: null });
                // Traces: BASED-TAB-AUTONAME-APPLY — name the tab once, on its first successful
                // run, from the SQL that actually ran. Only default "Query N" titles qualify, so
                // file-backed, manually renamed, and already-auto-named tabs are never touched.
                if (chunk.status === "ok" && !t.filePath && /^Query \d+$/.test(t.title)) {
                  const title = deriveTabTitle(tab.content);
                  if (title) patch({ title });
                }
                break;
              }
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

    async saveTab(id, opts) {
      const tab = get().tabs.find((t) => t.id === id);
      if (!tab || tab.kind !== "query") return;
      // Save As drops the existing path so the server always pops the dialog, seeded with the
      // current file name (or a slug of the title for a never-saved tab).
      const path = opts?.as ? undefined : (tab.filePath ?? undefined);
      const res = await api<{ path: string | null }>("/api/file/save-sql", {
        method: "POST",
        body: JSON.stringify({
          content: tab.content,
          path,
          defaultName: path
            ? undefined
            : (tab.filePath?.split(/[\\/]/).pop() ?? `${tab.title.replace(/[^\w.-]+/g, "-").toLowerCase()}.sql`),
        }),
      });
      if (res.path) {
        const title = res.path.split(/[\\/]/).pop() ?? tab.title;
        set({ tabs: updateTab(get().tabs, id, { filePath: res.path, title, dirty: false }) });
        persistTabsSoon();
      }
    },

    // Traces: BASED-FILE-OPEN-SQL — native dialog + read server-side; the chosen file lands in a
    // new query tab (or focuses the tab already backed by it).
    async openSqlFile(path) {
      const state = get();
      if (state.capabilities && !state.capabilities.sql) return;
      const res = await openSqlFileApi(path);
      if (!res.path) return;
      const existing = get().tabs.find((t) => t.kind === "query" && t.filePath === res.path);
      if (existing) {
        get().activateTab(existing.id);
        return;
      }
      const content = res.content ?? "";
      const title = res.path.split(/[\\/]/).pop() ?? res.path;
      const tab: QueryTabState = { ...freshQueryTab(title), content, filePath: res.path };
      set({ tabs: [...get().tabs, tab], activeTabId: tab.id });
      const model = getModel(tab.id, content);
      model.pushEditOperations([], [{ range: model.getFullModelRange(), text: content }], () => null);
      persistTabsSoon();
    },

    // Traces: BASED-UI-SHORTCUTS (Ctrl+N) — asks the shell to open a new window; silently a no-op when core and
    // shell aren't running in-process (BASED_DEV_URL dev mode has no window to open).
    async newWindow() {
      await newWindowApi().catch(() => {});
    },

    setDialog(dialog) {
      set({ dialog });
    },

    setNewTableOpen(newTableOpen) {
      set({ newTableOpen });
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

    // Open a fresh query tab prefilled with content but not run (BASED-HISTORY-UI, BASED-UI-SCRIPT-AS).
    newQueryTabWithContent(title, content) {
      const state = get();
      if (state.capabilities && !state.capabilities.sql) return null;
      const tab: QueryTabState = { ...freshQueryTab(title ?? nextQueryTitle(state.tabs)), content };
      set({ tabs: [...state.tabs, tab], activeTabId: tab.id });
      const model = getModel(tab.id, content);
      model.pushEditOperations([], [{ range: model.getFullModelRange(), text: content }], () => null);
      persistTabsSoon();
      return tab.id;
    },

    // Traces: BASED-UI-SCRIPT-AS — script the objects server-side; the result lands in one new
    // query tab (not run); per-object failures surface via the banner.
    async scriptObjects(objects, action) {
      try {
        const { sql, errors } = await postScript(objects, action);
        const title =
          objects.length === 1 ? `Script: ${objects[0]!.schema}.${objects[0]!.name}` : `Script: ${objects.length} objects`;
        if (sql.trim()) get().newQueryTabWithContent(title, sql);
        if (errors.length > 0) {
          get().setBanner(`Could not script ${errors.map((e) => `${e.schema}.${e.name}`).join(", ")}: ${errors[0]!.message}`);
        }
      } catch (err) {
        get().setBanner(err instanceof Error ? err.message : String(err));
      }
    },

    // Traces: BASED-DIAGRAM-UI — one diagram tab per scope, deduped like openTableTab.
    openDiagramTab(scope) {
      if (!get().capabilities?.relations) return null;
      const existing = get().tabs.find((t) => t.kind === "diagram" && t.schemaScope === scope);
      if (existing) {
        set({ activeTabId: existing.id });
        return existing.id;
      }
      const id = crypto.randomUUID();
      const tab: DiagramTabState = {
        kind: "diagram",
        id,
        title: scope ? `Diagram: ${scope}` : "Diagram",
        schemaScope: scope,
        graph: null,
        error: null,
      };
      set({ tabs: [...get().tabs, tab], activeTabId: id });
      persistTabsSoon();
      void fetchDiagramGraph(id, scope);
      return id;
    },

    // Traces: BASED-HELP-DOCS — one help tab per window, deduped by kind (there's nothing else to
    // key it on). Persists with the connection it was opened under, like any other tab.
    openDocsTab() {
      const existing = get().tabs.find((t) => t.kind === "docs");
      if (existing) {
        set({ activeTabId: existing.id });
        return;
      }
      const tab: DocsTabState = { kind: "docs", id: crypto.randomUUID(), title: "Help" };
      set({ tabs: [...get().tabs, tab], activeTabId: tab.id });
      persistTabsSoon();
    },

    setDiagramScope(id, scope) {
      set({
        tabs: get().tabs.map((t) =>
          t.id === id && t.kind === "diagram"
            ? { ...t, schemaScope: scope, title: scope ? `Diagram: ${scope}` : "Diagram", graph: null, error: null }
            : t,
        ),
      });
      persistTabsSoon();
      void fetchDiagramGraph(id, scope);
    },

    // Open a fresh query tab with the given SQL and run it immediately (chat "Run" affordance and
    // the agent's show_results tool). Returns the new tab's id.
    async runSqlInNewTab(sql, title) {
      const state = get();
      const tab: QueryTabState = { ...freshQueryTab(title ?? nextQueryTitle(state.tabs)), content: sql };
      set({ tabs: [...state.tabs, tab], activeTabId: tab.id });
      const model = getModel(tab.id, sql);
      model.pushEditOperations([], [{ range: model.getFullModelRange(), text: sql }], () => null);
      await get().runQuery(tab.id);
      return tab.id;
    },


    // Traces: BASED-CHAT-HISTORY-PICKER — move this window's active conversation for a connection.
    // Persisted when it's the current connection, so restart restores it.
    setCapiThread(connectionId, threadId) {
      set({ capiThreads: { ...get().capiThreads, [connectionId]: threadId } });
      if (connectionId === get().activeConnectionId) void saveWindowState({ capiThreadId: threadId }).catch(() => {});
    },

    async restoreWindow() {
      try {
        const ws = await fetchWindowState();
        if (!ws.connectionId || !get().connections.some((c) => c.id === ws.connectionId)) return;
        // Seed the conversation pointer BEFORE connecting — connect's ensureCapiThread would
        // otherwise mint a fresh one and the restored window would open on an empty chat.
        if (ws.capiThreadId) set({ capiThreads: { ...get().capiThreads, [ws.connectionId]: ws.capiThreadId } });
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

// BASED-UI-SESSION-RESUME: let the API client heal a session-lost (409) response by driving the same
// bounded-backoff resume the SSE trigger uses, then reporting whether the session came back so the
// client can retry the failed request.
setSessionHealer(() => useStore.getState().resumeSession());

export function activeQueryTab(state: AppState): QueryTabState | null {
  const tab = state.tabs.find((t) => t.id === state.activeTabId);
  return tab?.kind === "query" ? tab : null;
}

/** Tabs shown in the tab strip, in strip order — excludes the hidden SQL-view tabs `ensureSqlView`
 *  creates behind a table/view tab's "SQL" mode (see QueryTabState.parentTabId). Shared by
 *  TabStrip, the Ctrl+PageUp/PageDown handler, and TabContextMenu so "tab order" has one definition. */
export function visibleTabs(state: Pick<AppState, "tabs">): TabState[] {
  return state.tabs.filter((t) => !(t.kind === "query" && t.parentTabId));
}
