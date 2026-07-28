import sql from "mssql";
import type { TokenCredential } from "@azure/identity";
import { splitBatches } from "./batch";
import { settingBool, settingStr } from "./connectionSettings";
import { TSQL_DIALECT, type SqlDialect } from "./dialect";
import { createCredential, mintSqlToken, type SecretProvider } from "./entra";
import { skipsWrap, wrapBatch } from "./planWrap";
import { isRetryableError, withReconnect } from "./retry";
import { DEFAULT_ROW_CAP, RowCollector } from "./rowcap";
import { serializeRow, serializeValue } from "./serialize";
import { quoteIdent, qualified } from "./tableEdit";
import type {
  ColumnInfo,
  CommandResult,
  ConnectionConfig,
  ConnectionStatus,
  DatabaseAdapter,
  DbCommand,
  DbObject,
  DbObjectType,
  EngineCapabilities,
  ExecuteOptions,
  QueryChunk,
  QueryExecution,
  RelationsForeignKey,
  RelationsGraph,
  RelationsTable,
  RoutineParameter,
  ScriptTableColumn,
  TableCheckConstraint,
  TableColumn,
  TableDefaultConstraint,
  TableDetails,
  TableFilter,
  TableForeignKey,
  TableIndex,
  TablePage,
  TableSort,
  TableTrigger,
  TestResult,
} from "./types";

/** SQL Server names the extra result set SET STATISTICS XML ON emits with this exact literal —
 *  stable across every server version and Azure SQL. Single column, one nvarchar(max) XML row. */
const SHOWPLAN_COLUMN = "Microsoft SQL Server 2005 XML Showplan";

// Traces: BASED-INDEX-INTROSPECT — the index catalog query and its row assembler, shared by
// getTableDetails (as one recordset of its multi-set batch) and the standalone getIndexes. One
// query, two callers: they must never drift.
const INDEX_SELECT = `
        SELECT i.index_id, i.name, i.type_desc, i.is_unique, i.is_primary_key, i.is_unique_constraint,
               i.filter_definition, ic.key_ordinal, ic.is_descending_key, ic.is_included_column,
               col.name AS column_name
        FROM sys.indexes i
        JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
        JOIN sys.columns col ON col.object_id = ic.object_id AND col.column_id = ic.column_id
        WHERE i.object_id = @oid AND i.type > 0
        ORDER BY i.index_id, ic.is_included_column, ic.key_ordinal, ic.index_column_id`;

/** Fold the per-column index rows into one TableIndex each, preserving key/INCLUDE order. */
function assembleIndexes(rows: Array<Record<string, unknown>>): TableIndex[] {
  const indexes: TableIndex[] = [];
  const byId = new Map<number, TableIndex>();
  for (const row of rows) {
    const id = Number(row.index_id);
    let idx = byId.get(id);
    if (!idx) {
      idx = {
        name: String(row.name),
        typeDesc: String(row.type_desc),
        isUnique: !!row.is_unique,
        isPrimaryKey: !!row.is_primary_key,
        isUniqueConstraint: !!row.is_unique_constraint,
        filterDefinition: row.filter_definition != null ? String(row.filter_definition) : null,
        keyColumns: [],
        includedColumns: [],
      };
      byId.set(id, idx);
      indexes.push(idx);
    }
    if (row.is_included_column) idx.includedColumns.push(String(row.column_name));
    else idx.keyColumns.push({ name: String(row.column_name), descending: !!row.is_descending_key });
  }
  return indexes;
}

const TOKEN_REFRESH_AGE_MS = 45 * 60_000;
const IDLE_PING_AGE_MS = 15 * 60_000;

function errMessage(err: unknown): string {
  if (!err) return "Unknown error";
  const e = err as { message?: string; originalError?: { message?: string } };
  const outer = e.message ?? String(err);
  const inner = e.originalError?.message;
  return inner && !outer.includes(inner) ? `${outer} — ${inner}` : outer;
}

function typeName(col: unknown): string {
  const t = (col as { type?: { declaration?: { type?: string }; name?: string } | string })?.type;
  if (typeof t === "string") return t.toLowerCase();
  return String(t?.declaration?.type ?? t?.name ?? "").toLowerCase();
}

function parseServer(server: string): { host: string; port: number } {
  const [host, port] = server.split(",").map((s) => s.trim());
  return { host: host ?? server, port: port ? Number(port) : 1433 };
}

export class MssqlAdapter implements DatabaseAdapter {
  readonly capabilities: EngineCapabilities = {
    sql: true,
    search: false,
    write: true,
    orderedBrowse: true,
    script: true,
    relations: true,
    // Traces: BASED-AGENT-SURFACE-VARIANT — SQL Server has exactly one shape, and its filtering is
    // the structured/parameterized kind: a free-text engine predicate would be an injection seam.
    engine: "mssql",
    variant: "mssql",
    containers: null,
    wherePredicate: false,
    structuredFilters: true,
    countRows: true,
    takeByKey: false,
    indexIntrospect: true,
  };
  readonly dialect: SqlDialect = TSQL_DIALECT;
  readonly database: string;
  private pool: sql.ConnectionPool | null = null;
  private credential: TokenCredential | null = null;
  private tokenMintedAt = 0;
  private lastActivity = 0;
  private statusCb: ((status: ConnectionStatus, detail?: string) => void) | null = null;
  private reconnectingInBackground = false;
  private readonly rowCap: number;

