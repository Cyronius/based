// Traces: BASED-SNOWFLAKE-ENGINE, BASED-SNOWFLAKE-AUTH, BASED-SNOWFLAKE-SCRIPT, BASED-SNOWFLAKE-DML
// Snowflake adapter. Shaped like MssqlAdapter (same reconnect/status/streaming spine, same reuse of
// retry/rowcap/serialize) because Snowflake is SQL-and-write-shaped in the same way SQL Server is.
// The divergences that matter, all of them consequences of the engine rather than style choices:
//   - catalog lives in INFORMATION_SCHEMA, not sys.*
//   - unquoted identifiers are stored UPPER-CASED, so catalog predicates compare against the stored
//     form and we never defensively lower-case (see resolveObject)
//   - binds are positional (`?` + an ordered array), not named `@p`
//   - paging is LIMIT/OFFSET, not OFFSET…FETCH
//   - there is no GO batch separator, so execute() sends the editor text as one statement
//   - there are no user indexes, hence capabilities.indexIntrospect = false and no getIndexes
// The SDK is imported for its types only. Its *value* is loaded lazily by loadSdk(), which must set
// SNOWFLAKE_DISABLE_PLATFORM_DETECTION first — see snowflakeEnv.ts for why, and why a side-effect
// import ordered above a static `import snowflake from "snowflake-sdk"` is not good enough here.
// `import type` is fully erased, so this also keeps BASED-LAZY-ENGINES honest.
import type snowflake from "snowflake-sdk";
import { disableSdkPlatformDetection } from "./snowflakeEnv";

/** `connection.execute` returns `RowStatement | FileAndStageBindStatement`; we only ever issue
 *  plain statements, so this alias names the half we use. `getColumns()` is optional on the SDK's
 *  type (it is undefined until the result set arrives), which the streaming path handles. */
type Statement = ReturnType<snowflake.Connection["execute"]>;
type Connection = snowflake.Connection;
type SnowflakeError = snowflake.SnowflakeError;
type SnowflakeConnectionOptions = NonNullable<Parameters<typeof snowflake.createConnection>[0]>;
import { settingStr } from "./connectionSettings";
import { SNOWFLAKE_DIALECT, type SqlDialect } from "./dialect";
import type { SecretProvider } from "./entra";
import { withReconnect } from "./retry";
import { DEFAULT_ROW_CAP, RowCollector } from "./rowcap";
import { serializeRow, serializeValue } from "./serialize";
import { decodeKeyPairSecret } from "../secrets";
import type { ScriptAction, ScriptInput } from "./scripter";
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
  TableColumn,
  TableDetails,
  TableFilter,
  TableForeignKey,
  TablePage,
  TableSort,
  TestResult,
} from "./types";

let sdk: typeof snowflake | null = null;

/** The one place the driver's value is loaded, so its env var can never be set too late. */
async function loadSdk(): Promise<typeof snowflake> {
  if (!sdk) {
    disableSdkPlatformDetection();
    const mod = (await import("snowflake-sdk")) as unknown as { default?: typeof snowflake };
    sdk = mod.default ?? (mod as unknown as typeof snowflake);
  }
  return sdk;
}

const CONNECT_TIMEOUT_MS = 30_000;
// External-browser SSO blocks on a human, so it gets its own bound: the SDK's own browser response
// timeout is 120s, and this has to sit above it or we would pre-empt the SDK's better error.
const BROWSER_CONNECT_TIMEOUT_MS = 150_000;

// Traces: BASED-SNOWFLAKE-AUTH — `*.snowflakecomputing.com` is a wildcard onto Snowflake's shared
// load balancer, so a wrong account identifier still resolves in DNS and still completes a TLS
// handshake; the balancer simply 404s because it hosts no such account. The driver reports that as a
// bare "Request to Snowflake failed." (401002), which reads like a network fault and sends you
// looking at firewalls. It is almost always a legacy account locator given without its region and
// cloud. Say so, because nothing else in the stack will.
export function snowflakeAccountNotFound(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: string | number; response?: { status?: number } };
  return String(e.code) === "401002" && e.response?.status === 404;
}

export function errMessage(err: unknown): string {
  if (!err) return "Unknown error";
  if (snowflakeAccountNotFound(err)) {
    return (
      "Snowflake does not recognise this account identifier. A bare account locator only works in " +
      'AWS us-west-2 — otherwise include the region and cloud (e.g. "xy12345.us-east-2.aws"), or ' +
      'use the organisation form "myorg-myaccount". Snowsight shows it under Account → Copy account URL.'
    );
  }
  const e = err as { message?: string; code?: string | number };
  const message = e.message ?? String(err);
  return e.code != null && !message.includes(String(e.code)) ? `${message} (${e.code})` : message;
}

/** Snowflake surfaces a dead session as an error code/message rather than a socket code, so the
 *  shared isRetryableError (tuned for tedious' ESOCKET family) misses it. */
function isRetryableSnowflakeError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: string | number; message?: string };
  const code = String(e.code ?? "");
  const message = e.message ?? "";
  // 390114/390111: authentication token expired or session no longer exists.
  if (code === "390114" || code === "390111" || code === "407002") return true;
  if (/session (no longer exists|has expired)|authentication token has expired/i.test(message)) return true;
  if (/socket hang up|ECONNRESET|EPIPE|ETIMEDOUT|network error/i.test(message)) return true;
  return false;
}

/** Snowflake's own type names arrive as JSON-ish strings on getColumns(); normalize to lower case
 *  so the grid's type column reads like every other engine's. */
function typeNameOf(raw: string): string {
  return raw.toLowerCase();
}

