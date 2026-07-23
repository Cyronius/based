// Wire types mirroring core/src/db/types.ts (kept separate so the webview never imports Bun-flavored modules).
export type AuthType =
  | "entra-interactive"
  | "azure-cli"
  | "sql-login"
  | "service-principal"
  | "lancedb-cloud"
  | "lancedb-local";

export type DbEngine = "mssql" | "lancedb";

export interface ConnectionConfig {
  id: string;
  name: string;
  server: string;
  database: string;
  authType: AuthType;
  /** Engine discriminator. Undefined = "mssql" (legacy configs). */
  engine?: DbEngine;
  /** LanceDB: `db://slug` for cloud, or a filesystem directory for local. */
  uri?: string;
  /** LanceDB cloud only. */
  region?: string;
  username?: string;
  tenantId?: string;
  clientId?: string;
  encrypt: boolean;
  trustServerCertificate: boolean;
  createdAt: string;
  updatedAt: string;
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
  | { type: "plan"; xml: string }
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

export type TabKind = "query" | "table" | "routine";

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

export interface ConnectResponse {
  connectionId: string;
  database: string;
  databases: string[];
  schemas: string[];
  objects: DbObject[];
}

export type ProviderKind = "openai-compatible" | "openai" | "azure-openai" | "anthropic";

export interface AiConfig {
  providerId: string;
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  deployment?: string;
  hasKey: boolean;
}

export interface AppSettings {
  theme: string;
  rowPageSize: number;
  fontScale: number;
}

export interface InstructionSet {
  id: string;
  name: string;
  /** Shared, engine-neutral core. */
  core: string;
  mssqlPersona: string;
  lancePersona: string;
  /** false only for the built-in "default" set. */
  editable: boolean;
}

export interface AgentInstructionsConfig {
  /** "default" or a sets[].id. */
  activeId: string;
  sets: InstructionSet[];
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
