// Traces: BASED-LANCE-CONNECT, BASED-LANCE-BROWSE, BASED-LANCE-VECTOR-SEARCH, BASED-LANCE-FTS,
//         BASED-LANCE-HYBRID, BASED-LANCE-WIRE
// LanceDB adapter — a second engine behind the DatabaseAdapter interface. Local (file-based) opens a
// directory URI; cloud opens `db://slug` with an API key (from the secret channel) + region. LanceDB
// has no SQL surface, no schemas, no primary keys and no transactional writes — so execute/runCommands
// return graceful errors (capabilities.sql / .write are false) and the real value is the search methods.
import { readdirSync } from "node:fs";
import { basename, join } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import type { SecretProvider } from "./entra";
import { DEFAULT_ROW_CAP } from "./rowcap";
import { serializeLanceValue } from "./lanceSerialize";
import type {
  ColumnInfo,
  CommandResult,
  ConnectionConfig,
  ConnectionStatus,
  DatabaseAdapter,
  DbCommand,
  DbObject,
  ExecuteOptions,
  HybridSearchParams,
  QueryChunk,
  QueryExecution,
  SearchRows,
  TableColumn,
  TablePage,
  TestResult,
  TextSearchParams,
  VectorSearchParams,
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
  readonly capabilities = {
    sql: false,
    vectorSearch: true,
    fullTextSearch: true,
    hybridSearch: true,
    write: false,
  } as const;
  readonly database: string;
  private conn: lancedb.Connection | null = null;
  /** Populated instead of `conn` when the local directory has no tables of its own but contains
   *  subfolders that are themselves valid LanceDB databases (BASED-LANCE-BASEFOLDER). Keyed by
   *  subfolder name, which doubles as the `schema` in listObjects()/DbObject. */
  private baseFolderDbs: Map<string, { conn: lancedb.Connection; tables: string[] }> | null = null;
  private statusCb: ((status: ConnectionStatus, detail?: string) => void) | null = null;
  private readonly rowCap: number;

  constructor(
    private readonly cfg: ConnectionConfig,
    private readonly getSecret: SecretProvider,
    opts?: { database?: string; rowCap?: number },
  ) {
    this.database = opts?.database ?? cfg.database ?? cfg.uri ?? "lancedb";
    this.rowCap = opts?.rowCap ?? DEFAULT_ROW_CAP;
  }

  onStatus(cb: (status: ConnectionStatus, detail?: string) => void): void {
    this.statusCb = cb;
  }

  private emitStatus(status: ConnectionStatus, detail?: string): void {
    this.statusCb?.(status, detail);
  }

  private isCloud(): boolean {
    return this.cfg.authType === "lancedb-cloud" || (this.cfg.uri?.startsWith("db://") ?? false);
  }

  async connect(): Promise<void> {
    this.emitStatus("connecting");
    try {
      if (this.isCloud()) {
        const uri = this.cfg.uri;
        if (!uri) throw new Error("LanceDB cloud connection requires a db:// URI");
        const apiKey = this.getSecret(this.cfg.id) ?? undefined;
        this.conn = await lancedb.connect({ uri, apiKey, region: this.cfg.region });
        this.baseFolderDbs = null;
      } else {
        // Local: uri is a directory path (fall back to server/database for hand-written configs).
        const dir = this.cfg.uri ?? this.cfg.server ?? this.cfg.database;
        if (!dir) throw new Error("LanceDB local connection requires a directory path");
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

  private closeConn(conn: lancedb.Connection): void {
    try {
      if (conn.isOpen()) conn.close();
    } catch {
      // best-effort
    }
  }

  async disconnect(): Promise<void> {
    if (this.conn) this.closeConn(this.conn);
    if (this.baseFolderDbs) for (const { conn } of this.baseFolderDbs.values()) this.closeConn(conn);
    this.conn = null;
    this.baseFolderDbs = null;
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
          identity: this.database,
        };
      }
      const names = await this.requireConn().tableNames();
      return { ok: true, serverVersion: `LanceDB (${names.length} table${names.length === 1 ? "" : "s"})`, identity: this.database };
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

  // Traces: BASED-LANCE-BROWSE — map the Arrow schema to TableColumn, flagging vector columns.
  async getTableColumns(schema: string, table: string): Promise<TableColumn[]> {
    const t = await this.resolveTable(table, schema || undefined);
    const arrowSchema = await t.schema();
    return arrowSchema.fields.map((f) => {
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
        vectorMetric: null,
        elementType: vec ? vec.elementType : null,
      };
    });
  }

  // Traces: BASED-LANCE-BROWSE — one page, capped by the row cap. LanceDB rows are unordered (no PK),
  // so orderBy is empty; paging uses the query offset/limit.
  async readTablePage(schema: string, table: string, opts: { offset: number; limit: number }): Promise<TablePage> {
    const t = await this.resolveTable(table, schema || undefined);
    const columns = await this.getTableColumns(schema, table);
    const limit = Math.min(Math.max(1, Math.floor(opts.limit)), this.rowCap);
    const offset = Math.max(0, Math.floor(opts.offset));
    const records = await t.query().offset(offset).limit(limit).toArray();
    const rows = this.serializeRecords(records, columns);
    return { columns, rows, orderBy: [] };
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

  private async collectSearch(
    table: string,
    build: (q: lancedb.Table, cols: TableColumn[]) => Promise<Array<Record<string, unknown>>>,
  ): Promise<SearchRows> {
    const t = await this.resolveTable(table);
    const cols = await this.getTableColumns("", table);
    const records = await build(t, cols);
    const { columns, order } = this.searchColumns(records, cols);
    const vectorNames = new Set(cols.filter((c) => c.isVector).map((c) => c.name));
    const rows = records.map((rec) => order.map((name) => serializeLanceValue(rec[name], vectorNames.has(name))));
    return { columns, rows };
  }

  // Traces: BASED-LANCE-VECTOR-SEARCH
  async vectorSearch(params: VectorSearchParams): Promise<SearchRows> {
    const k = Math.min(Math.max(1, Math.floor(params.k ?? 10)), this.rowCap);
    return this.collectSearch(params.table, async (t) => {
      const queryVec = params.vector ?? params.query;
      if (queryVec == null) throw new Error("vector_search needs a query vector or a text query");
      let q = t.vectorSearch(queryVec as never).limit(k);
      if (params.where) q = q.where(params.where);
      if (params.columns?.length) q = q.select(params.columns);
      return (await q.toArray()) as Array<Record<string, unknown>>;
    });
  }

  // Traces: BASED-LANCE-FTS
  async textSearch(params: TextSearchParams): Promise<SearchRows> {
    const k = Math.min(Math.max(1, Math.floor(params.k ?? 10)), this.rowCap);
    return this.collectSearch(params.table, async (t) => {
      let q = t.query().fullTextSearch(params.query).limit(k);
      if (params.columns?.length) q = q.select(params.columns);
      return (await q.toArray()) as Array<Record<string, unknown>>;
    });
  }

  // Traces: BASED-LANCE-HYBRID — vector + full-text, reranked with reciprocal-rank fusion.
  async hybridSearch(params: HybridSearchParams): Promise<SearchRows> {
    const k = Math.min(Math.max(1, Math.floor(params.k ?? 10)), this.rowCap);
    return this.collectSearch(params.table, async (t) => {
      const queryVec = params.vector ?? params.query;
      if (queryVec == null) throw new Error("hybrid_search needs a query vector or a text query");
      const reranker = await lancedb.rerankers.RRFReranker.create();
      let q = t.query().fullTextSearch(params.query).nearestTo(queryVec as never).rerank(reranker).limit(k);
      if (params.columns?.length) q = q.select(params.columns);
      return (await q.toArray()) as Array<Record<string, unknown>>;
    });
  }

  // LanceDB has no SQL surface — emit a friendly error rather than pretend (capabilities.sql is false).
  execute(_sql: string, onChunk: (chunk: QueryChunk) => void, _opts?: ExecuteOptions): QueryExecution {
    const message = "LanceDB connections have no SQL editor. Use vector, text, or hybrid search instead.";
    onChunk({ type: "error", message });
    onChunk({ type: "done", durationMs: 0, status: "error" });
    return { cancel() {}, completion: Promise.resolve({ status: "error" as const, durationMs: 0 }) };
  }

  // Read-only in this build (capabilities.write is false).
  async runCommands(_commands: DbCommand[]): Promise<CommandResult> {
    return { rowsAffected: [], error: "LanceDB connections are read-only in this build." };
  }
}