  constructor(
    private readonly cfg: ConnectionConfig,
    private readonly getSecret: SecretProvider,
    opts?: { database?: string; rowCap?: number },
  ) {
    this.database = opts?.database ?? cfg.database;
    this.rowCap = opts?.rowCap ?? DEFAULT_ROW_CAP;
  }

  onStatus(cb: (status: ConnectionStatus, detail?: string) => void): void {
    this.statusCb = cb;
  }

  private emitStatus(status: ConnectionStatus, detail?: string): void {
    this.statusCb?.(status, detail);
  }

  private async buildPool(): Promise<sql.ConnectionPool> {
    const { host, port } = parseServer(settingStr(this.cfg, "server") ?? "");
    const config: sql.config = {
      server: host,
      port,
      database: this.database,
      connectionTimeout: 20_000,
      requestTimeout: 600_000,
      pool: { max: 4, min: 0, idleTimeoutMillis: 60_000 },
      options: {
        encrypt: settingBool(this.cfg, "encrypt", true),
        trustServerCertificate: settingBool(this.cfg, "trustServerCertificate", false),
        enableArithAbort: true,
        useUTC: false,
      },
    };
    if (this.cfg.authType === "sql-login") {
      const password = this.getSecret(this.cfg.id);
      const username = settingStr(this.cfg, "username");
      if (!username || password == null) throw new Error("SQL login requires a username and stored password");
      config.user = username;
      config.password = password;
    } else {
      this.credential ??= createCredential(this.cfg, this.getSecret);
      const token = await mintSqlToken(this.credential!);
      this.tokenMintedAt = Date.now();
      (config as unknown as Record<string, unknown>).authentication = {
        type: "azure-active-directory-access-token",
        options: { token },
      };
    }
    const pool = new sql.ConnectionPool(config);
    pool.on("error", () => {
      // Pool-level socket errors while idle (no operation in flight to trigger withPool's retry
      // path): proactively rebuild in the background so the connection is already healthy by the
      // time the user's next action runs, instead of only reacting to it.
      this.emitStatus("reconnecting", "connection lost");
      void this.backgroundReconnect();
    });
    await pool.connect();
    return pool;
  }

  private async rebuild(): Promise<void> {
    const old = this.pool;
    this.pool = null;
    if (old) await old.close().catch(() => {});
    this.pool = await this.buildPool();
  }

  /** Bounded-backoff reconnect for an idle drop (no caller waiting on it). Skipped if a reconnect
   *  is already underway — the pool's next "error" firing (or a caller's own withPool retry) would
   *  otherwise stack overlapping rebuild loops. Reuses withReconnect's backoff by treating
   *  rebuild() itself as the retried operation. */
  private async backgroundReconnect(): Promise<void> {
    if (this.reconnectingInBackground) return;
    this.reconnectingInBackground = true;
    try {
      await withReconnect({
        attempt: () => this.rebuild(),
        rebuild: async () => {},
        onReconnecting: () => this.emitStatus("reconnecting", "connection lost"),
        isRetryable: () => true,
      });
      this.emitStatus("connected");
    } catch {
      this.pool = null;
      this.emitStatus("disconnected", "unable to reconnect");
    } finally {
      this.reconnectingInBackground = false;
    }
  }

  private async ensurePool(): Promise<sql.ConnectionPool> {
    if (this.pool && this.cfg.authType !== "sql-login" && Date.now() - this.tokenMintedAt > TOKEN_REFRESH_AGE_MS) {
      // Proactive refresh: pooled configs hold a fixed token; new pool connections would fail once it expires.
      this.emitStatus("reconnecting", "refreshing access token");
      await this.rebuild();
      this.emitStatus("connected");
    }
    if (!this.pool) this.pool = await this.buildPool();
    return this.pool;
  }

  private async withPool<T>(op: (pool: sql.ConnectionPool) => Promise<T>): Promise<T> {
    const result = await withReconnect({
      attempt: async () => op(await this.ensurePool()),
      rebuild: async () => {
        await this.rebuild();
        this.emitStatus("connected");
      },
      onReconnecting: () => this.emitStatus("reconnecting"),
    });
    this.lastActivity = Date.now();
    return result;
  }

  async connect(): Promise<void> {
    this.emitStatus("connecting");
    await this.ensurePool();
    this.lastActivity = Date.now();
    this.emitStatus("connected");
  }

  async disconnect(): Promise<void> {
    const pool = this.pool;
    this.pool = null;
    if (pool) await pool.close().catch(() => {});
    this.emitStatus("disconnected");
  }