/** SHOW commands return lower-case column names (unlike INFORMATION_SCHEMA's upper-case); read
 *  either casing so a driver-side normalisation change can't silently blank every key flag. */
function showCol(row: Record<string, unknown>, key: string): string {
  return String(row[key] ?? row[key.toUpperCase()] ?? "");
}

function showNum(row: Record<string, unknown>, key: string): number {
  return Number(row[key] ?? row[key.toUpperCase()] ?? 0);
}

/** Order SHOW IMPORTED KEYS rows for grouping: by owning constraint, then column position. */
function byConstraintThenSeq(a: Record<string, unknown>, b: Record<string, unknown>): number {
  const ka = `${showCol(a, "fk_schema_name")}.${showCol(a, "fk_table_name")}.${showCol(a, "fk_name")}`;
  const kb = `${showCol(b, "fk_schema_name")}.${showCol(b, "fk_table_name")}.${showCol(b, "fk_name")}`;
  return ka !== kb ? (ka < kb ? -1 : 1) : showNum(a, "key_sequence") - showNum(b, "key_sequence");
}

export class SnowflakeAdapter implements DatabaseAdapter {
  // Traces: BASED-AGENT-SURFACE-VARIANT — Snowflake is SQL + write + ordered browse + scripting +
  // relations. indexIntrospect is false on purpose: Snowflake has no user-defined indexes (clustering
  // keys and search optimization are a different concept, and SHOW INDEXES covers only hybrid
  // tables), so get_indexes must be ABSENT from the agent surface rather than present and lying.
  readonly capabilities: EngineCapabilities = {
    sql: true,
    search: false,
    write: true,
    createTable: false,
    orderedBrowse: true,
    script: true,
    relations: true,
    engine: "snowflake",
    variant: "snowflake",
    containers: null,
    wherePredicate: false,
    structuredFilters: true,
    countRows: true,
    takeByKey: false,
    indexIntrospect: false,
  };
  readonly dialect: SqlDialect = SNOWFLAKE_DIALECT;
  readonly database: string;
  private conn: Connection | null = null;
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

  private get schema(): string {
    return settingStr(this.cfg, "schema") ?? SNOWFLAKE_DIALECT.defaultSchema;
  }

  // Traces: BASED-SNOWFLAKE-AUTH — three modes, all authenticating inside the driver rather than
  // through entra.ts (which is Azure-only and returns null for these auth types). Password and
  // key-pair read the connection's secret slot; key-pair's slot holds a JSON blob because it needs
  // both a PEM and an optional passphrase. External-browser stores nothing.
  private buildOptions(): SnowflakeConnectionOptions {
    const account = settingStr(this.cfg, "account");
    if (!account) throw new Error("Snowflake requires an account identifier");
    const username = settingStr(this.cfg, "username");
    const base: SnowflakeConnectionOptions = {
      account,
      database: this.database,
      schema: this.schema,
      warehouse: settingStr(this.cfg, "warehouse"),
      role: settingStr(this.cfg, "role"),
      application: "based",
      clientSessionKeepAlive: true,
      timeout: CONNECT_TIMEOUT_MS,
    };
    switch (this.cfg.authType) {
      case "snowflake-password": {
        const password = this.getSecret(this.cfg.id);
        if (!username || password == null) {
          throw new Error("Snowflake password auth requires a username and stored password");
        }
        return { ...base, username, password, authenticator: "SNOWFLAKE" };
      }
      case "snowflake-keypair": {
        const raw = this.getSecret(this.cfg.id);
        if (!username || raw == null) {
          throw new Error("Snowflake key-pair auth requires a username and a stored private key");
        }
        const { key, pass } = decodeKeyPairSecret(raw);
        return { ...base, username, authenticator: "SNOWFLAKE_JWT", privateKey: key, privateKeyPass: pass };
      }
      case "snowflake-oauth":
        if (!username) throw new Error("Snowflake SSO requires a username (your login email)");
        return { ...base, username, authenticator: "EXTERNALBROWSER" };
      default:
        throw new Error(`Auth type "${this.cfg.authType}" is not a Snowflake auth type`);
    }
  }

