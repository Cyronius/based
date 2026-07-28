// Type-only imports, so the scripter/dialect ↔ types cycle is erased at build time.
import type { SqlDialect } from "./dialect";
import type { ScriptAction, ScriptInput } from "./scripter";

export type AuthType =
  | "entra-interactive"
  | "azure-cli"
  | "sql-login"
  | "service-principal"
  // LanceDB: cloud connects with uri (db://slug) + apiKey (via the secret channel) + region;
  // local connects with uri = a filesystem directory and needs no secret.
  | "lancedb-cloud"
  | "lancedb-local"
  // Snowflake authenticates itself (no Azure credential): password and key-pair both ride the
  // secret channel — keypair stores a JSON blob (see secrets.ts) because it needs two values —
  // and external-browser SSO needs no stored secret at all.
  | "snowflake-password"
  | "snowflake-keypair"
  | "snowflake-oauth";

/** Which database engine a connection targets. Absent on legacy configs → treated as "mssql"
 *  (see engineOf in adapterFactory). Never read cfg.engine directly; always go through engineOf. */
export type DbEngine = "mssql" | "lancedb" | "snowflake";

// Traces: BASED-AGENT-SURFACE-VARIANT — the engine alone doesn't determine what a connection can
// do: the three LanceDB shapes differ on SQL, on folder qualification, and on what a table name
// even means. Every capability-driven consumer (agent surface, personas, UI gating) branches on
// this, never on `engine` plus a private isCloud() the caller can't see.
export type ConnectionVariant =
  | "mssql"
  | "lancedb-local"
  | "lancedb-basefolder"
  | "lancedb-cloud"
  | "snowflake";