  // Traces: BASED-CONN-TEST — connect, verify with a trivial query, report server version + identity.
  async probe(): Promise<TestResult> {
    try {
      await this.connect();
      let serverVersion: string | undefined;
      let identity: string | undefined;
      const exec = this.execute("SELECT @@VERSION AS v, SUSER_SNAME() AS who", (chunk) => {
        if (chunk.type === "rows" && chunk.rows[0]) {
          serverVersion = String(chunk.rows[0][0] ?? "").split("\n")[0];
          identity = String(chunk.rows[0][1] ?? "");
        }
      });
      const { status } = await exec.completion;
      if (status !== "ok") return { ok: false, error: "Connected but test query failed" };
      return { ok: true, serverVersion, identity };
    } catch (err) {
      return { ok: false, error: errMessage(err) };
    } finally {
      await this.disconnect().catch(() => {});
    }
  }

  async listDatabases(): Promise<string[]> {
    try {
      return await this.withPool(async (pool) => {
        const r = await pool.request().query<{ name: string }>("SELECT name FROM sys.databases WHERE state = 0 ORDER BY name");
        return r.recordset.map((row) => row.name);
      });
    } catch {
      return [this.database];
    }
  }

  async listSchemas(): Promise<string[]> {
    return this.withPool(async (pool) => {
      const r = await pool.request().query<{ name: string }>(
        "SELECT name FROM sys.schemas WHERE schema_id < 16384 AND name NOT IN ('sys','INFORMATION_SCHEMA','guest') ORDER BY name",
      );
      return r.recordset.map((row) => row.name);
    });
  }

  async listObjects(): Promise<DbObject[]> {
    return this.withPool(async (pool) => {
      const r = await pool.request().query<{ schemaName: string; objectName: string; objType: DbObjectType }>(`
        SELECT s.name AS schemaName, o.name AS objectName,
               CASE o.type WHEN 'U' THEN 'table' WHEN 'V' THEN 'view' WHEN 'P' THEN 'procedure' ELSE 'function' END AS objType
        FROM sys.objects o
        JOIN sys.schemas s ON s.schema_id = o.schema_id
        WHERE o.type IN ('U','V','P','FN','IF','TF') AND o.is_ms_shipped = 0
        ORDER BY s.name, o.name`);
      return r.recordset.map((row) => ({ schema: row.schemaName, name: row.objectName, type: row.objType }));
    });
  }

  async getTableColumns(schema: string, table: string): Promise<TableColumn[]> {
    return this.withPool(async (pool) => {
      const request = pool.request();
      request.input("schema", sql.NVarChar, schema);
      request.input("table", sql.NVarChar, table);
      const r = await request.query(`
        SELECT c.name, t.name AS typeName, c.max_length, c.precision, c.scale, c.is_nullable,
               CAST(CASE WHEN pk.column_id IS NOT NULL THEN 1 ELSE 0 END AS bit) AS is_pk,
               fk.target AS fk_target
        FROM sys.columns c
        JOIN sys.types t ON t.user_type_id = c.user_type_id
        JOIN sys.objects o ON o.object_id = c.object_id
        JOIN sys.schemas s ON s.schema_id = o.schema_id
        LEFT JOIN (
          SELECT ic.object_id, ic.column_id
          FROM sys.index_columns ic
          JOIN sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id AND i.is_primary_key = 1
        ) pk ON pk.object_id = c.object_id AND pk.column_id = c.column_id
        LEFT JOIN (
          SELECT fkc.parent_object_id AS object_id, fkc.parent_column_id AS column_id,
                 MIN(ts.name + '.' + tt.name + '(' + tc.name + ')') AS target
          FROM sys.foreign_key_columns fkc
          JOIN sys.objects tt ON tt.object_id = fkc.referenced_object_id
          JOIN sys.schemas ts ON ts.schema_id = tt.schema_id
          JOIN sys.columns tc ON tc.object_id = fkc.referenced_object_id AND tc.column_id = fkc.referenced_column_id
          GROUP BY fkc.parent_object_id, fkc.parent_column_id
        ) fk ON fk.object_id = c.object_id AND fk.column_id = c.column_id
        WHERE s.name = @schema AND o.name = @table
        ORDER BY c.column_id`);
      return r.recordset.map((row: Record<string, unknown>) => {
        const typeNm = String(row.typeName);
        let maxLength = row.max_length as number | null;
        // nchar/nvarchar report bytes; normalize to characters (-1 stays -1 = MAX)
        if (maxLength != null && maxLength > 0 && /^n(var)?char$/i.test(typeNm)) maxLength = maxLength / 2;
        return {
          name: String(row.name),
          type: typeNm,
          maxLength,
          precision: (row.precision as number) ?? null,
          scale: (row.scale as number) ?? null,
          nullable: Boolean(row.is_nullable),
          isPrimaryKey: Boolean(row.is_pk),
          isForeignKey: row.fk_target != null,
          fkTarget: (row.fk_target as string) ?? null,
        };
      });
    });
  }

