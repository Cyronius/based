// Traces: BASED-LANCE-CONNECT, BASED-LANCE-BROWSE, BASED-LANCE-VECTOR-SEARCH, BASED-LANCE-FTS,
//         BASED-LANCE-HYBRID, BASED-LANCE-WIRE, BASED-LANCE-SEARCH-UNIFIED, BASED-LANCE-EMBED-COMPUTE,
//         BASED-LANCE-RERANK-PIPELINE, BASED-LANCE-SQL
// LanceDB adapter — a second engine behind the DatabaseAdapter interface. Local (file-based) opens a
// directory URI; cloud opens `db://slug` with an API key (from the secret channel) + region. LanceDB
// itself has no SQL surface — but local connections get one through an embedded DuckDB with the
// lance extension (LanceSqlBridge), so capabilities.sql is true for local and false for cloud (the
// extension reads Lance storage, not the cloud API). Writes stay off (capabilities.write is false).
import { readdirSync } from "node:fs";
import { basename, join } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import { settingStr } from "./connectionSettings";
import { DUCKDB_DIALECT, type SqlDialect } from "./dialect";
import type { SecretProvider } from "./entra";
import { DEFAULT_ROW_CAP } from "./rowcap";
import { serializeLanceValue } from "./lanceSerialize";
import { buildLanceSchema, type LanceColumnSpec } from "./lanceSchema";
import { LanceSqlBridge } from "./lanceSql";
import { embedQuery } from "./embeddings";
import { rerank } from "./reranker";
import type {
  ColumnInfo,
  CommandResult,
  ConnectionConfig,
  ConnectionStatus,
  ConnectionVariant,
  DatabaseAdapter,
  DbCommand,
  DbObject,
  EngineCapabilities,
  ExecuteOptions,
  LanceSearchParams,
  QueryChunk,
  QueryExecution,
  SearchRows,
  TableColumn,
  TableIndex,
  TablePage,
  TestResult,
  VectorSampleResult,
  WireValue,
} from "./types";

/** Lance's own on-disk layout inside every table (`<name>.lance`) directory — never valid names for a
 *  nested database when scanning a base folder (BASED-LANCE-BASEFOLDER). */
const LANCE_RESERVED_DIR_NAMES = new Set(["data", "_versions", "_indices", "_transactions", "_deletions"]);

function errMessage(err: unknown): string {
  if (!err) return "Unknown error";
  const e = err as { message?: string };
  return e.message ?? String(err);
}

/** apache-arrow's FixedSizeList is how LanceDB stores vectors; its `listSize` is the dimension and
 *  its single child holds the element type. We introspect structurally to avoid importing arrow. */
function vectorInfo(arrowType: unknown): { dim: number; elementType: string } | null {
  const t = arrowType as { listSize?: number; children?: Array<{ type?: unknown }> };
  if (typeof t?.listSize !== "number") return null;
  const child = t.children?.[0]?.type;
  return { dim: t.listSize, elementType: child != null ? String(child).toLowerCase() : "float32" };
}

export class LanceDbAdapter implements DatabaseAdapter {
  // Traces: BASED-LANCE-SQL — dynamic per config: DuckDB's lance extension can scan local Lance
  // storage but cannot reach LanceDB Cloud, so only local connections advertise sql.
  get capabilities(): EngineCapabilities {
    return {
      sql: !this.isCloud(),
      search: true,
      write: false,
      // Rows stay read-only, but local connections can create empty tables (and base-folder
      // sub-databases) — BASED-LANCE-CREATE-TABLE. Cloud supports it in the SDK but is untestable
      // here, so it stays off until someone can verify it.
      createTable: !this.isCloud(),
      // Lance is an unordered engine (readTablePage has no stable ORDER BY) — no server-side
      // sort browse (BASED-TABLE-ORDERBY). Filtering is a different question: a `where` predicate
      // needs no ordering, and it is the ONLY way to narrow rows on a cloud connection.
      orderedBrowse: false,
      // No DDL scripting or FK relations — Lance has neither SQL DDL nor foreign keys.
      script: false,
      relations: false,
      // Traces: BASED-AGENT-SURFACE-VARIANT
      engine: "lancedb",
      variant: this.variant(),
      containers: this.baseFolderDbs ? [...this.baseFolderDbs.keys()].sort() : null,
      wherePredicate: true,
      structuredFilters: false,
      countRows: true,
      takeByKey: true,
      indexIntrospect: true,
    };
  }

  /** Which of the three LanceDB shapes this connection is. Cloud is a config property; base-folder
   *  is only known after connect() has scanned the directory, so before that a local connection
   *  reports "lancedb-local" (it has no containers to report either way). */
  private variant(): ConnectionVariant {
    if (this.isCloud()) return "lancedb-cloud";
    return this.baseFolderDbs ? "lancedb-basefolder" : "lancedb-local";
  }
  /** The SQL surface here is DuckDB's (via the lance extension). `write` is false, so the
   *  write-path members of this dialect are never exercised. */
  readonly dialect: SqlDialect = DUCKDB_DIALECT;
  readonly database: string;
  private conn: lancedb.Connection | null = null;
  /** Populated instead of `conn` when the local directory has no tables of its own but contains
   *  subfolders that are themselves valid LanceDB databases (BASED-LANCE-BASEFOLDER). Keyed by
   *  subfolder name, which doubles as the `schema` in listObjects()/DbObject. */
  private baseFolderDbs: Map<string, { conn: lancedb.Connection; tables: string[] }> | null = null;
  private statusCb: ((status: ConnectionStatus, detail?: string) => void) | null = null;
  private readonly rowCap: number;
  /** The resolved local directory (set by connect() on non-cloud configs) — the SQL bridge's source. */
  private localDir: string | null = null;
  private sqlBridge: LanceSqlBridge | null = null;

