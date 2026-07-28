// Wire types mirroring core/src/db/types.ts (kept separate so the webview never imports Bun-flavored
// modules). Traces: BASED-ENGINE-PROFILE-WIRE — engine ids, auth types and connection variants are
// deliberately NOT enumerated here any more. They arrive from GET /api/engines as data, so adding an
// engine is a core-only change and this file cannot drift out of step with the registry. Anything
// the UI needs to *do* per engine comes from an EngineProfile field, never from comparing an id.
export type AuthType = string;
export type DbEngine = string;
export type ConnectionVariant = string;

export interface ConnectionConfig {
  id: string;
  /** The browse scope: a SQL database, a Lance directory name, a warehouse database. */
  database: string;
  name: string;
  authType: AuthType;
  engine?: DbEngine;
  /** Traces: BASED-CONN-SETTINGS-BAG — engine-specific fields, keyed by their FieldSpec.key. */
  settings: Record<string, unknown>;
  /** BASED-LANCE-CONN-DEFAULT-PROFILES: top-level rather than in `settings` because the profile
   *  deletion sweep scans them. Rendered via the embedding-profile/reranker-profile field kinds. */
  defaultEmbeddingProfileId?: string | null;
  defaultRerankerProfileId?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One control in the connection dialog. The dialog knows these kinds and no engine names. */
export interface FieldSpec {
  key: string;
  label: string;
  kind:
    | "text"
    | "password"
    | "select"
    | "checkbox"
    | "directory"
    | "file"
    | "embedding-profile"
    | "reranker-profile";
  required?: boolean;
  placeholder?: string;
  help?: string;
  default?: string | boolean;
  options?: Array<{ value: string; label: string }>;
  visibleWhen?: { field: string; equals: string[] };
}

export interface AuthModeSpec {
  id: string;
  label: string;
  secretLabel: string | null;
  secretHelp?: string;
  /** A multi-line secret (PEM/blob) — rendered as a textarea, since an <input> drops newlines. */
  secretMultiline?: boolean;
  note?: string;
}

export interface NamespaceProfile {
  key: string | null;
  label: string;
  default: string;
  objectNoun: string;
  objectNounPlural: string;
  grouping: "typed" | "flat";
}

/** Served by GET /api/engines. Everything the UI needs to render an engine it has never heard of. */
export interface EngineProfile {
  id: DbEngine;
  label: string;
  fields: FieldSpec[];
  authModes: AuthModeSpec[];
  namespace: NamespaceProfile;
  subtitleField: string;
  quote: { open: string; close: string; escape: string };
  defaultCapabilities: EngineCapabilities;
}

/** The engine of a connection, defaulting legacy (engine-less) configs to mssql. */
export function engineOf(c: { engine?: DbEngine }): DbEngine {
  return c.engine ?? "mssql";
}

export interface ConnectionInput extends Omit<ConnectionConfig, "id" | "createdAt" | "updatedAt"> {
  id?: string;
  secret?: string;
}

export type DbObjectType = "table" | "view" | "procedure" | "function";

export interface DbObject {
  schema: string;
  name: string;
  type: DbObjectType;
}

export interface TableColumn {
  name: string;
  type: string;
  maxLength: number | null;
  precision: number | null;
  scale: number | null;
  nullable: boolean;
  isPrimaryKey: boolean;
  isForeignKey: boolean;
  fkTarget: string | null;
  isVector?: boolean;
  vectorDimension?: number | null;
  vectorMetric?: "l2" | "cosine" | "dot" | null;
  elementType?: string | null;
}

export interface ColumnInfo {
  name: string;
  type: string;
}

export interface RoutineParameter {
  name: string;
  type: string;
  mode: "in" | "out" | "inout";
  ordinal: number;
}

export type WireValue =
  | string
  | number
  | boolean
  | null
  | { $: "bin"; len: number; preview: string }
  | { $: "vec"; dim: number; preview: number[] };

export type QueryChunk =
  | { type: "start"; queryId: string }
  | { type: "resultset"; columns: ColumnInfo[] }
  | { type: "rows"; rows: WireValue[][] }
  | { type: "resultsetEnd"; rowCount: number; truncated: boolean }
  | { type: "plan"; format: "showplan-xml"; xml: string }
  | { type: "plan"; format: "duckdb-json"; json: string }
  | { type: "message"; text: string }
  | { type: "error"; message: string; line?: number; code?: number }
  | { type: "cancelled" }
  | { type: "done"; durationMs: number; status: "ok" | "error" | "cancelled" };

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "reconnecting";

export interface TestResult {
  ok: boolean;
  error?: string;
  serverVersion?: string;
  identity?: string;
}

export type TabKind = "query" | "table" | "routine" | "diagram";

export interface TabRecord {
  id: string;
  connectionId: string;
  title: string;
  content: string;
  filePath: string | null;
  position: number;
  kind: TabKind;
  meta: unknown | null;
  updatedAt: string;
}

/** Per-window (per-sid) view state that survives a restart — see BASED-WINDOW-RESTORE. */
export interface WindowState {
  sid: string;
  connectionId: string | null;
  activeTabId: string | null;
  schemaFilter: string;
}

export interface EngineCapabilities {
  sql: boolean;
  search: boolean;
  write: boolean;
  /** Server-side ORDER BY / WHERE on table browse (BASED-TABLE-ORDERBY). */
  orderedBrowse: boolean;
  /** Object DDL scripting (BASED-TABLE-DETAILS / BASED-SCRIPT-API). */
  script: boolean;
  /** FK-relationship introspection for the ER diagram (BASED-RELATIONS). */
  relations: boolean;
  // Traces: BASED-AGENT-SURFACE-VARIANT — mirrors core/src/db/types.ts.
  engine: DbEngine;
  variant: ConnectionVariant;
  /** Base-folder names (the `folder.main.table` qualifier), or null. */
  containers: string[] | null;
  wherePredicate: boolean;
  structuredFilters: boolean;
  countRows: boolean;
  takeByKey: boolean;
  indexIntrospect: boolean;
}

// Traces: BASED-TABLE-DETAILS — mirrors core/src/db/types.ts
export interface ScriptTableColumn extends TableColumn {
  collation: string | null;
  isIdentity: boolean;
  identitySeed: number | null;
  identityIncrement: number | null;
  computedDefinition: string | null;
  computedPersisted: boolean;
}
export interface TableIndex {
  name: string;
  typeDesc: string;
  isUnique: boolean;
  isPrimaryKey: boolean;
  isUniqueConstraint: boolean;
  filterDefinition: string | null;
  keyColumns: Array<{ name: string; descending: boolean }>;
  includedColumns: string[];
  // Traces: BASED-INDEX-INTROSPECT — vector-engine fields, absent on SQL Server.
  distanceType?: "l2" | "cosine" | "dot" | null;
  numIndexedRows?: number | null;
  numUnindexedRows?: number | null;
  numIndices?: number | null;
}
export interface TableForeignKey {
  name: string;
  columns: string[];
  refSchema: string;
  refTable: string;
  refColumns: string[];
  onDelete: string;
  onUpdate: string;
  isDisabled: boolean;
}
export interface TableCheckConstraint {
  name: string;
  definition: string;
  column: string | null;
  isDisabled: boolean;
}
export interface TableDefaultConstraint {
  name: string;
  column: string;
  definition: string;
}
export interface TableTrigger {
  name: string;
  isInsteadOf: boolean;
  isDisabled: boolean;
  events: string[];
}
export interface TableDetails {
  schema: string;
  name: string;
  columns: ScriptTableColumn[];
  indexes: TableIndex[];
  foreignKeys: TableForeignKey[];
  checkConstraints: TableCheckConstraint[];
  defaultConstraints: TableDefaultConstraint[];
  triggers: TableTrigger[];
}

export type ScriptAction = "create" | "drop" | "drop-create" | "alter" | "select" | "insert";

// Traces: BASED-RELATIONS — mirrors core/src/db/types.ts
export interface RelationsTable {
  schema: string;
  name: string;
  columns: Array<{ name: string; type: string; isPrimaryKey: boolean; isForeignKey: boolean; nullable: boolean }>;
}
export interface RelationsForeignKey {
  name: string;
  schema: string;
  table: string;
  columns: string[];
  refSchema: string;
  refTable: string;
  refColumns: string[];
}
export interface RelationsGraph {
  tables: RelationsTable[];
  foreignKeys: RelationsForeignKey[];
}

// Traces: BASED-TABLE-ORDERBY — mirrors core/src/db/types.ts
export type TableFilterOp = "eq" | "ne" | "gt" | "ge" | "lt" | "le" | "like" | "is-null" | "not-null";
export interface TableFilter {
  column: string;
  op: TableFilterOp;
  value?: string | number;
}
export interface TableSort {
  column: string;
  dir: "asc" | "desc";
}

export interface ConnectResponse {
  connectionId: string;
  database: string;
  databases: string[];
  schemas: string[];
  objects: DbObject[];
  capabilities: EngineCapabilities;
}

export type LanceSearchMode = "text" | "vector" | "hybrid";

export interface RerankerRunOptions {
  topN?: number;
  temperature?: number;
}

/** Unified vector/keyword/hybrid search request — mirrors core's LanceSearchRequest. */
export interface LanceSearchRequest {
  schema?: string;
  table: string;
  mode: LanceSearchMode;
  query?: string;
  vector?: number[];
  /** Which vector column to search — needed only on tables with more than one. */
  vectorColumn?: string;
  where?: string;
  columns?: string[];
  /** Over-fetch pool before rerank/threshold (was `sampleSize`). */
  candidatePool?: number;
  keepSize?: number;
  embeddingProfileId?: string;
  rerankerProfileId?: string;
  rerankerOptions?: RerankerRunOptions;
  rerankTextColumn?: string;
  /** Direction-aware score threshold (was `floor`). */
  minScore?: number;
  /** Direction-aware gap from the #1 result (was `delta`). */
  maxScoreGapFromTop?: number;
}

export interface SearchRows {
  columns: ColumnInfo[];
  rows: WireValue[][];
}

// Traces: BASED-EMBED-VECTORS — JSON header of the binary /table-vectors response; the raw float
// block rides alongside it (decoded in fetchTableVectors). Mirrors core's VectorSampleResult sans
// `vectors`.
export interface VectorSampleColumn {
  name: string;
  type: string;
}

export interface VectorSampleHeader {
  dim: number;
  count: number;
  totalRows: number;
  sampled: boolean;
  columns: VectorSampleColumn[];
  rows: WireValue[][];
}

// Traces: BASED-EMBED-LABELS-AI — one-shot cluster naming via the active AI profile.
export interface LabelClustersRequest {
  clusters: Array<{ id: number; hint?: string; samples: string[] }>;
}

export interface LabelClustersResponse {
  labels: Array<{ id: number; label: string }>;
  model: string;
}

export interface EmbeddingProfile {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  hasKey: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface EmbeddingProfileInput extends Omit<EmbeddingProfile, "id" | "hasKey" | "createdAt" | "updatedAt"> {
  id?: string;
  apiKey?: string;
}

/** How a reranker profile's endpoint is called: the classic Cohere/TEI `/rerank` shape, or an
 *  OpenAI-compatible chat-completions endpoint scored via yes/no logprobs (Qwen3-Reranker style).
 *  Absent = "rerank" (legacy profiles). */
export type RerankerApi = "rerank" | "openai";

export interface RerankerProfile {
  id: string;
  name: string;
  baseUrl: string;
  model?: string;
  api?: RerankerApi;
  /** openai api only: Qwen3-Reranker task instruction override. */
  instruction?: string;
  hasKey: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RerankerProfileInput extends Omit<RerankerProfile, "id" | "hasKey" | "createdAt" | "updatedAt"> {
  id?: string;
  apiKey?: string;
}

export type ProviderKind = "openai-compatible" | "openai" | "azure-openai" | "anthropic";

export interface AiProfile {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  deployment?: string;
  /** Instruction set this agent runs against. "default" or a custom set id. */
  instructionSetId: string;
  /** Model parameter JSON (BASED-AI-PROFILE-PARAMS): call settings + provider options, no secrets. */
  params?: Record<string, unknown>;
  /** No-activity window for this profile's requests, in seconds (BASED-AI-PROFILE-TIMEOUT).
   *  Absent = DEFAULT_AI_TIMEOUT_SECONDS; see ui/src/agent/aiTimeouts.ts. */
  timeoutSeconds?: number;
  hasKey: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AiProfileInput extends Omit<AiProfile, "id" | "instructionSetId" | "hasKey" | "createdAt" | "updatedAt"> {
  id?: string;
  instructionSetId?: string;
  apiKey?: string;
}

export interface AppSettings {
  theme: string;
  rowPageSize: number;
  fontScale: number;
  activeAiProfileId: string | null;
  /** Explorer double-click actions (BASED-EXPLORER-ACTION). */
  explorerTableAction: "details" | "data" | "sql" | "script-create";
  explorerRoutineAction: "details" | "script-create";
  /** Query-editor keymap (BASED-EDITOR-VIM). */
  editorKeymap: "default" | "vim";
}

// Traces: BASED-HISTORY-UI — mirrors core/src/storage/history.ts
export interface HistoryEntry {
  id: number;
  connectionId: string;
  database: string;
  sql: string;
  startedAt: string;
  durationMs: number | null;
  status: "ok" | "error" | "cancelled";
  error: string | null;
}

// Traces: BASED-HISTORY-UI — mirrors core/src/agent/audit.ts
export interface AuditEntry {
  id: number;
  connectionId: string;
  database: string;
  kind: "read" | "mutation";
  sql: string;
  approved: boolean;
  startedAt: string;
  durationMs: number | null;
  status: "ok" | "error";
  error: string | null;
}

export interface InstructionSet {
  id: string;
  name: string;
  /** Shared, engine-neutral core. */
  core: string;
  /** Persona per engine id. Keyed rather than one named field per engine so a newly registered
   *  engine appears in the editor without a wire-type change; a missing entry falls back to that
   *  engine's built-in persona server-side. */
  personas: Record<string, string>;
  /** false only for the built-in "default" set. */
  editable: boolean;
}

export interface AgentInstructionsConfig {
  /** "default" or a sets[].id. */
  activeId: string;
  sets: InstructionSet[];
  /** Traces: BASED-AGENT-INSTRUCTIONS — the generated, non-editable half of the prompt, per engine.
   *  Present on GET only (never posted back); shown read-only in the editor so the user can see what
   *  is injected alongside their persona. Keyed by engine id for the same reason `personas` is. */
  briefings?: Record<string, string>;
  /** Which engine's briefing above came from the LIVE connection rather than a representative
   *  rendering, or null when nothing is connected. */
  briefingIsLive?: DbEngine | null;
}

export interface MutationResult {
  status: "ok" | "error";
  messages: string[];
  errors: string[];
  rowCounts: number[];
  durationMs: number;
}

export interface TablePage {
  columns: TableColumn[];
  rows: WireValue[][];
  orderBy: string[];
}

export interface DbCommandPreview {
  sql: string;
  params: Array<{ name: string; value: WireValue }>;
}

/** Mirrors core's TableChangeSet on the wire (see core/src/db/tableEdit.ts). */
export interface TableChangeSet {
  schema: string;
  table: string;
  columns: Array<{ name: string; isPrimaryKey: boolean }>;
  updates?: Array<{ key: Record<string, WireValue>; set: Record<string, WireValue> }>;
  inserts?: Array<Record<string, WireValue>>;
  deletes?: Array<Record<string, WireValue>>;
}

export interface TableEditResult {
  status: "ok" | "error";
  rowsAffected: number[];
  error: string | null;
  durationMs: number;
}

export function cellText(v: WireValue): string {
  if (v === null) return "NULL";
  if (typeof v === "object") {
    if (v.$ === "vec") {
      const preview = v.preview.map((n) => n.toFixed(3)).join(", ");
      return `vec[${v.dim}] [${preview}${v.dim > v.preview.length ? ", …" : ""}]`;
    }
    return `<binary ${v.len} bytes> ${v.preview}`;
  }
  return String(v);
}