  // Traces: BASED-VIEW-DEFINITION — CREATE VIEW/PROCEDURE/FUNCTION body for the Details panel.
  async getObjectDefinition(schema: string, name: string): Promise<string | null> {
    return this.withPool(async (pool) => {
      const request = pool.request();
      request.input("schema", sql.NVarChar, schema);
      request.input("name", sql.NVarChar, name);
      const r = await request.query<{ definition: string | null }>(`
        SELECT m.definition
        FROM sys.sql_modules m
        JOIN sys.objects o ON o.object_id = m.object_id
        JOIN sys.schemas s ON s.schema_id = o.schema_id
        WHERE s.name = @schema AND o.name = @name`);
      return r.recordset[0]?.definition ?? null;
    });
  }

  // Traces: BASED-ROUTINE-DETAILS — stored procedure / function parameter list, in declaration order.
  async getRoutineParameters(schema: string, name: string): Promise<RoutineParameter[]> {
    return this.withPool(async (pool) => {
      const request = pool.request();
      request.input("schema", sql.NVarChar, schema);
      request.input("name", sql.NVarChar, name);
      const r = await request.query(`
        SELECT p.name, t.name AS typeName, p.is_output, p.parameter_id
        FROM sys.parameters p
        JOIN sys.types t ON t.user_type_id = p.user_type_id
        JOIN sys.objects o ON o.object_id = p.object_id
        JOIN sys.schemas s ON s.schema_id = o.schema_id
        WHERE s.name = @schema AND o.name = @name AND p.parameter_id > 0
        ORDER BY p.parameter_id`);
      return r.recordset.map((row: Record<string, unknown>) => ({
        name: String(row.name),
        type: String(row.typeName),
        mode: row.is_output ? ("out" as const) : ("in" as const),
        ordinal: Number(row.parameter_id),
      }));
    });
  }

  /** Build the parameterized WHERE clause for a structured filter list (BASED-TABLE-ORDERBY), or ""
   *  when there are none. Column names are membership-validated by `requireCol` and then quoted;
   *  values ride as typed parameters and are never interpolated. Shared by readTablePage and
   *  countRows so the two can never disagree about what a filter means. */
  private static buildWhere(
    request: sql.Request,
    filters: TableFilter[] | undefined,
    requireCol: (name: string) => TableColumn,
  ): string {
    const parts: string[] = [];
    (filters ?? []).forEach((f, i) => {
      const ident = quoteIdent(requireCol(f.column).name);
      if (f.op === "is-null") return void parts.push(`${ident} IS NULL`);
      if (f.op === "not-null") return void parts.push(`${ident} IS NOT NULL`);
      const OPS: Record<string, string> = { eq: "=", ne: "<>", gt: ">", ge: ">=", lt: "<", le: "<=", like: "LIKE" };
      const op = OPS[f.op];
      if (!op) throw new Error(`Unknown filter op "${f.op}"`);
      const pname = `f${i}`;
      if (typeof f.value === "number") request.input(pname, f.value);
      else request.input(pname, sql.NVarChar, f.value ?? "");
      parts.push(`${ident} ${op} @${pname}`);
    });
    return parts.length > 0 ? ` WHERE ${parts.join(" AND ")}` : "";
  }

  // Traces: BASED-LANCE-SCAN — an exact count, optionally narrowed by the same structured filters
  // readTablePage accepts. COUNT_BIG because a large fact table overflows int.
  async countRows(schema: string, table: string, opts?: { filters?: TableFilter[] }): Promise<number> {
    const columns = await this.getTableColumns(schema, table);
    if (columns.length === 0) throw new Error(`No columns for ${schema}.${table}`);
    const byName = new Map(columns.map((c) => [c.name, c]));
    const requireCol = (name: string): TableColumn => {
      const col = byName.get(name);
      if (!col) throw new Error(`Unknown column "${name}" on ${schema}.${table}`);
      return col;
    };
    return this.withPool(async (pool) => {
      const request = pool.request();
      const where = MssqlAdapter.buildWhere(request, opts?.filters, requireCol);
      const r = await request.query<{ n: number | bigint }>(
        `SELECT COUNT_BIG(*) AS n FROM ${qualified(schema, table)}${where}`,
      );
      return Number(r.recordset[0]?.n ?? 0);
    });
  }

  // Traces: BASED-INDEX-INTROSPECT — the same catalog query getTableDetails runs, standalone, so
  // the Details index panel and the agent's get_indexes work on views/engines that never call for
  // full table details.
  async getIndexes(schema: string, name: string): Promise<TableIndex[]> {
    return this.withPool(async (pool) => {
      const request = pool.request();
      request.input("schema", sql.NVarChar, schema);
      request.input("table", sql.NVarChar, name);
      const r = await request.query<Record<string, unknown>>(`
        DECLARE @oid int = OBJECT_ID(QUOTENAME(@schema) + N'.' + QUOTENAME(@table));
        ${INDEX_SELECT}`);
      return assembleIndexes(r.recordset ?? []);
    });
  }

