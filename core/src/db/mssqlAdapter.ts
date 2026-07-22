import sql from "mssql";
import type { TokenCredential } from "@azure/identity";
import { splitBatches } from "./batch";
import { createCredential, mintSqlToken, type SecretProvider } from "./entra";
import { isRetryableError, withReconnect } from "./retry";
import { DEFAULT_ROW_CAP, RowCollector } from "./rowcap";
import { serializeRow } from "./serialize";
import type {
  ColumnInfo,
  ConnectionConfig,
  ConnectionStatus,
  DatabaseAdapter,
  DbObject,
  DbObjectType,
  QueryChunk,
  QueryExecution,
  TableColumn,
  TestResult,
} from "./types";

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
  readonly database: string;
  private pool: sql.ConnectionPool | null = null;
  private credential: TokenCredential | null = null;
  private tokenMintedAt = 0;
  private lastActivity = 0;
  private statusCb: ((status: ConnectionStatus, detail?: string) => void) | null = null;
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
    const { host, port } = parseServer(this.cfg.server);
    const config: sql.config = {
      server: host,
      port,
      database: this.database,
      connectionTimeout: 20_000,
      requestTimeout: 600_000,
      pool: { max: 4, min: 0, idleTimeoutMillis: 60_000 },
      options: {
        encrypt: this.cfg.encrypt,
        trustServerCertificate: this.cfg.trustServerCertificate,
        enableArithAbort: true,
        useUTC: false,
      },
    };
    if (this.cfg.authType === "sql-login") {
      const password = this.getSecret(this.cfg.id);
      if (!this.cfg.username || password == null) throw new Error("SQL login requires a username and stored password");
      config.user = this.cfg.username;
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
      // Pool-level socket errors: surface as status; the next operation's retry path rebuilds.
      this.emitStatus("reconnecting", "connection lost");
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

  execute(sqlText: string, onChunk: (chunk: QueryChunk) => void): QueryExecution {
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
          const res = await this.runBatchStream(pool, batch, onChunk, (req) => (currentRequest = req));
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
  ): Promise<{ errored: boolean; cancelled: boolean }> {
    return new Promise((resolve) => {
      const request = new sql.Request(pool);
      request.stream = true;
      (request as unknown as Record<string, unknown>).arrayRowMode = true;
      setRequest(request);
      let collector: RowCollector | null = null;
      let errored = false;
      let wasCancelled = false;

      const endResultSet = () => {
        if (!collector) return;
        const { rowCount, truncated } = collector.finish();
        onChunk({ type: "resultsetEnd", rowCount, truncated });
        collector = null;
      };

      request.on("recordset", (cols: unknown) => {
        endResultSet();
        const arr = (Array.isArray(cols) ? cols : Object.values(cols as object)) as Array<{ name?: string }>;
        const columns: ColumnInfo[] = arr.map((c, i) => ({ name: c.name || `(col ${i + 1})`, type: typeName(c) }));
        onChunk({ type: "resultset", columns });
        collector = new RowCollector((rows) => onChunk({ type: "rows", rows }), this.rowCap);
      });
      request.on("row", (row: unknown) => {
        const values = Array.isArray(row) ? row : Object.values(row as object);
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

      const maybePromise = request.batch(batchSql) as unknown as Promise<unknown> | undefined;
      if (maybePromise && typeof maybePromise.catch === "function") maybePromise.catch(() => {});
    });
  }
}

// Traces: BASED-CONN-TEST
export async function testConnection(
  cfg: ConnectionConfig,
  getSecret: SecretProvider,
  transientSecret?: string,
): Promise<TestResult> {
  const secretProvider: SecretProvider = (id) => transientSecret ?? getSecret(id);
  const adapter = new MssqlAdapter(cfg, secretProvider);
  try {
    await adapter.connect();
    let serverVersion: string | undefined;
    let identity: string | undefined;
    const exec = adapter.execute("SELECT @@VERSION AS v, SUSER_SNAME() AS who", (chunk) => {
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
    await adapter.disconnect().catch(() => {});
  }
}
