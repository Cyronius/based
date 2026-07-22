export type AuthType =
  | "entra-interactive"
  | "azure-cli"
  | "sql-login"
  | "service-principal"
  // LanceDB: cloud connects with uri (db://slug) + apiKey (via the secret channel) + region;
  // local connects with uri = a filesystem directory and needs no secret.
  | "lancedb-cloud"
  | "lancedb-local";

/** Which database engine a connection targets. Absent on legacy configs → treated as "mssql"
 *  (see engineOf in adapterFactory). Never read cfg.engine directly; always go through engineOf. */
export type DbEngine = "mssql" | "lancedb";

export interface ConnectionConfig {
  id: string;
  name: string;
  server: string;
  database: string;
  authType: AuthType;
  /** Engine discriminator. Optional for back-compat: undefined means "mssql". */
  engine?: DbEngine;
  /** LanceDB only: `db://slug` for cloud, or a filesystem directory for local. */
  uri?: string;
  /** LanceDB cloud only: e.g. "us-east-1". */
  region?: string;
  username?: string;
  tenantId?: string;
  clientId?: string;
  encrypt: boolean;
  trustServerCertificate: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Input for create/update/test — may carry the secret transiently; never persisted with it. */
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
  /** Vector-engine metadata (LanceDB). Absent/false for relational columns. */
  isVector?: boolean;
  /** Fixed-size-list length, e.g. 768 or 1536. */
  vectorDimension?: number | null;
  /** ANN index distance metric, if the column is indexed. */
  vectorMetric?: "l2" | "cosine" | "dot" | null;
  /** Element type of a vector column, e.g. "float32". */
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

/** JSON-safe cell value on the wire. Large binary and vector cells are summarized so a single row
 *  never carries a megabyte of bytes or a 1536-dim embedding into the grid or the model's context. */
export type WireValue =
  | string
  | number
  | boolean
  | null
  | { $: "bin"; len: number; preview: string }
  | { $: "vec"; dim: number; preview: number[] };

export type QueryChunk =
  | { type: "resultset"; columns: ColumnInfo[] }
  | { type: "rows"; rows: WireValue[][] }
  | { type: "resultsetEnd"; rowCount: number; truncated: boolean }
  | { type: "plan"; xml: string }
  | { type: "message"; text: string }
  | { type: "error"; message: string; line?: number; code?: number }
  | { type: "cancelled" }
  | { type: "done"; durationMs: number; status: "ok" | "error" | "cancelled" };

/** Per-run overrides for execute(). `capturePlan`/`captureStats` wrap the batch with
 *  SET STATISTICS XML/IO/TIME ON; `rowCap` overrides the adapter's default row cap
 *  (backs the tab bar's fetch-size input) for this run only. */
export interface ExecuteOptions {
  capturePlan?: boolean;
  captureStats?: boolean;
  rowCap?: number;
}

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "reconnecting";

export interface QueryExecution {
  cancel(): void;
  completion: Promise<{ status: "ok" | "error" | "cancelled"; durationMs: number }>;
}

/** A parameterized command for the transactional write path. `value` is the JSON-safe wire form;
 *  the adapter infers the SQL type from the JS runtime value (NULLs bind as NVarChar — implicit
 *  conversion to the target column is safe). Never string-interpolate cell data into `sql`. */
export interface DbCommandParam {
  name: string;
  value: WireValue;
}
export interface DbCommand {
  sql: string;
  params?: DbCommandParam[];
}
export interface CommandResult {
  rowsAffected: number[];
  error: string | null;
}

/** One page of a table's rows plus the column metadata (with PK flags) and the ordering key used. */
export interface TablePage {
  columns: TableColumn[];
  rows: WireValue[][];
  orderBy: string[];
}

export interface TestResult {
  ok: boolean;
  error?: string;
  serverVersion?: string;
  identity?: string;
}

/** A search result set: column metadata plus rows (vector cells summarized as {$:"vec"}). Score
 *  columns (e.g. `_distance`, `_relevance_score`) arrive as ordinary numeric columns. */
export interface SearchRows {
  columns: ColumnInfo[];
  rows: WireValue[][];
}

/** Vector (semantic) search. Supply `vector` (a raw query embedding) or `query` (text — requires the
 *  table to have a registered embedding function). `where` is an engine filter predicate, not SQL DML. */
export interface VectorSearchParams {
  table: string;
  vector?: number[];
  query?: string;
  k?: number;
  columns?: string[];
  where?: string;
}

/** Full-text (keyword) search over an FTS index. */
export interface TextSearchParams {
  table: string;
  query: string;
  k?: number;
  columns?: string[];
}

/** Hybrid search combines vector + full-text with reranking. `vector` is optional when the table has
 *  a registered embedding function (the text `query` is embedded natively). */
export interface HybridSearchParams extends TextSearchParams {
  vector?: number[];
}

/** What an engine can do. Consumers (server endpoints, UI affordances, the agent surface) gate on
 *  these rather than assuming every engine supports SQL or writes. `execute`/`runCommands` still
 *  exist on every adapter, but on an engine that lacks a capability they return a graceful error
 *  (an error QueryChunk / a CommandResult with `error`) rather than doing work. */
export interface EngineCapabilities {
  /** Arbitrary SQL via execute() and the raw-SQL editor. */
  sql: boolean;
  /** Nearest-neighbour vector search. */
  vectorSearch: boolean;
  /** Full-text (keyword) search over an FTS index. */
  fullTextSearch: boolean;
  /** Combined vector + full-text search with reranking. */
  hybridSearch: boolean;
  /** Row writes via runCommands() / the editable grid. */
  write: boolean;
}

export interface DatabaseAdapter {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /** Connect, run the engine's lightweight liveness check, and disconnect. Used by testConnection. */
  probe(): Promise<TestResult>;
  /** Static description of what this engine supports; drives server/UI/agent gating. */
  readonly capabilities: EngineCapabilities;
  readonly database: string;
  listDatabases(): Promise<string[]>;
  listSchemas(): Promise<string[]>;
  listObjects(): Promise<DbObject[]>;
  getTableColumns(schema: string, table: string): Promise<TableColumn[]>;
  /** Read a page of a table's rows ordered by a stable key (PK if present, else the first column),
   *  capped by the adapter's row cap. */
  readTablePage(schema: string, table: string, opts: { offset: number; limit: number }): Promise<TablePage>;
  /** SQL definition text (CREATE VIEW/PROCEDURE/FUNCTION body). Present when capabilities.sql is true. */
  getObjectDefinition?(schema: string, name: string): Promise<string | null>;
  /** Stored procedure / function parameter list. Present when capabilities.sql is true. */
  getRoutineParameters?(schema: string, name: string): Promise<RoutineParameter[]>;
  /** Run parameterized commands in a single all-or-nothing transaction. On an engine without `write`
   *  capability this returns a CommandResult with `error` set rather than mutating. */
  runCommands(commands: DbCommand[]): Promise<CommandResult>;
  /** Stream a query. On an engine without `sql` capability this emits an error chunk rather than running. */
  execute(sql: string, onChunk: (chunk: QueryChunk) => void, opts?: ExecuteOptions): QueryExecution;
  /** Nearest-neighbour vector search. Present when capabilities.vectorSearch is true. */
  vectorSearch?(params: VectorSearchParams): Promise<SearchRows>;
  /** Full-text (keyword) search. Present when capabilities.fullTextSearch is true. */
  textSearch?(params: TextSearchParams): Promise<SearchRows>;
  /** Combined vector + full-text search with reranking. Present when capabilities.hybridSearch is true. */
  hybridSearch?(params: HybridSearchParams): Promise<SearchRows>;
  onStatus(cb: (status: ConnectionStatus, detail?: string) => void): void;
}