  // Traces: BASED-TABLE-BROWSE, BASED-TABLE-ORDERBY — one page ordered by a stable key (user sort
  // first when given, stable key appended as tiebreak), optional parameterized filters, capped by
  // the row cap. Every referenced column is membership-validated against the real column list
  // before quoting; filter values ride as typed parameters, never interpolated.
  async readTablePage(
    schema: string,
    table: string,
    opts: { offset: number; limit: number; orderBy?: TableSort[]; filters?: TableFilter[] },
  ): Promise<TablePage> {
    const columns = await this.getTableColumns(schema, table);
    if (columns.length === 0) throw new Error(`No columns for ${schema}.${table}`);
    const byName = new Map(columns.map((c) => [c.name, c]));
    const requireCol = (name: string): TableColumn => {
      const col = byName.get(name);
      if (!col) throw new Error(`Unknown column "${name}" on ${schema}.${table}`);
      return col;
    };

    const pk = columns.filter((c) => c.isPrimaryKey);
    const stableCols = (pk.length > 0 ? pk : [columns[0]!]).map((c) => c.name);
    const userSort = (opts.orderBy ?? []).map((s) => ({ name: requireCol(s.column).name, dir: s.dir === "desc" ? "DESC" : "ASC" }));
    // User sort first, then the stable key columns not already present → deterministic paging.
    const orderParts = [
      ...userSort.map((s) => `${quoteIdent(s.name)} ${s.dir}`),
      ...stableCols.filter((c) => !userSort.some((s) => s.name === c)).map((c) => quoteIdent(c)),
    ];

    const limit = Math.min(Math.max(1, Math.floor(opts.limit)), this.rowCap);
    const offset = Math.max(0, Math.floor(opts.offset));
    return this.withPool(async (pool) => {
      const request = pool.request();
      request.input("off", sql.Int, offset);
      request.input("lim", sql.Int, limit);

      const where = MssqlAdapter.buildWhere(request, opts.filters, requireCol);
      const r = await request.query<Record<string, unknown>>(
        `SELECT * FROM ${qualified(schema, table)}${where} ORDER BY ${orderParts.join(", ")} OFFSET @off ROWS FETCH NEXT @lim ROWS ONLY`,
      );
      const rows = r.recordset.map((row) => columns.map((c) => serializeValue(row[c.name])));
      return { columns, rows, orderBy: stableCols };
    });
  }