  constructor(
    private readonly cfg: ConnectionConfig,
    private readonly getSecret: SecretProvider,
    opts?: { database?: string; rowCap?: number },
  ) {
    this.database = opts?.database || cfg.database || settingStr(cfg, "uri") || "lancedb";
    this.rowCap = opts?.rowCap ?? DEFAULT_ROW_CAP;
  }

  onStatus(cb: (status: ConnectionStatus, detail?: string) => void): void {
    this.statusCb = cb;
  }

  private emitStatus(status: ConnectionStatus, detail?: string): void {
    this.statusCb?.(status, detail);
  }

  private isCloud(): boolean {
    return this.cfg.authType === "lancedb-cloud" || (settingStr(this.cfg, "uri")?.startsWith("db://") ?? false);
  }

  async connect(): Promise<void> {
    this.emitStatus("connecting");
    try {
      if (this.isCloud()) {
        const uri = settingStr(this.cfg, "uri");
        if (!uri) throw new Error("LanceDB cloud connection requires a db:// URI");
        const apiKey = this.getSecret(this.cfg.id) ?? undefined;
        this.conn = await lancedb.connect({ uri, apiKey, region: settingStr(this.cfg, "region") });
        this.baseFolderDbs = null;
      } else {
        // Local: uri is a directory path (fall back to server/database for hand-written configs).
        const dir = settingStr(this.cfg, "uri") ?? settingStr(this.cfg, "server") ?? this.cfg.database;
        if (!dir) throw new Error("LanceDB local connection requires a directory path");
        this.localDir = dir;
        const dirBase = basename(dir);
        if (dirBase.toLowerCase().endsWith(".lance")) {
          throw new Error(
            `"${dir}" looks like a single LanceDB table directory ("${dirBase}"). Point the connection at its parent folder instead.`,
          );
        }
        const direct = await lancedb.connect(dir);
        const directTables = await direct.tableNames();
        if (directTables.length > 0) {
          // dir is itself a LanceDB database.
          this.conn = direct;
          this.baseFolderDbs = null;
        } else if (this.isEmptyDir(dir)) {
          // Traces: BASED-LANCE-CONNECT — a truly empty directory bootstraps as an empty single-db
          // database so a brand-new database can be built from nothing (BASED-LANCE-CREATE-TABLE).
          // A populated non-Lance directory still errors below.
          this.conn = direct;
          this.baseFolderDbs = null;
        } else {
          // Traces: BASED-LANCE-BASEFOLDER — dir has no tables of its own; treat it as a base folder
          // and scan its subdirectories for ones that are themselves valid LanceDB databases.
          this.closeConn(direct);
          this.conn = null;
          this.baseFolderDbs = await this.discoverBaseFolder(dir);
          if (this.baseFolderDbs.size === 0) {
            throw new Error(`No LanceDB tables found in "${dir}" or its subfolders.`);
          }
        }
      }
      this.emitStatus("connected");
    } catch (err) {
      this.emitStatus("disconnected", errMessage(err));
      throw err;
    }
  }