  // Traces: BASED-SNOWFLAKE-AUTH — connect always settles. The SDK's own `timeout` option bounds one
  // HTTP request, not the whole connect, and `retryTimeout` cannot be lowered (connection_config does
  // Math.max(300, yours)), so a stall anywhere inside the driver would otherwise reach the user as an
  // indefinite spinner with no error — which is exactly how the Bun platform-detection hang presented.
  // The wall-clock bound here is the backstop that turns any such stall into a reportable failure.
  private async openConnection(): Promise<Connection> {
    const driver = await loadSdk();
    const options = this.buildOptions();
    const conn = driver.createConnection(options);
    const limitMs = this.cfg.authType === "snowflake-oauth" ? BROWSER_CONNECT_TIMEOUT_MS : CONNECT_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          conn.destroy(() => {});
        } catch {
          // the connection never reached a destroyable state; the timeout is what matters
        }
        reject(new Error(`Snowflake connect timed out after ${Math.round(limitMs / 1000)}s`));
      }, limitMs);
      // connectAsync is required for EXTERNALBROWSER (it drives a multi-step flow); it is valid for
      // the other authenticators too, so there is one code path rather than an auth branch here.
      conn.connectAsync((err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve(conn);
      });
    });
  }

  private async rebuild(): Promise<void> {
    const old = this.conn;
    this.conn = null;
    if (old) await this.destroy(old).catch(() => {});
    this.conn = await this.openConnection();
  }

  /** Bounded-backoff reconnect for a drop with no caller waiting on it, mirroring MssqlAdapter's. */
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
      this.conn = null;
      this.emitStatus("disconnected", "unable to reconnect");
    } finally {
      this.reconnectingInBackground = false;
    }
  }

  private destroy(conn: Connection): Promise<void> {
    return new Promise((resolve) => conn.destroy(() => resolve()));
  }

  private async ensureConnection(): Promise<Connection> {
    if (this.conn && !this.conn.isUp()) {
      this.conn = null;
    }
    if (!this.conn) this.conn = await this.openConnection();
    return this.conn;
  }

  private async withConnection<T>(op: (conn: Connection) => Promise<T>): Promise<T> {
    return withReconnect({
      attempt: async () => op(await this.ensureConnection()),
      rebuild: async () => {
        await this.rebuild();
        this.emitStatus("connected");
      },
      onReconnecting: () => this.emitStatus("reconnecting"),
      isRetryable: isRetryableSnowflakeError,
    });
  }

  /** Buffered query for catalog work: Snowflake's catalog result sets are small and every caller
   *  here wants them as an array. The streaming path is execute() and lives separately. */
  private query<T = Record<string, unknown>>(sqlText: string, binds: Array<string | number | boolean | null> = []): Promise<T[]> {
    return this.withConnection(
      (conn) =>
        new Promise<T[]>((resolve, reject) => {
          conn.execute({
            sqlText,
            binds,
            complete: (err, _stmt, rows) => (err ? reject(err) : resolve((rows ?? []) as T[])),
          });
        }),
    );
  }

  async connect(): Promise<void> {
    this.emitStatus("connecting");
    await this.ensureConnection();
    this.emitStatus("connected");
  }

  async disconnect(): Promise<void> {
    const conn = this.conn;
    this.conn = null;
    if (conn) await this.destroy(conn).catch(() => {});
    this.emitStatus("disconnected");
  }

  // Traces: BASED-CONN-TEST
  async probe(): Promise<TestResult> {
    try {
      await this.connect();
      const rows = await this.query<{ V: string; WHO: string }>(
        "SELECT CURRENT_VERSION() AS V, CURRENT_USER() AS WHO",
      );
      const row = rows[0];
      if (!row) return { ok: false, error: "Connected but test query returned no rows" };
      return { ok: true, serverVersion: `Snowflake ${String(row.V)}`, identity: String(row.WHO) };
    } catch (err) {
      return { ok: false, error: errMessage(err) };
    } finally {
      await this.disconnect().catch(() => {});
    }
  }

  async listDatabases(): Promise<string[]> {
    try {
      const rows = await this.query<Record<string, unknown>>("SHOW DATABASES");
      // SHOW returns a fixed shape whose column is literally "name" (lower case, unlike the
      // upper-cased INFORMATION_SCHEMA columns) — read it defensively either way.
      const names = rows.map((r) => String(r.name ?? r.NAME ?? "")).filter(Boolean);
      return names.length > 0 ? names.sort() : [this.database];
    } catch {
      return [this.database];
    }
  }

  async listSchemas(): Promise<string[]> {
    const rows = await this.query<{ SCHEMA_NAME: string }>(
      `SELECT SCHEMA_NAME FROM ${this.dialect.escapeIdent(this.database)}.INFORMATION_SCHEMA.SCHEMATA
       WHERE SCHEMA_NAME <> 'INFORMATION_SCHEMA' ORDER BY SCHEMA_NAME`,
    );
    return rows.map((r) => String(r.SCHEMA_NAME));
  }

  async listObjects(): Promise<DbObject[]> {
    const db = this.dialect.escapeIdent(this.database);
    // TABLES already carries views (TABLE_TYPE = 'VIEW'), so one scan covers both. Snowflake has no
    // INFORMATION_SCHEMA.ROUTINES — functions and procedures live in separate views, one UNION arm each.
    const rows = await this.query<{ SCHEMA_NAME: string; OBJECT_NAME: string; OBJ_TYPE: DbObjectType }>(
      `SELECT TABLE_SCHEMA AS SCHEMA_NAME, TABLE_NAME AS OBJECT_NAME,
              CASE WHEN TABLE_TYPE = 'VIEW' THEN 'view' ELSE 'table' END AS OBJ_TYPE
       FROM ${db}.INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA <> 'INFORMATION_SCHEMA'
       UNION ALL
       SELECT FUNCTION_SCHEMA AS SCHEMA_NAME, FUNCTION_NAME AS OBJECT_NAME, 'function' AS OBJ_TYPE
       FROM ${db}.INFORMATION_SCHEMA.FUNCTIONS
       WHERE FUNCTION_SCHEMA <> 'INFORMATION_SCHEMA'
       UNION ALL
       SELECT PROCEDURE_SCHEMA AS SCHEMA_NAME, PROCEDURE_NAME AS OBJECT_NAME, 'procedure' AS OBJ_TYPE
       FROM ${db}.INFORMATION_SCHEMA.PROCEDURES
       WHERE PROCEDURE_SCHEMA <> 'INFORMATION_SCHEMA'
       ORDER BY 1, 2`,
    );
    return rows.map((r) => ({ schema: String(r.SCHEMA_NAME), name: String(r.OBJECT_NAME), type: r.OBJ_TYPE }));
  }

  // Traces: BASED-SNOWFLAKE-ENGINE — the identifier-case seam. Snowflake stores unquoted names
  // upper-cased, so a caller passing "customers" (from a hand-typed agent argument) must still find
  // CUSTOMERS, while a genuinely lower-case quoted name must still match exactly. Try the literal
  // form first, then the upper-cased one — never blanket-normalize, which would break the quoted case.
  private caseCandidates(name: string): string[] {
    const upper = name.toUpperCase();
    return name === upper ? [name] : [name, upper];
  }

  async getTableColumns(schema: string, table: string): Promise<TableColumn[]> {
    const db = this.dialect.escapeIdent(this.database);
    for (const s of this.caseCandidates(schema)) {
      for (const t of this.caseCandidates(table)) {
        const rows = await this.query<Record<string, unknown>>(
          `SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION,
                  NUMERIC_SCALE, IS_NULLABLE, ORDINAL_POSITION
           FROM ${db}.INFORMATION_SCHEMA.COLUMNS
           WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
           ORDER BY ORDINAL_POSITION`,
          [s, t],
        );
        if (rows.length === 0) continue;
        // s/t matched the stored form via the bound predicate above, so they are safe to quote into
        // the SHOWs. Key membership has to come from SHOW — see showKeys.
        const pkCols = new Set(
          (await this.showKeys("PRIMARY", { schema: s, name: t })).map((r) => showCol(r, "column_name")),
        );
        const fkTargetByCol = new Map<string, string>();
        for (const r of (await this.showKeys("IMPORTED", { schema: s, name: t })).sort(byConstraintThenSeq)) {
          const col = showCol(r, "fk_column_name");
          if (!fkTargetByCol.has(col)) {
            fkTargetByCol.set(
              col,
              `${showCol(r, "pk_schema_name")}.${showCol(r, "pk_table_name")}(${showCol(r, "pk_column_name")})`,
            );
          }
        }
        return rows.map((row) => ({
          name: String(row.COLUMN_NAME),
          type: typeNameOf(String(row.DATA_TYPE)),
          maxLength: row.CHARACTER_MAXIMUM_LENGTH != null ? Number(row.CHARACTER_MAXIMUM_LENGTH) : null,
          precision: row.NUMERIC_PRECISION != null ? Number(row.NUMERIC_PRECISION) : null,
          scale: row.NUMERIC_SCALE != null ? Number(row.NUMERIC_SCALE) : null,
          nullable: String(row.IS_NULLABLE).toUpperCase() === "YES",
          isPrimaryKey: pkCols.has(String(row.COLUMN_NAME)),
          isForeignKey: fkTargetByCol.has(String(row.COLUMN_NAME)),
          fkTarget: fkTargetByCol.get(String(row.COLUMN_NAME)) ?? null,
        }));
      }
    }
    return [];
  }

  /** Resolve a caller-supplied schema/name to the form actually stored, so every subsequent
   *  statement quotes the real identifier. Returns null when the object doesn't exist. */
  private async resolveObject(schema: string, name: string): Promise<{ schema: string; name: string } | null> {
    const db = this.dialect.escapeIdent(this.database);
    const rows = await this.query<{ S: string; N: string }>(
      `SELECT TABLE_SCHEMA AS S, TABLE_NAME AS N FROM ${db}.INFORMATION_SCHEMA.TABLES
       WHERE UPPER(TABLE_SCHEMA) = UPPER(?) AND UPPER(TABLE_NAME) = UPPER(?)
       UNION ALL
       SELECT FUNCTION_SCHEMA AS S, FUNCTION_NAME AS N FROM ${db}.INFORMATION_SCHEMA.FUNCTIONS
       WHERE UPPER(FUNCTION_SCHEMA) = UPPER(?) AND UPPER(FUNCTION_NAME) = UPPER(?)
       UNION ALL
       SELECT PROCEDURE_SCHEMA AS S, PROCEDURE_NAME AS N FROM ${db}.INFORMATION_SCHEMA.PROCEDURES
       WHERE UPPER(PROCEDURE_SCHEMA) = UPPER(?) AND UPPER(PROCEDURE_NAME) = UPPER(?)
       LIMIT 1`,
      [schema, name, schema, name, schema, name],
    );
    const row = rows[0];
    return row ? { schema: String(row.S), name: String(row.N) } : null;
  }

  private qualify(schema: string, name: string): string {
    return `${this.dialect.escapeIdent(this.database)}.${this.dialect.escapeIdent(schema)}.${this.dialect.escapeIdent(name)}`;
  }

  /** PK/FK column membership via SHOW. Snowflake's INFORMATION_SCHEMA has no KEY_COLUMN_USAGE —
   *  TABLE_CONSTRAINTS names constraints but never their columns — so SHOW PRIMARY KEYS /
   *  SHOW IMPORTED KEYS is the only catalog that maps a constraint to its columns. SHOW takes no
   *  binds, so identifiers are escaped inline; callers pass stored-form names. A failure (view
   *  target, missing privilege) degrades to "no key info" rather than sinking the caller. */
  private async showKeys(
    kind: "PRIMARY" | "IMPORTED",
    scope?: { schema: string; name: string },
  ): Promise<Array<Record<string, unknown>>> {
    const target = scope
      ? `TABLE ${this.qualify(scope.schema, scope.name)}`
      : `DATABASE ${this.dialect.escapeIdent(this.database)}`;
    try {
      return await this.query<Record<string, unknown>>(`SHOW ${kind} KEYS IN ${target}`);
    } catch {
      return [];
    }
  }

  // Traces: BASED-VIEW-DEFINITION
  async getObjectDefinition(schema: string, name: string): Promise<string | null> {
    const db = this.dialect.escapeIdent(this.database);
    const views = await this.query<{ VIEW_DEFINITION: string | null }>(
      `SELECT VIEW_DEFINITION FROM ${db}.INFORMATION_SCHEMA.VIEWS
       WHERE UPPER(TABLE_SCHEMA) = UPPER(?) AND UPPER(TABLE_NAME) = UPPER(?)`,
      [schema, name],
    );
    if (views[0]?.VIEW_DEFINITION) return String(views[0].VIEW_DEFINITION);
    const routines = await this.query<{ DEF: string | null }>(
      `SELECT FUNCTION_DEFINITION AS DEF FROM ${db}.INFORMATION_SCHEMA.FUNCTIONS
       WHERE UPPER(FUNCTION_SCHEMA) = UPPER(?) AND UPPER(FUNCTION_NAME) = UPPER(?)
       UNION ALL
       SELECT PROCEDURE_DEFINITION AS DEF FROM ${db}.INFORMATION_SCHEMA.PROCEDURES
       WHERE UPPER(PROCEDURE_SCHEMA) = UPPER(?) AND UPPER(PROCEDURE_NAME) = UPPER(?)`,
      [schema, name, schema, name],
    );
    return routines[0]?.DEF != null ? String(routines[0].DEF) : null;
  }

  // Traces: BASED-ROUTINE-DETAILS — Snowflake reports a routine's signature as one ARGUMENT_SIGNATURE
  // string ("(A NUMBER, B VARCHAR)") rather than a row per parameter, so it is parsed rather than joined.
  async getRoutineParameters(schema: string, name: string): Promise<RoutineParameter[]> {
    const db = this.dialect.escapeIdent(this.database);
    const rows = await this.query<{ ARGUMENT_SIGNATURE: string | null }>(
      `SELECT ARGUMENT_SIGNATURE FROM ${db}.INFORMATION_SCHEMA.FUNCTIONS
       WHERE UPPER(FUNCTION_SCHEMA) = UPPER(?) AND UPPER(FUNCTION_NAME) = UPPER(?)
       UNION ALL
       SELECT ARGUMENT_SIGNATURE FROM ${db}.INFORMATION_SCHEMA.PROCEDURES
       WHERE UPPER(PROCEDURE_SCHEMA) = UPPER(?) AND UPPER(PROCEDURE_NAME) = UPPER(?)`,
      [schema, name, schema, name],
    );
    const sig = rows[0]?.ARGUMENT_SIGNATURE;
    if (!sig) return [];
    const inner = sig.trim().replace(/^\(/, "").replace(/\)$/, "").trim();
    if (!inner) return [];
    return inner.split(",").map((part, i) => {
      const [pname = "", ...rest] = part.trim().split(/\s+/);
      return { name: pname, type: rest.join(" ").toLowerCase(), mode: "in" as const, ordinal: i + 1 };
    });
  }

  /** Structured filters → a positional WHERE clause plus its binds, in emission order. Column names
   *  are membership-validated against the real column list, then quoted; values never interpolate.
   *  Shared by readTablePage and countRows so the two can't disagree about what a filter means. */
  private buildWhere(
    filters: TableFilter[] | undefined,
    requireCol: (name: string) => TableColumn,
  ): { sql: string; binds: Array<string | number> } {
    const parts: string[] = [];
    const binds: Array<string | number> = [];
    for (const f of filters ?? []) {
      const ident = this.dialect.escapeIdent(requireCol(f.column).name);
      if (f.op === "is-null") {
        parts.push(`${ident} IS NULL`);
        continue;
      }
      if (f.op === "not-null") {
        parts.push(`${ident} IS NOT NULL`);
        continue;
      }
      const OPS: Record<string, string> = { eq: "=", ne: "<>", gt: ">", ge: ">=", lt: "<", le: "<=", like: "LIKE" };
      const op = OPS[f.op];
      if (!op) throw new Error(`Unknown filter op "${f.op}"`);
      parts.push(`${ident} ${op} ?`);
      binds.push(f.value ?? "");
    }
    return { sql: parts.length > 0 ? ` WHERE ${parts.join(" AND ")}` : "", binds };
  }

  private async columnIndex(schema: string, table: string): Promise<{
    columns: TableColumn[];
    requireCol: (name: string) => TableColumn;
  }> {
    const columns = await this.getTableColumns(schema, table);
    if (columns.length === 0) throw new Error(`No columns for ${schema}.${table}`);
    // Match a caller's column name case-insensitively for the same reason resolveObject exists,
    // but return the stored name so the emitted SQL quotes what actually exists.
    const byName = new Map(columns.map((c) => [c.name.toUpperCase(), c]));
    const requireCol = (name: string): TableColumn => {
      const col = byName.get(name.toUpperCase());
      if (!col) throw new Error(`Unknown column "${name}" on ${schema}.${table}`);
      return col;
    };
    return { columns, requireCol };
  }

  // Traces: BASED-LANCE-SCAN — exact count, optionally narrowed by the same filters readTablePage takes.
  async countRows(schema: string, table: string, opts?: { filters?: TableFilter[] }): Promise<number> {
    const { requireCol } = await this.columnIndex(schema, table);
    const target = await this.resolveObject(schema, table);
    if (!target) throw new Error(`Unknown object ${schema}.${table}`);
    const where = this.buildWhere(opts?.filters, requireCol);
    const rows = await this.query<{ N: number | string }>(
      `SELECT COUNT(*) AS N FROM ${this.qualify(target.schema, target.name)}${where.sql}`,
      where.binds,
    );
    return Number(rows[0]?.N ?? 0);
  }

  // Traces: BASED-TABLE-BROWSE, BASED-TABLE-ORDERBY
  async readTablePage(
    schema: string,
    table: string,
    opts: { offset: number; limit: number; orderBy?: TableSort[]; filters?: TableFilter[] },
  ): Promise<TablePage> {
    const { columns, requireCol } = await this.columnIndex(schema, table);
    const target = await this.resolveObject(schema, table);
    if (!target) throw new Error(`Unknown object ${schema}.${table}`);

    const pk = columns.filter((c) => c.isPrimaryKey);
    const stableCols = (pk.length > 0 ? pk : [columns[0]!]).map((c) => c.name);
    const userSort = (opts.orderBy ?? []).map((s) => ({
      name: requireCol(s.column).name,
      dir: s.dir === "desc" ? "DESC" : "ASC",
    }));
    const orderParts = [
      ...userSort.map((s) => `${this.dialect.escapeIdent(s.name)} ${s.dir}`),
      ...stableCols.filter((c) => !userSort.some((s) => s.name === c)).map((c) => this.dialect.escapeIdent(c)),
    ];

    const limit = Math.min(Math.max(1, Math.floor(opts.limit)), this.rowCap);
    const offset = Math.max(0, Math.floor(opts.offset));
    const where = this.buildWhere(opts.filters, requireCol);
    const rows = await this.query<Record<string, unknown>>(
      `SELECT * FROM ${this.qualify(target.schema, target.name)}${where.sql}` +
        ` ORDER BY ${orderParts.join(", ")} ${this.dialect.page(offset, limit)}`,
      where.binds,
    );
    return {
      columns,
      rows: rows.map((row) => columns.map((c) => serializeValue(row[c.name]))),
      orderBy: stableCols,
    };
  }

  // Traces: BASED-TABLE-DETAILS — Snowflake has no identity/computed/collation catalog shaped like
  // sys.columns, and no indexes or triggers at all, so those arrive empty and the Details view
  // degrades to what actually exists here. Defaults, checks and FKs are real.
  async getTableDetails(schema: string, name: string): Promise<TableDetails> {
    const base = await this.getTableColumns(schema, name);
    if (base.length === 0) throw new Error(`No columns for ${schema}.${name}`);
    const target = await this.resolveObject(schema, name);
    if (!target) throw new Error(`Unknown object ${schema}.${name}`);
    const db = this.dialect.escapeIdent(this.database);

    const defaults = await this.query<{ COLUMN_NAME: string; COLUMN_DEFAULT: string | null; IS_IDENTITY: string | null }>(
      `SELECT COLUMN_NAME, COLUMN_DEFAULT, IS_IDENTITY FROM ${db}.INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
      [target.schema, target.name],
    );
    const defaultByCol = new Map(defaults.map((d) => [String(d.COLUMN_NAME), d]));

    const columns: ScriptTableColumn[] = base.map((c) => {
      const extra = defaultByCol.get(c.name);
      return {
        ...c,
        collation: null,
        isIdentity: String(extra?.IS_IDENTITY ?? "").toUpperCase() === "YES",
        identitySeed: null,
        identityIncrement: null,
        computedDefinition: null,
        computedPersisted: false,
      };
    });

    const fkRows = (await this.showKeys("IMPORTED", target)).sort(byConstraintThenSeq);
    const foreignKeys: TableForeignKey[] = [];
    const fkByName = new Map<string, TableForeignKey>();
    for (const row of fkRows) {
      const key = showCol(row, "fk_name");
      let fk = fkByName.get(key);
      if (!fk) {
        fk = {
          name: key,
          columns: [],
          refSchema: showCol(row, "pk_schema_name"),
          refTable: showCol(row, "pk_table_name"),
          refColumns: [],
          onDelete: (showCol(row, "delete_rule") || "NO ACTION").replace(/ /g, "_"),
          onUpdate: (showCol(row, "update_rule") || "NO ACTION").replace(/ /g, "_"),
          isDisabled: false,
        };
        fkByName.set(key, fk);
        foreignKeys.push(fk);
      }
      fk.columns.push(showCol(row, "fk_column_name"));
      fk.refColumns.push(showCol(row, "pk_column_name"));
    }

    return {
      schema: target.schema,
      name: target.name,
      columns,
      indexes: [],
      foreignKeys,
      checkConstraints: [],
      defaultConstraints: defaults
        .filter((d) => d.COLUMN_DEFAULT != null)
        .map((d) => ({
          name: `DF_${target.name}_${String(d.COLUMN_NAME)}`,
          column: String(d.COLUMN_NAME),
          definition: String(d.COLUMN_DEFAULT),
        })),
      triggers: [],
    };
  }

  // Traces: BASED-SNOWFLAKE-SCRIPT — Snowflake generates its own DDL better than we could rebuild
  // it from catalog rows, so `create` delegates to GET_DDL and only the templates that GET_DDL has
  // no equivalent for (drop / select / insert) are generated here. This is the adapter-side
  // scriptObject seam: callers prefer it and fall back to the pure T-SQL scripter when absent.
  async scriptObject(input: ScriptInput, action: ScriptAction): Promise<string> {
    const schema = input.kind === "table" ? input.details.schema : input.schema;
    const name = input.kind === "table" ? input.details.name : input.name;
    const target = (await this.resolveObject(schema, name)) ?? { schema, name };
    const qualified = this.qualify(target.schema, target.name);
    const kindKeyword =
      input.kind === "table"
        ? "TABLE"
        : input.type === "view"
          ? "VIEW"
          : input.type === "procedure"
            ? "PROCEDURE"
            : input.type === "trigger"
              ? "TABLE" // Snowflake has no triggers; nothing to script
              : "FUNCTION";

    const getDdl = async (): Promise<string> => {
      const rows = await this.query<Record<string, unknown>>(`SELECT GET_DDL(?, ?, TRUE) AS DDL`, [
        kindKeyword.toLowerCase(),
        `${this.database}.${target.schema}.${target.name}`,
      ]);
      const ddl = rows[0]?.DDL;
      if (ddl == null) throw new Error(`GET_DDL returned nothing for ${qualified}`);
      return String(ddl).trim();
    };
    const dropSql = `DROP ${kindKeyword} IF EXISTS ${qualified};`;

    switch (action) {
      case "create":
        return getDdl();
      case "drop":
        return dropSql;
      case "drop-create":
        return `${dropSql}\n\n${await getDdl()}`;
      case "alter": {
        if (input.kind === "table") throw new Error("alter is not scriptable for a table");
        const ddl = await getDdl();
        return /^\s*CREATE\s+OR\s+REPLACE/i.test(ddl)
          ? ddl
          : ddl.replace(/^\s*CREATE\s+/i, "CREATE OR REPLACE ");
      }
      case "select": {
        const cols = input.kind === "table" ? input.details.columns.map((c) => this.dialect.escapeIdent(c.name)) : ["*"];
        return `SELECT ${cols.join(", ")}\nFROM ${qualified};`;
      }
      case "insert": {
        if (input.kind !== "table") throw new Error("insert is only scriptable for a table");
        const insertable = input.details.columns.filter((c) => !c.isIdentity);
        const cols = insertable.map((c) => this.dialect.escapeIdent(c.name)).join(", ");
        const values = insertable.map((c) => `/* ${c.name} (${c.type}) */`).join(", ");
        return `INSERT INTO ${qualified} (${cols})\nVALUES (${values});`;
      }
    }
  }

  // Traces: BASED-RELATIONS — all tables + columns + FK edges for the ER diagram, two queries, no N+1.
  async getRelations(schemaFilter?: string): Promise<RelationsGraph> {
    const db = this.dialect.escapeIdent(this.database);
    const scope = schemaFilter ?? null;

    const colRows = await this.query<Record<string, unknown>>(
      `SELECT c.TABLE_SCHEMA, c.TABLE_NAME, c.COLUMN_NAME, c.DATA_TYPE, c.IS_NULLABLE, c.ORDINAL_POSITION
       FROM ${db}.INFORMATION_SCHEMA.COLUMNS c
       JOIN ${db}.INFORMATION_SCHEMA.TABLES t
         ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME AND t.TABLE_TYPE = 'BASE TABLE'
       WHERE c.TABLE_SCHEMA <> 'INFORMATION_SCHEMA' AND (? IS NULL OR c.TABLE_SCHEMA = ?)
       ORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION`,
      [scope, scope],
    );

    // Key membership for the whole database in two SHOWs (no N+1); SHOW has no WHERE, so scope
    // filtering happens below in JS.
    const pkRows = await this.showKeys("PRIMARY");
    const fkRaw = (await this.showKeys("IMPORTED")).sort(byConstraintThenSeq);
    const pkCols = new Set(
      pkRows.map((r) => `${showCol(r, "schema_name")}.${showCol(r, "table_name")}.${showCol(r, "column_name")}`),
    );
    const fkCols = new Set(
      fkRaw.map((r) => `${showCol(r, "fk_schema_name")}.${showCol(r, "fk_table_name")}.${showCol(r, "fk_column_name")}`),
    );

    const tables: RelationsTable[] = [];
    const tableByKey = new Map<string, RelationsTable>();
    for (const row of colRows) {
      const key = `${String(row.TABLE_SCHEMA)}.${String(row.TABLE_NAME)}`;
      let table = tableByKey.get(key);
      if (!table) {
        table = { schema: String(row.TABLE_SCHEMA), name: String(row.TABLE_NAME), columns: [] };
        tableByKey.set(key, table);
        tables.push(table);
      }
      const colKey = `${String(row.TABLE_SCHEMA)}.${String(row.TABLE_NAME)}.${String(row.COLUMN_NAME)}`;
      table.columns.push({
        name: String(row.COLUMN_NAME),
        type: typeNameOf(String(row.DATA_TYPE)),
        isPrimaryKey: pkCols.has(colKey),
        isForeignKey: fkCols.has(colKey),
        nullable: String(row.IS_NULLABLE).toUpperCase() === "YES",
      });
    }

    // Scope keeps any edge touching the scope, so cross-schema references still render.
    const foreignKeys: RelationsForeignKey[] = [];
    const fkByKey = new Map<string, RelationsForeignKey>();
    for (const row of fkRaw) {
      const parentSchema = showCol(row, "fk_schema_name");
      const refSchema = showCol(row, "pk_schema_name");
      if (scope != null && parentSchema !== scope && refSchema !== scope) continue;
      const key = `${parentSchema}.${showCol(row, "fk_table_name")}.${showCol(row, "fk_name")}`;
      let fk = fkByKey.get(key);
      if (!fk) {
        fk = {
          name: showCol(row, "fk_name"),
          schema: parentSchema,
          table: showCol(row, "fk_table_name"),
          columns: [],
          refSchema,
          refTable: showCol(row, "pk_table_name"),
          refColumns: [],
        };
        fkByKey.set(key, fk);
        foreignKeys.push(fk);
      }
      fk.columns.push(showCol(row, "fk_column_name"));
      fk.refColumns.push(showCol(row, "pk_column_name"));
    }

    return { tables, foreignKeys };
  }

  /** All columns in the database, for LSP completion. Structural seam mirroring MssqlAdapter's. */
  async listAllColumns(): Promise<
    Array<{ schema: string; table: string; column: string; type: string; isPrimaryKey: boolean }>
  > {
    const db = this.dialect.escapeIdent(this.database);
    const rows = await this.query<Record<string, unknown>>(
      `SELECT c.TABLE_SCHEMA, c.TABLE_NAME, c.COLUMN_NAME, c.DATA_TYPE
       FROM ${db}.INFORMATION_SCHEMA.COLUMNS c
       WHERE c.TABLE_SCHEMA <> 'INFORMATION_SCHEMA'
       ORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION`,
    );
    const pkCols = new Set(
      (await this.showKeys("PRIMARY")).map(
        (r) => `${showCol(r, "schema_name")}.${showCol(r, "table_name")}.${showCol(r, "column_name")}`,
      ),
    );
    return rows.map((row) => ({
      schema: String(row.TABLE_SCHEMA),
      table: String(row.TABLE_NAME),
      column: String(row.COLUMN_NAME),
      type: typeNameOf(String(row.DATA_TYPE)),
      isPrimaryKey: pkCols.has(`${String(row.TABLE_SCHEMA)}.${String(row.TABLE_NAME)}.${String(row.COLUMN_NAME)}`),
    }));
  }

  // Traces: BASED-TABLE-COMMIT — all-or-nothing writes. Snowflake has no transaction object in the
  // driver, so the transaction is explicit statements on one connection; every command must run on
  // that same connection, which is why this doesn't go through the per-call query() helper.
  async runCommands(commands: DbCommand[]): Promise<CommandResult> {
    return this.withConnection(async (conn) => {
      const run = (sqlText: string, binds: Array<string | number | boolean | null> = []): Promise<Statement> =>
        new Promise((resolve, reject) => {
          conn.execute({ sqlText, binds, complete: (err, stmt) => (err ? reject(err) : resolve(stmt)) });
        });

      await run("BEGIN");
      const rowsAffected: number[] = [];
      try {
        for (const cmd of commands) {
          const binds: Array<string | number | boolean | null> = [];
          for (const p of cmd.params ?? []) {
            if (p.value !== null && typeof p.value === "object") {
              throw new Error(`Cannot bind binary/complex value for parameter ${p.name}`);
            }
            binds.push(p.value);
          }
          const stmt = await run(cmd.sql, binds);
          rowsAffected.push(stmt.getNumUpdatedRows() ?? 0);
        }
        await run("COMMIT");
        return { rowsAffected, error: null };
      } catch (err) {
        try {
          await run("ROLLBACK");
        } catch {
          // the statement may already have aborted the transaction; the original error is what matters
        }
        return { rowsAffected: [], error: errMessage(err) };
      }
    });
  }

  // Traces: BASED-QUERY-STREAM — Snowflake has no GO separator, so the editor text is ONE statement
  // (splitBatches is deliberately not reused here). Rows stream through the same RowCollector +
  // serializeRow path every engine uses, and cancel() rides statement.cancel().
  execute(sqlText: string, onChunk: (chunk: QueryChunk) => void, opts: ExecuteOptions = {}): QueryExecution {
    let cancelled = false;
    let errored = false;
    let statement: Statement | null = null;
    const start = performance.now();

    if (opts.capturePlan || opts.captureStats) {
      onChunk({
        type: "message",
        text: "Plan/stats capture is not available on Snowflake — run EXPLAIN or query QUERY_HISTORY instead.",
      });
    }

    const completion = (async () => {
      try {
        await this.withConnection(
          (conn) =>
            new Promise<void>((resolve, reject) => {
              const stmt = conn.execute({
                sqlText,
                streamResult: true,
                complete: (err, s) => {
                  if (err) {
                    // A retryable failure must reject so withConnection rebuilds and retries; a SQL
                    // error is the user's and is reported as a chunk, not thrown.
                    if (isRetryableSnowflakeError(err)) return reject(err);
                    errored = true;
                    // `line` is present on Snowflake syntax errors but absent from the SDK's
                    // published error type, so it is read structurally rather than declared.
                    const e = err as SnowflakeError & { line?: unknown };
                    onChunk({
                      type: "error",
                      message: errMessage(err),
                      line: typeof e.line === "number" ? e.line : undefined,
                      code: typeof e.code === "number" ? e.code : undefined,
                    });
                    return resolve();
                  }
                  statement = s;
                  const cols = s.getColumns() ?? [];
                  if (cols.length === 0) {
                    // DML/DDL: no result set, just an affected-row count.
                    const n = s.getNumUpdatedRows();
                    if (n != null) onChunk({ type: "message", text: `(${n} row${n === 1 ? "" : "s"} affected)` });
                    return resolve();
                  }
                  const columns: ColumnInfo[] = cols.map((c, i) => ({
                    name: c.getName() || `(col ${i + 1})`,
                    type: typeNameOf(c.getType()),
                  }));
                  onChunk({ type: "resultset", columns });
                  const collector = new RowCollector(
                    (rows) => onChunk({ type: "rows", rows }),
                    opts.rowCap ?? this.rowCap,
                  );
                  const stream = s.streamRows();
                  stream.on("data", (row: Record<string, unknown>) => {
                    if (cancelled) return;
                    collector.push(serializeRow(columns.map((c) => row[c.name])));
                  });
                  stream.on("error", (streamErr: unknown) => {
                    errored = true;
                    onChunk({ type: "error", message: errMessage(streamErr) });
                    const { rowCount, truncated } = collector.finish();
                    onChunk({ type: "resultsetEnd", rowCount, truncated });
                    resolve();
                  });
                  stream.on("end", () => {
                    const { rowCount, truncated } = collector.finish();
                    onChunk({ type: "resultsetEnd", rowCount, truncated });
                    resolve();
                  });
                },
              });
              statement = stmt;
            }),
        );
      } catch (err) {
        errored = true;
        onChunk({ type: "error", message: errMessage(err) });
      }
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
          statement?.cancel();
        } catch {
          // statement may already be complete
        }
      },
      completion,
    };
  }
}