  // Traces: BASED-TABLE-DETAILS — one parameterized multi-recordset batch over the sys.* catalogs:
  // columns (identity/computed/collation), indexes (keys/INCLUDE/filter), FKs (per-column pairs +
  // actions), check/default constraints, triggers. Feeds the scripter and the enriched Details view.
  async getTableDetails(schema: string, name: string): Promise<TableDetails> {
    const base = await this.getTableColumns(schema, name);
    if (base.length === 0) throw new Error(`No columns for ${schema}.${name}`);
    return this.withPool(async (pool) => {
      const request = pool.request();
      request.input("schema", sql.NVarChar, schema);
      request.input("table", sql.NVarChar, name);
      const r = await request.query<Record<string, unknown>>(`
        DECLARE @oid int = OBJECT_ID(QUOTENAME(@schema) + N'.' + QUOTENAME(@table));

        -- rs0: column extensions (identity / computed / collation), keyed by name
        SELECT c.name, c.collation_name,
               c.is_identity,
               CAST(ic.seed_value AS bigint) AS seed, CAST(ic.increment_value AS bigint) AS increment,
               cc.definition AS computed_definition, cc.is_persisted
        FROM sys.columns c
        LEFT JOIN sys.identity_columns ic ON ic.object_id = c.object_id AND ic.column_id = c.column_id
        LEFT JOIN sys.computed_columns cc ON cc.object_id = c.object_id AND cc.column_id = c.column_id
        WHERE c.object_id = @oid
        ORDER BY c.column_id;

        -- rs1: indexes + key/included columns (covers PK + unique constraints too)
        ${INDEX_SELECT};

        -- rs2: foreign keys with per-column pairs + referential actions
        SELECT fk.name, fk.delete_referential_action_desc AS on_delete, fk.update_referential_action_desc AS on_update,
               fk.is_disabled, pc.name AS parent_column, rs.name AS ref_schema, rt.name AS ref_table,
               rc.name AS ref_column, fkc.constraint_column_id
        FROM sys.foreign_keys fk
        JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
        JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
        JOIN sys.objects rt ON rt.object_id = fk.referenced_object_id
        JOIN sys.schemas rs ON rs.schema_id = rt.schema_id
        JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
        WHERE fk.parent_object_id = @oid
        ORDER BY fk.name, fkc.constraint_column_id;

        -- rs3: check constraints (column-scoped or table-level)
        SELECT ck.name, ck.definition, ck.is_disabled, col.name AS column_name
        FROM sys.check_constraints ck
        LEFT JOIN sys.columns col ON col.object_id = ck.parent_object_id AND col.column_id = ck.parent_column_id
        WHERE ck.parent_object_id = @oid;

        -- rs4: default constraints
        SELECT dc.name, dc.definition, col.name AS column_name
        FROM sys.default_constraints dc
        JOIN sys.columns col ON col.object_id = dc.parent_object_id AND col.column_id = dc.parent_column_id
        WHERE dc.parent_object_id = @oid;

        -- rs5: triggers + events
        SELECT tr.name, tr.is_disabled, tr.is_instead_of_trigger, te.type_desc AS event
        FROM sys.triggers tr
        JOIN sys.trigger_events te ON te.object_id = tr.object_id
        WHERE tr.parent_id = @oid;
      `);
      const sets = r.recordsets as unknown as Array<Array<Record<string, unknown>>>;
      const [rsCols, rsIdx, rsFk, rsCk, rsDf, rsTr] = [
        sets[0] ?? [],
        sets[1] ?? [],
        sets[2] ?? [],
        sets[3] ?? [],
        sets[4] ?? [],
        sets[5] ?? [],
      ];

      const extByName = new Map(rsCols.map((row) => [String(row.name), row]));
      const columns: ScriptTableColumn[] = base.map((c) => {
        const ext = extByName.get(c.name);
        return {
          ...c,
          collation: ext?.collation_name != null ? String(ext.collation_name) : null,
          isIdentity: !!ext?.is_identity,
          identitySeed: ext?.seed != null ? Number(ext.seed) : null,
          identityIncrement: ext?.increment != null ? Number(ext.increment) : null,
          computedDefinition: ext?.computed_definition != null ? String(ext.computed_definition) : null,
          computedPersisted: !!ext?.is_persisted,
        };
      });

      const indexes = assembleIndexes(rsIdx);

      const fks: TableForeignKey[] = [];
      const fkByName = new Map<string, TableForeignKey>();
      for (const row of rsFk) {
        const fkName = String(row.name);
        let fk = fkByName.get(fkName);
        if (!fk) {
          fk = {
            name: fkName,
            columns: [],
            refSchema: String(row.ref_schema),
            refTable: String(row.ref_table),
            refColumns: [],
            onDelete: String(row.on_delete),
            onUpdate: String(row.on_update),
            isDisabled: !!row.is_disabled,
          };
          fkByName.set(fkName, fk);
          fks.push(fk);
        }
        fk.columns.push(String(row.parent_column));
        fk.refColumns.push(String(row.ref_column));
      }

      const checkConstraints: TableCheckConstraint[] = rsCk.map((row) => ({
        name: String(row.name),
        definition: String(row.definition),
        column: row.column_name != null ? String(row.column_name) : null,
        isDisabled: !!row.is_disabled,
      }));
      const defaultConstraints: TableDefaultConstraint[] = rsDf.map((row) => ({
        name: String(row.name),
        column: String(row.column_name),
        definition: String(row.definition),
      }));

      const triggers: TableTrigger[] = [];
      const trByName = new Map<string, TableTrigger>();
      for (const row of rsTr) {
        const trName = String(row.name);
        let tr = trByName.get(trName);
        if (!tr) {
          tr = { name: trName, isInsteadOf: !!row.is_instead_of_trigger, isDisabled: !!row.is_disabled, events: [] };
          trByName.set(trName, tr);
          triggers.push(tr);
        }
        tr.events.push(String(row.event));
      }

      return { schema, name, columns, indexes, foreignKeys: fks, checkConstraints, defaultConstraints, triggers };
    });
  }

  // Traces: BASED-LSP-MSSQL-NATIVE — one bulk column query across all user tables/views for the
  // in-house language server's catalog (structural seam: not on DatabaseAdapter, the LSP layer
  // casts to it like the Lance requireSqlBridge seam).
  async listAllColumns(): Promise<Array<{ schema: string; table: string; column: string; type: string; isPrimaryKey: boolean }>> {
    return this.withPool(async (pool) => {
      const r = await pool.request().query<Record<string, unknown>>(`
        SELECT s.name AS schemaName, o.name AS tableName, c.name AS colName, t.name AS typeName,
               CAST(CASE WHEN pk.column_id IS NOT NULL THEN 1 ELSE 0 END AS bit) AS is_pk
        FROM sys.objects o
        JOIN sys.schemas s ON s.schema_id = o.schema_id
        JOIN sys.columns c ON c.object_id = o.object_id
        JOIN sys.types t ON t.user_type_id = c.user_type_id
        LEFT JOIN (
          SELECT ic.object_id, ic.column_id
          FROM sys.index_columns ic
          JOIN sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id AND i.is_primary_key = 1
        ) pk ON pk.object_id = c.object_id AND pk.column_id = c.column_id
        WHERE o.type IN ('U', 'V') AND o.is_ms_shipped = 0
        ORDER BY s.name, o.name, c.column_id
      `);
      return r.recordset.map((row) => ({
        schema: String(row.schemaName),
        table: String(row.tableName),
        column: String(row.colName),
        type: String(row.typeName),
        isPrimaryKey: !!row.is_pk,
      }));
    });
  }