  /** Scan `dir`'s immediate subdirectories for ones that open as a LanceDB connection with at least
   *  one table; anything else (a stray file, an unrelated empty folder) is silently skipped. */
  private async discoverBaseFolder(dir: string): Promise<Map<string, { conn: lancedb.Connection; tables: string[] }>> {
    const found = new Map<string, { conn: lancedb.Connection; tables: string[] }>();
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return found;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (LANCE_RESERVED_DIR_NAMES.has(entry.name)) continue;
      try {
        const sub = await lancedb.connect(join(dir, entry.name));
        const tables = await sub.tableNames();
        if (tables.length > 0) found.set(entry.name, { conn: sub, tables });
        else this.closeConn(sub);
      } catch {
        // Not a valid LanceDB directory — skip.
      }
    }
    return found;
  }

  private isEmptyDir(dir: string): boolean {
    try {
      return readdirSync(dir).length === 0;
    } catch {
      return false;
    }
  }

  private closeConn(conn: lancedb.Connection): void {
    try {
      if (conn.isOpen()) conn.close();
    } catch {
      // best-effort
    }
  }

  async disconnect(): Promise<void> {
    await this.sqlBridge?.close().catch(() => {});
    this.sqlBridge = null;
    if (this.conn) this.closeConn(this.conn);
    if (this.baseFolderDbs) for (const { conn } of this.baseFolderDbs.values()) this.closeConn(conn);
    this.conn = null;
    this.baseFolderDbs = null;
    this.localDir = null;
    this.indexCache.clear();
    this.emitStatus("disconnected");
  }

  // Traces: BASED-LANCE-CONNECT — open, count tables as a liveness check, tear down.
  async probe(): Promise<TestResult> {
    try {
      await this.connect();
      if (this.baseFolderDbs) {
        const dbs = [...this.baseFolderDbs.values()];
        const tableCount = dbs.reduce((n, d) => n + d.tables.length, 0);
        return {
          ok: true,
          serverVersion: `LanceDB (${dbs.length} folder${dbs.length === 1 ? "" : "s"}, ${tableCount} table${tableCount === 1 ? "" : "s"} total)`,
        };
      }
      const names = await this.requireConn().tableNames();
      return { ok: true, serverVersion: `LanceDB (${names.length} table${names.length === 1 ? "" : "s"})` };
    } catch (err) {
      return { ok: false, error: errMessage(err) };
    } finally {
      await this.disconnect().catch(() => {});
    }
  }

  private requireConn(): lancedb.Connection {
    if (!this.conn) throw new Error("Not connected");
    return this.conn;
  }

  /** Resolve which table to open. With `schema` (the UI always passes the subfolder name from
   *  listObjects() in base-folder mode), it's a direct lookup. Without one (the agent tools, which
   *  only know a bare table name), search every subfolder for a match — erroring if the name is
   *  absent everywhere or ambiguous across folders. */
  private async resolveTable(name: string, schema?: string): Promise<lancedb.Table> {
    if (!this.baseFolderDbs) return this.requireConn().openTable(name);
    if (schema) {
      const entry = this.baseFolderDbs.get(schema);
      if (!entry) throw new Error(`Unknown LanceDB folder: ${schema}`);
      return entry.conn.openTable(name);
    }
    const matches = [...this.baseFolderDbs.entries()].filter(([, entry]) => entry.tables.includes(name));
    if (matches.length === 0) throw new Error(`Table "${name}" not found in any LanceDB folder under the base directory.`);
    if (matches.length > 1) {
      const folders = matches.map(([folder]) => folder).join(", ");
      throw new Error(`Table "${name}" exists in multiple folders (${folders}); open it via the Object Explorer to disambiguate.`);
    }
    return matches[0]![1].conn.openTable(name);
  }

  async listDatabases(): Promise<string[]> {
    return [this.database];
  }

  // LanceDB has no schema namespace; base-folder mode (BASED-LANCE-BASEFOLDER) repurposes it to hold
  // the owning subfolder name so the explorer's schema filter can select one folder's tables.
  async listSchemas(): Promise<string[]> {
    if (!this.baseFolderDbs) return [];
    return [...this.baseFolderDbs.keys()].sort();
  }

  // Traces: BASED-LANCE-BROWSE, BASED-LANCE-BASEFOLDER
  async listObjects(): Promise<DbObject[]> {
    if (this.baseFolderDbs) {
      const objects: DbObject[] = [];
      const folders = [...this.baseFolderDbs.entries()].sort(([a], [b]) => a.localeCompare(b));
      for (const [schema, { tables }] of folders) {
        for (const name of tables) objects.push({ schema, name, type: "table" as const });
      }
      return objects;
    }
    const names = await this.requireConn().tableNames();
    return names.map((name) => ({ schema: "", name, type: "table" as const }));
  }

  // Traces: BASED-LANCE-BROWSE, BASED-LANCE-VECTOR-METRIC — map the Arrow schema to TableColumn,
  // flagging vector columns and (memoized) their ANN index metric.
  async getTableColumns(schema: string, table: string): Promise<TableColumn[]> {
    const t = await this.resolveTable(table, schema || undefined);
    const arrowSchema = await t.schema();
    const cols = arrowSchema.fields.map((f) => {
      const vec = vectorInfo(f.type);
      return {
        name: f.name,
        type: String(f.type),
        maxLength: vec ? vec.dim : null,
        precision: null,
        scale: null,
        nullable: f.nullable ?? true,
        isPrimaryKey: false,
        isForeignKey: false,
        fkTarget: null,
        isVector: vec != null,
        vectorDimension: vec ? vec.dim : null,
        vectorMetric: null as TableColumn["vectorMetric"],
        elementType: vec ? vec.elementType : null,
      };
    });
    if (cols.some((c) => c.isVector)) {
      const indexes = await this.indexesFor(schema, table, t);
      for (const c of cols) {
        const metric = indexes.find((i) => i.keyColumns[0]?.name === c.name)?.distanceType;
        if (c.isVector && metric) c.vectorMetric = metric;
      }
    }
    return cols;
  }

  // Traces: BASED-INDEX-INTROSPECT, BASED-LANCE-VECTOR-METRIC — one memoized listIndices +
  // indexStats round-trip per table, feeding BOTH the per-column vector metric (which runs on every
  // page read and search, hence the cache) and the index panel / get_indexes tool. Previously only
  // `distanceType` survived this call; indexType and the indexed/unindexed row split were fetched
  // and thrown away, which is exactly what the agent needed to know whether nprobes or ef is live
  // and why a freshly-appended row isn't showing up in search.
  private indexCache = new Map<string, TableIndex[]>();

  private async indexesFor(schema: string, table: string, t: lancedb.Table): Promise<TableIndex[]> {
    const key = `${schema}/${table}`;
    const cached = this.indexCache.get(key);
    if (cached) return cached;
    const out: TableIndex[] = [];
    try {
      for (const idx of await t.listIndices()) {
        const stats = await t.indexStats(idx.name).catch(() => undefined);
        const metric = stats?.distanceType?.toLowerCase();
        out.push({
          name: idx.name,
          typeDesc: String(stats?.indexType ?? idx.indexType ?? "").toUpperCase(),
          isUnique: false,
          isPrimaryKey: false,
          isUniqueConstraint: false,
          filterDefinition: null,
          keyColumns: idx.columns.map((name) => ({ name, descending: false })),
          includedColumns: [],
          distanceType: metric === "l2" || metric === "cosine" || metric === "dot" ? metric : null,
          numIndexedRows: stats?.numIndexedRows ?? null,
          numUnindexedRows: stats?.numUnindexedRows ?? null,
          numIndices: stats?.numIndices ?? null,
        });
      }
    } catch {
      // best-effort: an empty list beats a failed column listing (getTableColumns depends on this)
    }
    this.indexCache.set(key, out);
    return out;
  }

  async getIndexes(schema: string, table: string): Promise<TableIndex[]> {
    const t = await this.resolveTable(table, schema || undefined);
    return this.indexesFor(schema, table, t);
  }

  // Traces: BASED-LANCE-BROWSE, BASED-LANCE-SCAN — one page, capped by the row cap. LanceDB rows are
  // unordered (no PK), so orderBy is empty; paging uses the query offset/limit. `where` is a Lance
  // predicate, and on a cloud connection it is the only way to narrow rows at all — there is no SQL.
  async readTablePage(
    schema: string,
    table: string,
    opts: { offset: number; limit: number; where?: string },
  ): Promise<TablePage> {
    const t = await this.resolveTable(table, schema || undefined);
    const columns = await this.getTableColumns(schema, table);
    const limit = Math.min(Math.max(1, Math.floor(opts.limit)), this.rowCap);
    const offset = Math.max(0, Math.floor(opts.offset));
    let q = t.query();
    if (opts.where) q = q.where(opts.where);
    const records = await q.offset(offset).limit(limit).toArray();
    const rows = this.serializeRecords(records, columns);
    return { columns, rows, orderBy: [] };
  }

  // Traces: BASED-LANCE-SCAN — cheap total, so the caller can decide between paging and aggregating
  // and can tell the user how big the answer is. hasMore alone says nothing about scale.
  async countRows(schema: string, table: string, opts?: { where?: string }): Promise<number> {
    const t = await this.resolveTable(table, schema || undefined);
    // A blank predicate means "no filter" — passing it through reaches the Lance parser as an empty
    // expression and fails with `Expected: an expression, found: EOF`. Every other read path here
    // guards the same way (readTablePage, and the three search modes).
    return t.countRows(opts?.where?.trim() || undefined);
  }

  /** A Lance predicate literal. Strings are single-quoted with '' escaping (the same convention as
   *  SQL); numbers pass through after a finite check. Callers never build this themselves — that is
   *  the whole point of take_rows existing next to a free-text `where`. */
  private static predicateLiteral(v: string | number): string {
    if (typeof v === "number") {
      if (!Number.isFinite(v)) throw new Error(`Cannot match on a non-finite key value (${v}).`);
      return String(v);
    }
    return `'${v.replaceAll("'", "''")}'`;
  }

  // Traces: BASED-LANCE-SCAN — fetch specific rows by id. The common follow-up to a search that
  // returned keys; on cloud there is no SQL to hand-write it with.
  async takeRows(
    schema: string,
    table: string,
    opts: { keyColumn: string; keys: Array<string | number>; columns?: string[] },
  ): Promise<TablePage> {
    const t = await this.resolveTable(table, schema || undefined);
    const columns = await this.getTableColumns(schema, table);
    if (!columns.some((c) => c.name === opts.keyColumn)) {
      throw new Error(`Unknown column "${opts.keyColumn}" on ${table}. Columns: ${columns.map((c) => c.name).join(", ")}`);
    }
    if (opts.keys.length === 0) return { columns, rows: [], orderBy: [] };
    const list = opts.keys.map((k) => LanceDbAdapter.predicateLiteral(k)).join(", ");
    // Lance predicates are DataFusion-flavoured: a double-quoted name is parsed as a STRING literal,
    // not an identifier, so `"id" IN (…)` silently matches nothing. Plain names go bare; anything
    // else is backtick-quoted, which is the identifier quote this dialect actually honours.
    const ident = /^[A-Za-z_][A-Za-z0-9_]*$/.test(opts.keyColumn)
      ? opts.keyColumn
      : `\`${opts.keyColumn.replaceAll("`", "``")}\``;
    let q = t.query().where(`${ident} IN (${list})`).limit(Math.min(opts.keys.length, this.rowCap));
    if (opts.columns?.length) q = q.select(opts.columns);
    const records = (await q.toArray()) as Array<Record<string, unknown>>;
    const projected = opts.columns?.length ? columns.filter((c) => opts.columns!.includes(c.name)) : columns;
    return { columns: projected, rows: this.serializeRecords(records, projected), orderBy: [] };
  }

  // Traces: BASED-EMBED-VECTORS — full-precision vector sample for the Embeddings view. The only
  // read path that ships raw vectors (bypasses serializeLanceValue's preview cap on purpose).
  // LanceDB has no cheap random sample, so evenly-strided chunks approximate uniform coverage of
  // insert order at columnar-scan cost.
  async readVectorSample(
    schema: string,
    table: string,
    opts: { column: string; limit: number; textCap?: number },
  ): Promise<VectorSampleResult> {
    const t = await this.resolveTable(table, schema || undefined);
    const columns = await this.getTableColumns(schema, table);
    const vecCol = columns.find((c) => c.name === opts.column);
    if (!vecCol?.isVector || !vecCol.vectorDimension) {
      throw new Error(`"${opts.column}" is not a vector column of ${table}`);
    }
    const dim = vecCol.vectorDimension;
    const totalRows = await t.countRows();
    const byteBudget = 128 * 1024 * 1024;
    const target = Math.max(
      1,
      Math.min(Math.floor(opts.limit) || 1, this.rowCap, Math.floor(byteBudget / (dim * 4)), totalRows),
    );
    const textCap = opts.textCap ?? 2000;
    const otherCols = columns.filter((c) => !c.isVector);
    const select = [opts.column, ...otherCols.map((c) => c.name)];

    // Sequential read when everything fits; otherwise ≥32 evenly-strided chunks so even a small
    // sample spans the whole table's insert order instead of just its head.
    const CHUNK = 1024;
    const sampling = totalRows > target;
    const nChunks = sampling ? Math.min(target, Math.max(32, Math.ceil(target / CHUNK))) : Math.max(1, Math.ceil(totalRows / CHUNK));
    const per = Math.ceil(target / nChunks);
    const stride = sampling ? Math.floor(totalRows / nChunks) : CHUNK;

    const vectors = new Float32Array(target * dim);
    const rows: unknown[][] = [];
    let count = 0;
    for (let i = 0; i < nChunks && count < target; i++) {
      const offset = Math.min(i * stride, Math.max(0, totalRows - 1));
      const take = Math.min(sampling ? per : CHUNK, target - count, totalRows - offset);
      if (take <= 0) break;
      const records = await t.query().select(select).offset(offset).limit(take).toArray();
      for (const rec of records) {
        if (count >= target) break;
        const cell = rec[opts.column];
        if (cell == null) continue; // null vector — nothing to plot
        const nums = Array.from(cell as Iterable<number>, Number);
        if (nums.length !== dim) continue; // ragged — never valid coordinates
        vectors.set(nums, count * dim);
        rows.push(
          otherCols.map((c) => {
            const v = serializeLanceValue(rec[c.name], false);
            return typeof v === "string" && v.length > textCap ? v.slice(0, textCap) : v;
          }),
        );
        count++;
      }
    }
    return {
      dim,
      count,
      totalRows,
      sampled: count < totalRows,
      columns: otherCols.map((c) => ({ name: c.name, type: c.type })),
      rows,
      vectors: count === target ? vectors : vectors.slice(0, count * dim),
    };
  }

  /** Turn LanceDB result records into wire rows, summarizing vector cells. Columns not in `cols`
   *  (e.g. `_distance`/`_relevance_score` added by a search) are appended as plain scalar columns. */
  private serializeRecords(records: Array<Record<string, unknown>>, cols: TableColumn[]): WireValue[][] {
    const vectorNames = new Set(cols.filter((c) => c.isVector).map((c) => c.name));
    return records.map((rec) => cols.map((c) => serializeLanceValue(rec[c.name], vectorNames.has(c.name))));
  }

  /** Build the ordered column list for a search result: the table's own columns plus any extra
   *  fields the search adds (score columns), in a stable order. */
  private searchColumns(records: Array<Record<string, unknown>>, base: TableColumn[]): { columns: ColumnInfo[]; order: string[] } {
    const order = base.map((c) => c.name);
    const seen = new Set(order);
    for (const rec of records) {
      for (const k of Object.keys(rec)) {
        if (!seen.has(k)) {
          seen.add(k);
          order.push(k);
        }
      }
    }
    const columns: ColumnInfo[] = order.map((name) => {
      const bc = base.find((c) => c.name === name);
      return { name, type: bc?.type ?? "" };
    });
    return { columns, order };
  }

  /** Whichever native score column LanceDB attached beyond the base schema — `_distance` (vector) is
   *  ascending (smaller = closer); `_relevance_score` (hybrid, per LanceDB's own convention — see the
   *  lance-search skill) and anything else observed is treated as descending (bigger = better). Falls
   *  back to any other extra numeric column so this isn't hardcoded to just those two names. */
  private nativeScoreColumn(records: Array<Record<string, unknown>>, base: TableColumn[]): string | null {
    if (records.length === 0) return null;
    const baseNames = new Set(base.map((c) => c.name));
    const extra = Object.keys(records[0]!).filter((k) => !baseNames.has(k) && typeof records[0]![k] === "number");
    if (extra.includes("_distance")) return "_distance";
    if (extra.includes("_relevance_score")) return "_relevance_score";
    return extra[0] ?? null;
  }

  private isAscendingScore(scoreKey: string): boolean {
    return scoreKey === "_distance";
  }

  /** Column names that conventionally hold the row's prose content. */
  private static readonly CONTENT_COLUMN_NAMES = /^(text|content|body|document|chunk|passage|summary|description|message)$/i;

  /** Rerank document texts are capped — an over-long document overflows small local rerankers'
   *  context windows (LM Studio then silently returns empty completions with no logprobs) and adds
   *  nothing to a relevance judgment. */
  private static readonly RERANK_DOC_MAX_CHARS = 6000;

  /** The column whose values become the reranker's "document text" when no explicit
   *  rerankTextColumn is supplied: a conventionally-named content column if present, else the
   *  string column with the longest values across the sampled candidates (so an id/ref column that
   *  happens to sort first can't win), else the first non-vector column. */
  private guessTextColumn(base: TableColumn[], records: Array<Record<string, unknown>>, preferred?: string[]): string | null {
    const candidates = preferred?.length ? base.filter((c) => preferred.includes(c.name)) : base;
    const strings = candidates.filter((c) => !c.isVector && /utf8|string|large_utf8/i.test(c.type));
    const named = strings.find((c) => LanceDbAdapter.CONTENT_COLUMN_NAMES.test(c.name));
    if (named) return named.name;
    let best: TableColumn | undefined;
    let bestLen = 0;
    for (const c of strings) {
      const total = records.reduce((sum, r) => sum + String(r[c.name] ?? "").length, 0);
      if (total > bestLen) {
        bestLen = total;
        best = c;
      }
    }
    return best?.name ?? strings[0]?.name ?? candidates.find((c) => !c.isVector)?.name ?? null;
  }

  private documentText(record: Record<string, unknown>, col: string | null, base: TableColumn[]): string {
    if (col) return String(record[col] ?? "");
    const vectorNames = new Set(base.filter((c) => c.isVector).map((c) => c.name));
    return Object.entries(record)
      .filter(([k]) => !vectorNames.has(k))
      .map(([k, v]) => `${k}: ${v}`)
      .join(" | ");
  }

  /** Traces: BASED-SEARCH-PARAM-NAMES — direction-aware score thresholds against `scoreKey`
   *  (already-sorted `records`, best first). "min" is relative to score *quality*, not to the
   *  number: for an ascending score like `_distance`, minScore is enforced as an upper bound.
   *  No-op if there's no score column or neither bound is set. */
  private applyScoreThresholds(
    records: Array<Record<string, unknown>>,
    scoreKey: string | null,
    minScore?: number,
    maxScoreGapFromTop?: number,
  ): Array<Record<string, unknown>> {
    if (!scoreKey || (minScore == null && maxScoreGapFromTop == null)) return records;
    const ascending = this.isAscendingScore(scoreKey);
    const top = records[0]?.[scoreKey] as number | undefined;
    return records.filter((rec) => {
      const score = rec[scoreKey] as number;
      if (minScore != null) {
        if (ascending && score > minScore) return false;
        if (!ascending && score < minScore) return false;
      }
      if (maxScoreGapFromTop != null && top != null) {
        if (ascending && score - top > maxScoreGapFromTop) return false;
        if (!ascending && top - score > maxScoreGapFromTop) return false;
      }
      return true;
    });
  }

  // Traces: BASED-LANCE-SEARCH-KNOBS — chain the SDK's vector-query tuning knobs onto a VectorQuery.
  // Applied in the vector branch and the hybrid branch (after .nearestTo, before the RRF .rerank).
  private applyVectorKnobs(q: lancedb.VectorQuery, p: LanceSearchParams): lancedb.VectorQuery {
    if (p.distanceType != null) q = q.distanceType(p.distanceType);
    if (p.nprobes != null) q = q.nprobes(p.nprobes);
    if (p.refineFactor != null) q = q.refineFactor(p.refineFactor);
    if (p.ef != null) q = q.ef(p.ef);
    if (p.postfilter) q = q.postfilter();
    if (p.bypassVectorIndex) q = q.bypassVectorIndex();
    if (p.distanceRangeLower != null || p.distanceRangeUpper != null) {
      q = q.distanceRange(p.distanceRangeLower, p.distanceRangeUpper);
    }
    return q;
  }

  // Traces: BASED-LANCE-EMBED-DIM-GUARD — LanceDB's own failure ("No vector column found to match
  // with the query vector dimension: N") names neither the column nor the model that produced the
  // vector, which is precisely what you need to know when a connection's default embedding profile
  // points at the wrong model. A table with no vector column is left alone: there's nothing to
  // compare against, and the engine's error is already the right one.
  private assertVectorDimension(
    vector: number[],
    baseCols: TableColumn[],
    table: string,
    model?: string,
    vectorColumn?: string,
  ): void {
    let vectorCols = baseCols.filter((c) => c.isVector && typeof c.vectorDimension === "number");
    if (vectorColumn) {
      // Traces: BASED-LANCE-VECTOR-COLUMN — when a column is named, check against THAT column;
      // otherwise a two-embedding table would pass the guard on the wrong column's dimension.
      const named = baseCols.find((c) => c.name === vectorColumn);
      if (!named?.isVector) {
        throw new Error(
          `"${vectorColumn}" is not a vector column of ${table}. Vector columns: ${
            vectorCols.map((c) => `"${c.name}" (${c.vectorDimension})`).join(", ") || "none"
          }`,
        );
      }
      vectorCols = [named];
    }
    if (vectorCols.length === 0) return;
    if (vectorCols.some((c) => c.vectorDimension === vector.length)) return;
    const expected =
      vectorCols.length === 1
        ? `the "${vectorCols[0]!.name}" column of ${table} holds ${vectorCols[0]!.vectorDimension}`
        : `${table}'s vector columns hold ${vectorCols.map((c) => `"${c.name}" (${c.vectorDimension})`).join(", ")}`;
    const blame = model
      ? ` Embedding model "${model}" produced the wrong size — pick a profile whose model matches the column.`
      : "";
    throw new Error(`Query vector has ${vector.length} dimensions but ${expected}.${blame}`);
  }

  private static readonly VECTOR_KNOB_KEYS = [
    "distanceType",
    "nprobes",
    "refineFactor",
    "ef",
    "postfilter",
    "bypassVectorIndex",
    "distanceRangeLower",
    "distanceRangeUpper",
  ] as const;

  // Traces: BASED-LANCE-SEARCH-UNIFIED, BASED-LANCE-VECTOR-SEARCH, BASED-LANCE-FTS, BASED-LANCE-HYBRID,
  // BASED-LANCE-SEARCH-KNOBS
  // The pipeline order, in one place — every search tool's description repeats it verbatim:
  //   probe (nprobes/ef) → prefilter (where, unless postfilter) → candidatePool → rerank
  //   (rerankTopN) → threshold (minScore/maxScoreGapFromTop) → k
  // RRFReranker (hybrid mode) is only LanceDB's internal vector+FTS fusion plumbing here — never the
  // user-configured reranker profile.
  async search(params: LanceSearchParams): Promise<SearchRows> {
    if (params.mode === "text") {
      const used = LanceDbAdapter.VECTOR_KNOB_KEYS.filter((k) => params[k] != null && params[k] !== false);
      if (used.length > 0) {
        throw new Error(`${used.join("/")} require vector or hybrid mode — text (FTS) search has no vector query to tune.`);
      }
    }
    const candidatePool = Math.min(Math.max(1, Math.floor(params.candidatePool ?? 50)), this.rowCap);
    const keepSize = Math.min(Math.max(1, Math.floor(params.keepSize ?? 10)), candidatePool);

    // Resolved before embedding so the dimension guard below can compare against the real column
    // (BASED-LANCE-EMBED-DIM-GUARD).
    const t = await this.resolveTable(params.table, params.schema || undefined);
    const baseCols = await this.getTableColumns(params.schema ?? "", params.table);

    let vector = params.vector;
    if ((params.mode === "vector" || params.mode === "hybrid") && !vector) {
      if (!params.query) throw new Error(`${params.mode} search needs a query vector or a text query`);
      if (!params.embeddingProfile) {
        throw new Error(
          "No embedding profile selected — set this connection's embedding profile, pass an embedding profile id, or supply a raw vector",
        );
      }
      vector = await embedQuery(params.embeddingProfile, params.query);
    }
    if (vector) {
      this.assertVectorDimension(vector, baseCols, params.table, params.embeddingProfile?.model, params.vectorColumn);
    }

    // Traces: BASED-LANCE-VECTOR-COLUMN — without .column(), LanceDB picks the vector column itself
    // and a table with two embeddings is only reachable by whichever one it happens to pick.
    const onColumn = (q: lancedb.VectorQuery): lancedb.VectorQuery =>
      params.vectorColumn ? q.column(params.vectorColumn) : q;

    let records: Array<Record<string, unknown>>;
    if (params.mode === "vector") {
      if (!vector) throw new Error("vector search needs a query vector or a text query");
      let q = this.applyVectorKnobs(onColumn(t.vectorSearch(vector as never)).limit(candidatePool), params);
      if (params.where) q = q.where(params.where);
      if (params.columns?.length) q = q.select(params.columns);
      records = (await q.toArray()) as Array<Record<string, unknown>>;
    } else if (params.mode === "text") {
      if (!params.query) throw new Error("text search needs a query");
      let q = t.query().fullTextSearch(params.query).limit(candidatePool);
      if (params.where) q = q.where(params.where);
      if (params.columns?.length) q = q.select(params.columns);
      records = (await q.toArray()) as Array<Record<string, unknown>>;
    } else {
      if (!params.query || !vector) throw new Error("hybrid search needs both a text query and a vector");
      const fusion = await lancedb.rerankers.RRFReranker.create();
      let q = this.applyVectorKnobs(onColumn(t.query().fullTextSearch(params.query).nearestTo(vector as never)), params)
        .rerank(fusion)
        .limit(candidatePool);
      if (params.where) q = q.where(params.where);
      if (params.columns?.length) q = q.select(params.columns);
      records = (await q.toArray()) as Array<Record<string, unknown>>;
    }

    let scoreKey = this.nativeScoreColumn(records, baseCols);
    let finalRecords = records;

    if (params.rerankerProfile && params.query && records.length > 0) {
      const textCol = params.rerankTextColumn ?? this.guessTextColumn(baseCols, records, params.columns);
      const documents = records.map((r) => this.documentText(r, textCol, baseCols).slice(0, LanceDbAdapter.RERANK_DOC_MAX_CHARS));
      const scored = await rerank(params.rerankerProfile, params.query, documents, params.rerankerOptions);
      finalRecords = scored
        .map(({ index, relevanceScore }) => ({ ...records[index], _rerank_score: relevanceScore }))
        .sort((a, b) => (b._rerank_score as number) - (a._rerank_score as number));
      scoreKey = "_rerank_score";
    } else if (scoreKey) {
      const ascending = this.isAscendingScore(scoreKey);
      finalRecords = [...records].sort((a, b) =>
        ascending ? (a[scoreKey!] as number) - (b[scoreKey!] as number) : (b[scoreKey!] as number) - (a[scoreKey!] as number),
      );
    }

    finalRecords = this.applyScoreThresholds(finalRecords, scoreKey, params.minScore, params.maxScoreGapFromTop);
    finalRecords = finalRecords.slice(0, keepSize);

    const { columns, order } = this.searchColumns(finalRecords, baseCols);
    const vectorNames = new Set(baseCols.filter((c) => c.isVector).map((c) => c.name));
    const rows = finalRecords.map((rec) => order.map((name) => serializeLanceValue(rec[name], vectorNames.has(name))));
    return { columns, rows };
  }

  // Traces: BASED-LANCE-SQL — local connections run real SQL through the embedded DuckDB bridge;
  // cloud connections keep the graceful error (capabilities.sql is false there).
  execute(sql: string, onChunk: (chunk: QueryChunk) => void, opts?: ExecuteOptions): QueryExecution {
    const fail = (message: string): QueryExecution => {
      onChunk({ type: "error", message });
      onChunk({ type: "done", durationMs: 0, status: "error" });
      return { cancel() {}, completion: Promise.resolve({ status: "error" as const, durationMs: 0 }) };
    };
    if (this.isCloud()) {
      return fail("LanceDB Cloud connections have no SQL editor. Use vector, text, or hybrid search instead.");
    }
    try {
      return this.requireSqlBridge().execute(sql, onChunk, opts);
    } catch (err) {
      return fail(errMessage(err));
    }
  }

  /** The DuckDB bridge for this connection, created lazily on first SQL/LSP use. Throws on cloud
   *  configs and before connect() has resolved the local directory + base-folder layout. */
  requireSqlBridge(): LanceSqlBridge {
    if (this.isCloud()) throw new Error("LanceDB Cloud connections have no SQL surface.");
    if (!this.localDir) throw new Error("Not connected");
    this.sqlBridge ??= new LanceSqlBridge(
      { dir: this.localDir, folders: this.baseFolderDbs ? [...this.baseFolderDbs.keys()] : null },
      this.rowCap,
    );
    return this.sqlBridge;
  }

  // Read-only in this build (capabilities.write is false).
  async runCommands(_commands: DbCommand[]): Promise<CommandResult> {
    return { rowsAffected: [], error: "LanceDB connections are read-only in this build." };
  }

  // Traces: BASED-LANCE-CREATE-TABLE — the one write this build allows: creating an EMPTY table
  // with an explicit schema (createEmptyTable, default mode "create" so an existing name errors,
  // never overwrites). Never from seed rows: row inference maps every JS number to Float64 and
  // errors on dates, and with no delete in this build a junk seed row would be permanent.
  async createTable(spec: { name: string; folder?: string; columns: LanceColumnSpec[] }): Promise<{ columns: TableColumn[] }> {
    if (this.isCloud()) throw new Error("Creating tables on LanceDB Cloud is not supported in this build.");
    const name = spec.name?.trim();
    if (!name) throw new Error("Table name is required.");
    if (/[\\/]/.test(name) || name.startsWith(".")) throw new Error(`Invalid table name "${name}".`);
    const schema = buildLanceSchema(spec.columns);

    const folder = spec.folder?.trim() || undefined;
    let conn: lancedb.Connection;
    let newFolder: string | null = null;
    if (this.baseFolderDbs) {
      if (!folder) throw new Error("This is a base-folder connection — name the folder to create the table in.");
      const existing = this.baseFolderDbs.get(folder);
      if (existing) {
        conn = existing.conn;
      } else {
        if (/[\\/]/.test(folder) || folder.startsWith(".")) throw new Error(`Invalid folder name "${folder}".`);
        if (LANCE_RESERVED_DIR_NAMES.has(folder)) {
          throw new Error(`"${folder}" is a reserved LanceDB directory name and cannot be a folder.`);
        }
        if (folder.toLowerCase().endsWith(".lance")) {
          throw new Error(`Folder names cannot end with ".lance" — that suffix marks a table directory.`);
        }
        if (!this.localDir) throw new Error("Not connected");
        conn = await lancedb.connect(join(this.localDir, folder));
        newFolder = folder;
      }
    } else {
      if (folder) throw new Error("This connection has no folders — omit `folder`.");
      conn = this.requireConn();
    }

    if ((await conn.tableNames()).includes(name)) {
      throw new Error(`Table "${name}" already exists${folder ? ` in folder "${folder}"` : ""}.`);
    }
    await conn.createEmptyTable(name, schema as never);

    // Keep this session's snapshots honest: the base-folder table list feeds listObjects(), and the
    // DuckDB bridge ATTACHed the directory layout at boot (a new folder needs a new ATTACH) — other
    // windows' sessions stay stale until they reconnect.
    if (this.baseFolderDbs && folder) {
      if (newFolder) this.baseFolderDbs.set(newFolder, { conn, tables: [name] });
      else {
        const entry = this.baseFolderDbs.get(folder)!;
        if (!entry.tables.includes(name)) entry.tables.push(name);
      }
    }
    await this.sqlBridge?.close().catch(() => {});
    this.sqlBridge = null;
    return { columns: await this.getTableColumns(folder ?? "", name) };
  }
}