export interface ConnectionConfig {
  id: string;
  name: string;
  /** The browse scope: a SQL database, a Lance directory name, a warehouse database. Cross-engine
   *  enough to stay top-level — the database switcher, history rows and createAdapter all key on
   *  it — and simply blank on engines that have no such level. */
  database: string;
  authType: AuthType;
  /** Engine discriminator. Optional for back-compat: undefined means "mssql". */
  engine?: DbEngine;
  // Traces: BASED-CONN-SETTINGS-BAG — every engine-specific field (server, uri, region, account,
  // warehouse, encrypt, …) lives here, addressed by the key its FieldSpec declares. Read it through
  // settingStr/settingBool in ./connectionSettings, never directly, so a legacy row that hasn't
  // been re-saved yet still resolves.
  settings: Record<string, unknown>;
  // Traces: BASED-LANCE-CONN-DEFAULT-PROFILES — which embedding model to use is a property of how
  // THIS dataset's vectors were built, so the default lives on the connection rather than app-wide:
  // two directories built by different pipelines can never borrow each other's model (a same-dim
  // mismatch would return plausible garbage that no dimension check can catch).
  /** LanceDB only: embedding profile used when a search supplies text with no explicit profile id. */
  defaultEmbeddingProfileId?: string | null;
  /** LanceDB only: reranker profile offered for this connection. Never auto-applied to an agent
   *  search (one chat completion per candidate on the openai api) — the id must be passed. */
  defaultRerankerProfileId?: string | null;
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
  | { type: "plan"; format: "showplan-xml"; xml: string }
  | { type: "plan"; format: "duckdb-json"; json: string }
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

// Traces: BASED-TABLE-DETAILS — full table introspection for the scripter + enriched Details view.
export interface ScriptTableColumn extends TableColumn {
  collation: string | null;
  isIdentity: boolean;
  identitySeed: number | null;
  identityIncrement: number | null;
  /** Non-null ⇒ computed column. */
  computedDefinition: string | null;
  computedPersisted: boolean;
}
export interface TableIndex {
  name: string;
  /** e.g. "CLUSTERED" | "NONCLUSTERED" | "NONCLUSTERED COLUMNSTORE"; on LanceDB the index type
   *  reported by indexStats ("IVF_PQ", "HNSW_SQ", "FTS", "BTREE", …). */
  typeDesc: string;
  isUnique: boolean;
  isPrimaryKey: boolean;
  isUniqueConstraint: boolean;
  filterDefinition: string | null;
  keyColumns: Array<{ name: string; descending: boolean }>;
  includedColumns: string[];
  // Traces: BASED-INDEX-INTROSPECT — vector-engine fields, absent on SQL Server. `numUnindexedRows`
  // is the usual explanation for "search got slow" or "search can't find a row I just added": those
  // rows are scanned exactly (or missed) rather than served from the ANN index.
  /** ANN distance metric, when the index is a vector index. */
  distanceType?: "l2" | "cosine" | "dot" | null;
  numIndexedRows?: number | null;
  numUnindexedRows?: number | null;
  /** Sub-index count (LanceDB splits large indices). */
  numIndices?: number | null;
}
export interface TableForeignKey {
  name: string;
  columns: string[];
  refSchema: string;
  refTable: string;
  refColumns: string[];
  /** "NO_ACTION" | "CASCADE" | "SET_NULL" | "SET_DEFAULT". */
  onDelete: string;
  onUpdate: string;
  isDisabled: boolean;
}
export interface TableCheckConstraint {
  name: string;
  definition: string;
  /** Column-scoped check's column, or null for a table-level check. */
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

// Traces: BASED-RELATIONS — bulk FK-relationship introspection for the ER diagram.
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

// Traces: BASED-TABLE-ORDERBY — server-side sort + filter for table browse.
export type TableFilterOp = "eq" | "ne" | "gt" | "ge" | "lt" | "le" | "like" | "is-null" | "not-null";
export interface TableFilter {
  column: string;
  op: TableFilterOp;
  /** Absent for is-null / not-null. Rides as a typed parameter, never interpolated. */
  value?: string | number;
}
export interface TableSort {
  column: string;
  dir: "asc" | "desc";
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

export type LanceSearchMode = "text" | "vector" | "hybrid";

/** A resolved (secret-fetched) embedding backend — never carries a bare profile id past the server
 *  route boundary; the wire request only ever has `embeddingProfileId`. */
export interface ResolvedEmbeddingProfile {
  baseUrl: string;
  model: string;
  apiKey?: string;
  /** Traces: BASED-LANCE-EMBED-DIM — called with the size of every embedding this profile actually
   *  produces, so the profile can learn its own dimension without a separate probe call. Wired by
   *  resolveEmbeddingProfile; absent in contexts with no store to write back to. */
  onDimension?: (dimension: number) => void;
}

/** How a reranker profile's endpoint is called (BASED-LANCE-RERANK-OPENAI). `rerank` = the classic
 *  Cohere/TEI `POST {baseUrl}/rerank` shape; `openai` = one chat-completions call per document,
 *  scoring yes/no logprobs (the Qwen3-Reranker causal-LM trick). Absent = `rerank` (legacy). */
export type RerankerApi = "rerank" | "openai";

/** A resolved reranker backend (Cohere/TEI rerank endpoint, or an OpenAI-compatible
 *  chat-completions endpoint scored via logprobs — see RerankerApi). */
export interface ResolvedRerankerProfile {
  baseUrl: string;
  model?: string;
  apiKey?: string;
  api?: RerankerApi;
  /** openai api only: the Qwen3-Reranker task instruction (`<Instruct>:` line). Default:
   *  "Given a web search query, retrieve relevant passages that answer the query". */
  instruction?: string;
}

/** Per-run knobs for the external rerank call, independent of which profile is selected. */
export interface RerankerRunOptions {
  /** How many of the sampleSize candidates the endpoint scores/returns (Cohere/TEI `top_n`;
   *  applied based-side after scoring in the openai api). */
  topN?: number;
  /** Passed through if the endpoint accepts it; harmless no-op otherwise. Ignored by the openai
   *  api, which always scores at temperature 0. */
  temperature?: number;
}

/** Wire-level unified search request (server route body + agent tool params) — carries profile
 *  *ids*, not resolved secrets. Vector (semantic), full-text (keyword), and hybrid search all go
 *  through this one shape; `where` is an engine filter predicate, not SQL DML, and applies to all
 *  three modes. */
export interface LanceSearchRequest {
  /** Base-folder name (the `folder` the agent passes) — disambiguates a table name that exists in
   *  more than one folder. Ignored on single-database and cloud connections. */
  schema?: string;
  table: string;
  mode: LanceSearchMode;
  /** Text query. Required for text/hybrid; for vector mode, required unless `vector` is given. */
  query?: string;
  /** Raw query embedding. If given for vector/hybrid, `embeddingProfileId` is not consulted. */
  vector?: number[];
  /** Which vector column to search. Required in practice only when a table has more than one —
   *  LanceDB otherwise picks the sole vector column itself (BASED-LANCE-VECTOR-COLUMN). */
  vectorColumn?: string;
  /** Prefilter predicate — LanceDB predicate syntax, NOT DuckDB SQL. Supported on all three modes. */
  where?: string;
  columns?: string[];
  /** Initial candidate pool fetched via the native search, before reranking. Default 50.
   *  (Renamed from `sampleSize`: it is an over-fetch pool, never a row sample.) */
  candidatePool?: number;
  /** Final row count after reranking/filtering (== k). Default 10, capped by candidatePool. */
  keepSize?: number;
  embeddingProfileId?: string;
  rerankerProfileId?: string;
  rerankerOptions?: RerankerRunOptions;
  /** Column supplying "document" text sent to the rerank endpoint. Defaults to a heuristic
   *  (first non-vector string column). */
  rerankTextColumn?: string;
  // Traces: BASED-SEARCH-PARAM-NAMES — based-side score thresholds, applied to whatever the final
  // score column is (`_distance`, `_relevance_score`, or `_rerank_score`) and direction-aware, so
  // "min" always means "keep the better ones" regardless of which way that score sorts. The old
  // names (`floor`/`delta`) read as bounds on a number and were used backwards.
  /** Drop rows whose final score is worse than this threshold. */
  minScore?: number;
  /** Drop rows whose final score trails the #1 result's score by more than this. */
  maxScoreGapFromTop?: number;
  // Traces: BASED-LANCE-SEARCH-KNOBS — Lance SDK vector-query tuning knobs. Vector/hybrid modes
  // only; combining any of them with mode:"text" throws before querying. All are no-ops on an
  // unindexed column (exact search) except distanceRange, which always bounds.
  /** Distance metric for the query. With an ANN index, the index's own metric governs — a
   *  mismatched value gives surprising scores (see the lance-search skill). */
  distanceType?: "l2" | "cosine" | "dot";
  /** IVF partitions to probe — the primary recall/latency dial. */
  nprobes?: number;
  /** Re-rank this×k candidates with exact vectors — the standard recall fixup. */
  refineFactor?: number;
  /** HNSW candidate-list size (the HNSW equivalent of nprobes). */
  ef?: number;
  /** Apply `where` AFTER the ANN search instead of prefiltering. */
  postfilter?: boolean;
  /** Skip the ANN index entirely: exact ground-truth search. */
  bypassVectorIndex?: boolean;
  /** Engine-side score bounds (complements based-side floor/delta). */
  distanceRangeLower?: number;
  distanceRangeUpper?: number;
}

/** Adapter-level params: same shape as LanceSearchRequest, but with resolved embedding/reranker
 *  backends instead of ids. Only server.ts (and the agent tools) build this from a request. */
export interface LanceSearchParams extends Omit<LanceSearchRequest, "embeddingProfileId" | "rerankerProfileId"> {
  embeddingProfile?: ResolvedEmbeddingProfile;
  rerankerProfile?: ResolvedRerankerProfile;
}

// Traces: BASED-EMBED-VECTORS — a full-precision sample of one vector column plus the table's
// non-vector cells, fetched for the Embeddings visualization. Unlike every other read path, the
// vectors here are NOT summarized to a preview: `vectors` is the raw n×dim row-major float block.
export interface VectorSampleColumn {
  name: string;
  type: string;
}

export interface VectorSampleResult {
  /** Vector dimension (fixed-size-list size of the sampled column). */
  dim: number;
  /** Rows actually sampled (vectors.length / dim); rows with null/ragged vectors are skipped. */
  count: number;
  /** Total rows in the table, so the UI can say "5,000 of 182,340". */
  totalRows: number;
  /** True when count < totalRows (limit, row cap, or byte budget kicked in). */
  sampled: boolean;
  /** Non-vector columns included in `rows`, in cell order. */
  columns: VectorSampleColumn[];
  /** count × columns.length JSON-safe cells (strings capped to textCap). */
  rows: unknown[][];
  /** Row-major count×dim float block. Excluded from the JSON header on the wire. */
  vectors: Float32Array;
}

/** What an engine can do. Consumers (server endpoints, UI affordances, the agent surface) gate on
 *  these rather than assuming every engine supports SQL or writes. `execute`/`runCommands` still
 *  exist on every adapter, but on an engine that lacks a capability they return a graceful error
 *  (an error QueryChunk / a CommandResult with `error`) rather than doing work. */
export interface EngineCapabilities {
  /** Arbitrary SQL via execute() and the raw-SQL editor. */
  sql: boolean;
  /** Vector / keyword / hybrid search via search(). */
  search: boolean;
  /** Row writes via runCommands() / the editable grid. */
  write: boolean;
  /** Server-side ORDER BY / WHERE on readTablePage (BASED-TABLE-ORDERBY). False on unordered
   *  engines (LanceDB) — the Data tab's headers stay non-interactive there. */
  orderedBrowse: boolean;
  /** Object DDL scripting: getTableDetails + the T-SQL scripter (BASED-TABLE-DETAILS). */
  script: boolean;
  /** FK-relationship introspection for the ER diagram (BASED-RELATIONS). */
  relations: boolean;
  // Traces: BASED-AGENT-SURFACE-VARIANT — the fields below exist so the agent surface can be
  // *generated* rather than described in prose conditionals the model has to evaluate against a
  // variant it cannot see. Everything here is knowable at connect time.
  /** The engine this connection targets — the same value engineOf(cfg) returns. */
  engine: DbEngine;
  /** The connection shape. Finer than `engine`: the three LanceDB variants differ materially. */
  variant: ConnectionVariant;
  /** Base-folder names — the qualifier in `folder.main.table`, and the only legal values of the
   *  agent's `folder` param. Null on every variant that has no folder namespace. */
  containers: string[] | null;
  /** A free-text engine predicate (LanceDB `where`) on readTablePage / countRows. */
  wherePredicate: boolean;
  /** Structured column/op/value filters on readTablePage (T-SQL, parameterized). */
  structuredFilters: boolean;
  /** countRows() is implemented. */
  countRows: boolean;
  /** takeRows() (fetch by key values) is implemented. */
  takeByKey: boolean;
  /** getIndexes() is implemented — what makes "IVF or HNSW?" a lookup instead of a guess. */
  indexIntrospect: boolean;
}

export interface DatabaseAdapter {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /** Connect, run the engine's lightweight liveness check, and disconnect. Used by testConnection. */
  probe(): Promise<TestResult>;
  /** Static description of what this engine supports; drives server/UI/agent gating. */
  readonly capabilities: EngineCapabilities;
  /** How this engine spells SQL: quoting, bind placeholders, paging, identifier case. Callers that
   *  build SQL for the connection (the grid's write path) read it from here rather than branching
   *  on engine. Engines without `write` still expose one; it is simply never exercised. */
  readonly dialect: SqlDialect;
  readonly database: string;
  listDatabases(): Promise<string[]>;
  listSchemas(): Promise<string[]>;
  listObjects(): Promise<DbObject[]>;
  getTableColumns(schema: string, table: string): Promise<TableColumn[]>;
  /** Read a page of a table's rows ordered by a stable key (PK if present, else the first column),
   *  capped by the adapter's row cap. Engines with `orderedBrowse` additionally honor a user sort
   *  (stable-key tiebreak appended) and parameterized filters (BASED-TABLE-ORDERBY). */
  readTablePage(
    schema: string,
    table: string,
    opts: { offset: number; limit: number; orderBy?: TableSort[]; filters?: TableFilter[]; where?: string },
  ): Promise<TablePage>;
  /** Row count, optionally narrowed. Present when `capabilities.countRows` is true. `where` is the
   *  engine predicate (LanceDB); `filters` is the structured, parameterized form (SQL Server).
   *  Traces: BASED-LANCE-SCAN. */
  countRows?(schema: string, table: string, opts?: { where?: string; filters?: TableFilter[] }): Promise<number>;
  /** Fetch rows whose `keyColumn` matches one of `keys`. Literals are escaped here, never by the
   *  caller. Present when `capabilities.takeByKey` is true. Traces: BASED-LANCE-SCAN. */
  takeRows?(
    schema: string,
    table: string,
    opts: { keyColumn: string; keys: Array<string | number>; columns?: string[] },
  ): Promise<TablePage>;
  /** Index metadata. Present when `capabilities.indexIntrospect` is true. Traces: BASED-INDEX-INTROSPECT. */
  getIndexes?(schema: string, table: string): Promise<TableIndex[]>;
  /** SQL definition text (CREATE VIEW/PROCEDURE/FUNCTION body). Present when capabilities.sql is true. */
  getObjectDefinition?(schema: string, name: string): Promise<string | null>;
  /** Full table introspection for scripting + the enriched Details view (BASED-TABLE-DETAILS).
   *  Present when capabilities.script is true. */
  getTableDetails?(schema: string, name: string): Promise<TableDetails>;
  /** Engine-native object scripting. When present, callers prefer it over the pure T-SQL scripter —
   *  an engine that can generate its own DDL (Snowflake's GET_DDL) always does it better than we can
   *  rebuild it from catalog rows, and this keeps scripter.ts from growing a dialect per engine.
   *  Traces: BASED-SNOWFLAKE-SCRIPT. */
  scriptObject?(input: ScriptInput, action: ScriptAction): Promise<string>;
  /** Bulk tables + FK edges for the ER diagram (BASED-RELATIONS). Present when
   *  capabilities.relations is true. */
  getRelations?(schemaFilter?: string): Promise<RelationsGraph>;
  /** Stored procedure / function parameter list. Present when capabilities.sql is true. */
  getRoutineParameters?(schema: string, name: string): Promise<RoutineParameter[]>;
  /** Run parameterized commands in a single all-or-nothing transaction. On an engine without `write`
   *  capability this returns a CommandResult with `error` set rather than mutating. */
  runCommands(commands: DbCommand[]): Promise<CommandResult>;
  /** Stream a query. On an engine without `sql` capability this emits an error chunk rather than running. */
  execute(sql: string, onChunk: (chunk: QueryChunk) => void, opts?: ExecuteOptions): QueryExecution;
  /** Unified vector/keyword/hybrid search, with based-side prefiltering, optional external
   *  reranking, and floor/delta score filtering. Present when capabilities.search is true. */
  search?(params: LanceSearchParams): Promise<SearchRows>;
  /** Full-precision sample of one vector column for the Embeddings visualization
   *  (BASED-EMBED-VECTORS). Present only on engines that store vectors (LanceDB). */
  readVectorSample?(
    schema: string,
    table: string,
    opts: { column: string; limit: number; textCap?: number },
  ): Promise<VectorSampleResult>;
  onStatus(cb: (status: ConnectionStatus, detail?: string) => void): void;
}