  // Traces: BASED-RELATIONS — all user tables + columns + FK edges in one two-recordset batch
  // (no N+1). A schema scope filters the table list but keeps edges touching the scope, so
  // cross-schema references still render.
  async getRelations(schemaFilter?: string): Promise<RelationsGraph> {
    return this.withPool(async (pool) => {
      const request = pool.request();
      request.input("schema", sql.NVarChar, schemaFilter ?? null);
      const r = await request.query<Record<string, unknown>>(`
        -- rs0: user tables + columns in scope
        SELECT s.name AS schemaName, o.name AS tableName, c.name AS colName, t.name AS typeName,
               c.is_nullable, c.column_id,
               CAST(CASE WHEN pk.column_id IS NOT NULL THEN 1 ELSE 0 END AS bit) AS is_pk,
               CAST(CASE WHEN fkc.parent_column_id IS NOT NULL THEN 1 ELSE 0 END AS bit) AS is_fk
        FROM sys.tables o
        JOIN sys.schemas s ON s.schema_id = o.schema_id
        JOIN sys.columns c ON c.object_id = o.object_id
        JOIN sys.types t ON t.user_type_id = c.user_type_id
        LEFT JOIN (
          SELECT ic.object_id, ic.column_id
          FROM sys.index_columns ic
          JOIN sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id AND i.is_primary_key = 1
        ) pk ON pk.object_id = c.object_id AND pk.column_id = c.column_id
        LEFT JOIN (
          SELECT DISTINCT parent_object_id, parent_column_id
          FROM sys.foreign_key_columns
        ) fkc ON fkc.parent_object_id = c.object_id AND fkc.parent_column_id = c.column_id
        WHERE o.is_ms_shipped = 0 AND (@schema IS NULL OR s.name = @schema)
        ORDER BY s.name, o.name, c.column_id;

        -- rs1: FK edges; scope keeps any edge touching the scope
        SELECT fk.name, ps.name AS parent_schema, pt.name AS parent_table, pc.name AS parent_col,
               rs.name AS ref_schema, rt.name AS ref_table, rc.name AS ref_col, fkc.constraint_column_id
        FROM sys.foreign_keys fk
        JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
        JOIN sys.tables pt ON pt.object_id = fk.parent_object_id
        JOIN sys.schemas ps ON ps.schema_id = pt.schema_id
        JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
        JOIN sys.tables rt ON rt.object_id = fk.referenced_object_id
        JOIN sys.schemas rs ON rs.schema_id = rt.schema_id
        JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
        WHERE pt.is_ms_shipped = 0 AND (@schema IS NULL OR ps.name = @schema OR rs.name = @schema)
        ORDER BY fk.name, fkc.constraint_column_id;
      `);
      const sets = r.recordsets as unknown as Array<Array<Record<string, unknown>>>;
      const [rsTables, rsFks] = [sets[0] ?? [], sets[1] ?? []];

      const tables: RelationsTable[] = [];
      const tableByKey = new Map<string, RelationsTable>();
      for (const row of rsTables) {
        const key = `${String(row.schemaName)}.${String(row.tableName)}`;
        let table = tableByKey.get(key);
        if (!table) {
          table = { schema: String(row.schemaName), name: String(row.tableName), columns: [] };
          tableByKey.set(key, table);
          tables.push(table);
        }
        table.columns.push({
          name: String(row.colName),
          type: String(row.typeName),
          isPrimaryKey: !!row.is_pk,
          isForeignKey: !!row.is_fk,
          nullable: !!row.is_nullable,
        });
      }

      const foreignKeys: RelationsForeignKey[] = [];
      const fkByKey = new Map<string, RelationsForeignKey>();
      for (const row of rsFks) {
        const key = `${String(row.parent_schema)}.${String(row.parent_table)}.${String(row.name)}`;
        let fk = fkByKey.get(key);
        if (!fk) {
          fk = {
            name: String(row.name),
            schema: String(row.parent_schema),
            table: String(row.parent_table),
            columns: [],
            refSchema: String(row.ref_schema),
            refTable: String(row.ref_table),
            refColumns: [],
          };
          fkByKey.set(key, fk);
          foreignKeys.push(fk);
        }
        fk.columns.push(String(row.parent_col));
        fk.refColumns.push(String(row.ref_col));
      }

      return { tables, foreignKeys };
    });
  }

  // Traces: BASED-TABLE-COMMIT — all-or-nothing transactional writes; typed params, no interpolation.
  async runCommands(commands: DbCommand[]): Promise<CommandResult> {
    return this.withPool(async (pool) => {
      const tx = new sql.Transaction(pool);
      // A begin() failure is likely a dead pool → let it throw so withPool retries once against a fresh tx.
      await tx.begin();
      const rowsAffected: number[] = [];
      try {
        for (const cmd of commands) {
          const request = new sql.Request(tx);
          for (const p of cmd.params ?? []) {
            if (p.value !== null && typeof p.value === "object") {
              throw new Error(`Cannot bind binary/complex value for parameter @${p.name}`);
            }
            // NULL needs an explicit type (implicit-converts to any target column); otherwise infer from the JS value.
            if (p.value === null) request.input(p.name, sql.NVarChar, null);
            else request.input(p.name, p.value);
          }
          const r = await request.query(cmd.sql);
          rowsAffected.push(...(r.rowsAffected ?? []));
        }
        await tx.commit();
        return { rowsAffected, error: null };
      } catch (err) {
        try {
          await tx.rollback();
        } catch {
          // rollback may fail if the batch already aborted the transaction; the original error is what matters
        }
        return { rowsAffected: [], error: errMessage(err) };
      }
    });
  }

  execute(sqlText: string, onChunk: (chunk: QueryChunk) => void, opts: ExecuteOptions = {}): QueryExecution {
    const batches = splitBatches(sqlText);
    let cancelled = false;
    let errored = false;
    let currentRequest: sql.Request | null = null;
    const start = performance.now();

    const completion = (async () => {
      try {
        const pool = await this.withPool(async (p) => {
          if (Date.now() - this.lastActivity > IDLE_PING_AGE_MS) await p.request().query("SELECT 1");
          return p;
        });
        for (const batch of batches) {
          if (cancelled) break;
          const res = await this.runBatchStream(pool, batch, onChunk, (req) => (currentRequest = req), opts);
          if (res.errored) errored = true;
          if (res.cancelled) cancelled = true;
        }
      } catch (err) {
        errored = true;
        onChunk({ type: "error", message: errMessage(err) });
      }
      this.lastActivity = Date.now();
      const durationMs = Math.round(performance.now() - start);
      const status = cancelled ? "cancelled" : errored ? "error" : "ok";
      if (cancelled) onChunk({ type: "cancelled" });
      onChunk({ type: "done", durationMs, status });
      return { status, durationMs } as const;
    })();

    return {
      cancel: () => {
        cancelled = true;
        try {
          currentRequest?.cancel();
        } catch {
          // request may already be complete
        }
      },
      completion,
    };
  }

  private runBatchStream(
    pool: sql.ConnectionPool,
    batchSql: string,
    onChunk: (chunk: QueryChunk) => void,
    setRequest: (req: sql.Request) => void,
    opts: ExecuteOptions,
  ): Promise<{ errored: boolean; cancelled: boolean }> {
    return new Promise((resolve) => {
      const request = new sql.Request(pool);
      request.stream = true;
      (request as unknown as Record<string, unknown>).arrayRowMode = true;
      setRequest(request);
      let collector: RowCollector | null = null;
      let planRows: string[] | null = null; // non-null while the current recordset is a showplan resultset
      let errored = false;
      let wasCancelled = false;

      const endResultSet = () => {
        if (planRows) {
          onChunk({ type: "plan", format: "showplan-xml", xml: planRows.join("") });
          planRows = null;
          return;
        }
        if (!collector) return;
        const { rowCount, truncated } = collector.finish();
        onChunk({ type: "resultsetEnd", rowCount, truncated });
        collector = null;
      };

      request.on("recordset", (cols: unknown) => {
        endResultSet();
        const arr = (Array.isArray(cols) ? cols : Object.values(cols as object)) as Array<{ name?: string }>;
        if (arr.length === 1 && arr[0]?.name === SHOWPLAN_COLUMN) {
          planRows = [];
          return; // swallowed — never shown as a "Results N" grid tab
        }
        const columns: ColumnInfo[] = arr.map((c, i) => ({ name: c.name || `(col ${i + 1})`, type: typeName(c) }));
        onChunk({ type: "resultset", columns });
        collector = new RowCollector((rows) => onChunk({ type: "rows", rows }), opts.rowCap ?? this.rowCap);
      });
      request.on("row", (row: unknown) => {
        const values = Array.isArray(row) ? row : Object.values(row as object);
        if (planRows) {
          planRows.push(String(values[0] ?? ""));
          return;
        }
        collector?.push(serializeRow(values));
      });
      request.on("rowsaffected", (n: number) => {
        onChunk({ type: "message", text: `(${n} row${n === 1 ? "" : "s"} affected)` });
      });
      request.on("info", (msg: { message: string }) => {
        onChunk({ type: "message", text: msg.message });
      });
      request.on("error", (err: unknown) => {
        const e = err as { code?: string; number?: number; lineNumber?: number };
        if (e?.code === "ECANCEL") {
          wasCancelled = true;
          return;
        }
        errored = true;
        onChunk({ type: "error", message: errMessage(err), line: e?.lineNumber, code: e?.number });
      });
      request.on("done", () => {
        endResultSet();
        resolve({ errored, cancelled: wasCancelled });
      });

      if ((opts.capturePlan || opts.captureStats) && skipsWrap(batchSql)) {
        onChunk({ type: "message", text: "Plan/stats capture skipped for this batch (CREATE must be the first statement)." });
      }
      const maybePromise = request.batch(wrapBatch(batchSql, opts)) as unknown as Promise<unknown> | undefined;
      if (maybePromise && typeof maybePromise.catch === "function") maybePromise.catch(() => {});
    });
  }
}

