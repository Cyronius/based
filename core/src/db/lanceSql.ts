// Traces: BASED-LANCE-SQL
// SQL over local LanceDB directories, via an embedded DuckDB with the `lance` core extension.
// DuckDB scans the .lance files directly (`ATTACH ... (TYPE lance)`) — real SELECT/JOIN/GROUP BY
// with predicate pushdown, no materialization through JS. One bridge per adapter instance, created
// lazily on first SQL use: the extension downloads from extensions.duckdb.org on first ever use,
// so merely connecting/browsing must never require network. `@duckdb/node-api` is dynamic-imported
// here and nowhere else (BASED-LAZY-ENGINES).
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RowCollector } from "./rowcap";
import { serializeLanceValue } from "./lanceSerialize";
import { serializeValue } from "./serialize";
import { duckStatsMessage, extractDuckPlanTree, type DuckProfileNode } from "./duckProfile";
import type { ColumnInfo, ExecuteOptions, QueryChunk, QueryExecution, WireValue } from "./types";

type DuckDbModule = typeof import("@duckdb/node-api");
type DuckDBInstance = InstanceType<DuckDbModule["DuckDBInstance"]>;
type DuckDBConnection = Awaited<ReturnType<DuckDBInstance["connect"]>>;

export interface LanceSqlSource {
  /** Root local directory of the connection (a LanceDB database, or a base folder of them). */
  dir: string;
  /** Base-folder subfolder names (the "schemas" the explorer shows), or null for a single-db dir. */
  folders: string[] | null;
}

/** DuckDB/extension bootstrap failed (napi load, INSTALL/LOAD, ATTACH). The message is user-facing. */
export class LanceSqlSetupError extends Error {}

function errMessage(err: unknown): string {
  if (!err) return "Unknown error";
  const e = err as { message?: string };
  return e.message ?? String(err);
}

function sqlStringLiteral(s: string): string {
  return `'${s.replaceAll("'", "''")}'`;
}

function quoteIdent(name: string): string {
  if (name.includes('"')) throw new LanceSqlSetupError(`Cannot attach LanceDB folder "${name}": names containing a double quote are not supported.`);
  return `"${name}"`;
}

export class LanceSqlBridge {
  private init: Promise<{ duckdb: DuckDbModule; instance: DuckDBInstance; internal: DuckDBConnection }> | null = null;
  private closed = false;

  constructor(
    private readonly source: LanceSqlSource,
    private readonly rowCap: number,
  ) {}

  /** Boot DuckDB + lance extension + ATTACH. Memoized so concurrent first-runs share one boot; a
   *  failed boot is NOT cached (the user may fix their network and retry). */
  private ensureInit(): Promise<{ duckdb: DuckDbModule; instance: DuckDBInstance; internal: DuckDBConnection }> {
    if (this.closed) return Promise.reject(new LanceSqlSetupError("This connection has been closed."));
    if (this.init) return this.init;
    this.init = (async () => {
      const duckdb = await import("@duckdb/node-api");
      // In the bundled shell, @duckdb/node-api is CJS: if its first load threw (e.g. the native
      // binding's LoadLibrary failed), a retry gets the cached, partially-initialized exports back
      // instead of a rethrow — an empty namespace that would surface as the baffling "undefined is
      // not an object (evaluating 'duckdb.DuckDBInstance.create')". Name the real problem instead.
      if (typeof duckdb.DuckDBInstance?.create !== "function") {
        throw new LanceSqlSetupError(
          "DuckDB failed to initialize — its native binding did not load (the original error was reported on the first attempt this session). Restart the app and retry.",
        );
      }
      const instance = await duckdb.DuckDBInstance.create(":memory:");
      const internal = await instance.connect();
      try {
        try {
          await internal.run("INSTALL lance; LOAD lance;");
        } catch (err) {
          throw new LanceSqlSetupError(
            `Could not load the DuckDB Lance extension (it downloads from extensions.duckdb.org into %USERPROFILE%\\.duckdb on first use — check network access): ${errMessage(err)}`,
          );
        }
        // ATTACH is instance-scoped: every later connection on this instance sees the catalog.
        // (USE is NOT — it's session state, so newConnection() re-applies it per query connection.)
        if (this.source.folders) {
          for (const folder of this.source.folders) {
            await internal.run(`ATTACH ${sqlStringLiteral(join(this.source.dir, folder))} AS ${quoteIdent(folder)} (TYPE lance)`);
          }
        } else {
          await internal.run(`ATTACH ${sqlStringLiteral(this.source.dir)} AS db (TYPE lance); USE db;`);
        }
        return { duckdb, instance, internal };
      } catch (err) {
        try {
          internal.closeSync();
        } catch {
          // best-effort
        }
        try {
          instance.closeSync();
        } catch {
          // best-effort
        }
        throw err instanceof LanceSqlSetupError ? err : new LanceSqlSetupError(errMessage(err));
      }
    })();
    // Un-memoize failures so the next run retries the boot.
    this.init.catch(() => {
      this.init = null;
    });
    return this.init;
  }

  /** Force the boot (used by the LSP server so its first completion sees the attached catalog). */
  async ensureReady(): Promise<void> {
    await this.ensureInit();
  }

  /** A fresh connection on the shared instance, with per-session state (USE) re-applied: in
   *  single-db mode bare table names must resolve to the attached db, matching the explorer. */
  private async newConnection(): Promise<DuckDBConnection> {
    const { instance } = await this.ensureInit();
    const conn = await instance.connect();
    if (!this.source.folders) await conn.run("USE db;");
    return conn;
  }

  /** Monotonic id so concurrent capture runs (same pid) never collide on a profile file name. */
  private static profileSeq = 0;
  private static nextProfileId(): number {
    return ++LanceSqlBridge.profileSeq;
  }

  /** Turn on DuckDB JSON profiling to `path` for this connection. The next queries' actual runtime
   *  profile (operator tree + timing/cardinality) is written to the file as each one completes. */
  private async enableProfiling(conn: DuckDBConnection, path: string): Promise<void> {
    await conn.run("SET enable_profiling='json'");
    await conn.run("SET profiling_mode='standard'");
    // DuckDB paths use forward slashes even on Windows; the literal is single-quote escaped.
    await conn.run(`SET profiling_output=${sqlStringLiteral(path.split("\\").join("/"))}`);
  }

  /** Read the just-flushed profile for the statement that completed and emit the requested capture
   *  chunks: the operator tree as a `plan` chunk (Execution Plan graph) and/or a client-statistics
   *  summary as a `message` chunk (Output pane). Silently no-ops if the file is missing or unparseable. */
  private emitProfile(path: string, onChunk: (chunk: QueryChunk) => void, opts: ExecuteOptions): void {
    let profile: DuckProfileNode;
    try {
      profile = JSON.parse(readFileSync(path, "utf8")) as DuckProfileNode;
    } catch {
      return; // no profile flushed (a metadata-only query like count(*) has no pipeline) — skip
    }
    if (opts.capturePlan) {
      const json = extractDuckPlanTree(profile);
      if (json) onChunk({ type: "plan", format: "duckdb-json", json });
    }
    if (opts.captureStats) onChunk({ type: "message", text: duckStatsMessage(profile) });
  }

  /** Internal catalog/autocomplete queries for the LSP server. Values are raw DuckDBValues except
   *  bigints, which are coerced to Number (catalog counts/offsets are always in safe range). */
  async runInternal(sql: string, params?: unknown[]): Promise<{ columns: string[]; rows: unknown[][] }> {
    const { internal } = await this.ensureInit();
    const reader = await internal.runAndReadAll(sql, params as never);
    const rows = reader.getRows().map((row) => row.map((v) => (typeof v === "bigint" ? Number(v) : v)));
    return { columns: reader.columnNames(), rows };
  }

  // Streams a query through the standard QueryChunk contract (mirrors MssqlAdapter.execute). Each
  // call gets its own DuckDB connection so interrupt() only ever aborts this query.
  execute(sqlText: string, onChunk: (chunk: QueryChunk) => void, opts: ExecuteOptions = {}): QueryExecution {
    let cancelled = false;
    let errored = false;
    let conn: DuckDBConnection | null = null;
    const start = performance.now();
    // Capture path (Execution Plan / Client Statistics): DuckDB profiles the *real* run to a JSON
    // file, so results still stream from one execution. The file lives per-execute() call; profiling
    // settings die with this call's connection (closed below), so there's no leak to guard against
    // (unlike MSSQL's pooled-connection SET STATISTICS path).
    const capture = !!(opts.capturePlan || opts.captureStats);
    const profilePath = capture ? join(tmpdir(), `based-duckprofile-${process.pid}-${LanceSqlBridge.nextProfileId()}.json`) : null;

    const completion = (async () => {
      try {
        const { duckdb } = await this.ensureInit();
        conn = await this.newConnection();
        if (profilePath) await this.enableProfiling(conn, profilePath);
        const extracted = await conn.extractStatements(sqlText);
        for (let i = 0; i < extracted.count; i++) {
          if (cancelled) break;
          const ok = await this.runStatement(duckdb, extracted, i, onChunk, opts, () => cancelled, profilePath);
          if (!ok) {
            errored = true;
            break; // DuckDB has no per-statement error recovery within one script; stop like a failed batch.
          }
        }
      } catch (err) {
        if (!cancelled) {
          errored = true;
          onChunk({ type: "error", message: errMessage(err) });
        }
      } finally {
        try {
          conn?.closeSync();
        } catch {
          // best-effort
        }
        if (profilePath) {
          try {
            rmSync(profilePath, { force: true });
          } catch {
            // best-effort — a leftover temp profile is harmless
          }
        }
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
          conn?.interrupt();
        } catch {
          // connection may already be closed
        }
      },
      completion,
    };
  }

  /** Result-shape metadata shared by the streaming and capture paths: display columns plus a
   *  per-column "is a fixed-size vector" flag (drives the {$:"vec"} wire summary). */
  private columnShape(names: string[], types: unknown[]): { columns: ColumnInfo[]; isVector: boolean[] } {
    const isVector = types.map((t) => /^(FLOAT|DOUBLE)\[\d+\]$/i.test(String(t)));
    const columns: ColumnInfo[] = names.map((name, i) => ({ name: name || `(col ${i + 1})`, type: String(types[i] ?? "") }));
    return { columns, isVector };
  }

  /** Run one extracted statement, streaming its result set. Returns false on error (already emitted).
   *  Capture runs (`profilePath` set) take the materialized path instead — see runCaptured. */
  private async runStatement(
    duckdb: DuckDbModule,
    extracted: Awaited<ReturnType<DuckDBConnection["extractStatements"]>>,
    index: number,
    onChunk: (chunk: QueryChunk) => void,
    opts: ExecuteOptions,
    isCancelled: () => boolean,
    profilePath: string | null,
  ): Promise<boolean> {
    try {
      const prepared = await extracted.prepare(index);
      if (profilePath) return await this.runCaptured(duckdb, prepared, onChunk, opts, isCancelled, profilePath);
      const result = await prepared.stream();
      const names = result.columnNames();
      if (names.length === 0) return true; // statements with no result shape (SET etc.)
      const { columns, isVector } = this.columnShape(names, result.columnTypes());
      onChunk({ type: "resultset", columns });
      const cap = opts.rowCap ?? this.rowCap;
      const collector = new RowCollector((rows) => onChunk({ type: "rows", rows }), cap);
      let seen = 0;
      for (;;) {
        if (isCancelled()) break;
        const chunk = await result.fetchChunk();
        if (!chunk || chunk.rowCount === 0) break;
        for (const row of chunk.getRows()) {
          seen++;
          collector.push(row.map((v, c) => duckToWire(duckdb, v, isVector[c] ?? false)));
        }
        // Unlike MSSQL (which keeps counting the true total), stop scanning once past the cap:
        // there is no server to drain, and a Lance scan can be arbitrarily large.
        if (seen > cap) break;
      }
      const { rowCount, truncated } = collector.finish();
      onChunk({ type: "resultsetEnd", rowCount, truncated });
      const changed = result.rowsChanged;
      if (changed > 0) onChunk({ type: "message", text: `(${changed} row${changed === 1 ? "" : "s"} affected)` });
      return true;
    } catch (err) {
      if (!isCancelled()) onChunk({ type: "error", message: errMessage(err) });
      return false;
    }
  }

  /** Capture path (Execution Plan / Client Statistics on). DuckDB only flushes profiling_output for a
   *  fully-executed query, and the streamed reader never finalizes a non-blocking plan (e.g. a bare
   *  scan) — so a capture run materializes via runAndReadAll, which reliably executes the whole
   *  pipeline and writes the profile. Rows are still capped for display. A metadata-only query
   *  (e.g. `count(*)`) executes no pipeline and writes no profile; emitProfile then no-ops. */
  private async runCaptured(
    duckdb: DuckDbModule,
    prepared: Awaited<ReturnType<Awaited<ReturnType<DuckDBConnection["extractStatements"]>>["prepare"]>>,
    onChunk: (chunk: QueryChunk) => void,
    opts: ExecuteOptions,
    isCancelled: () => boolean,
    profilePath: string,
  ): Promise<boolean> {
    const reader = await prepared.runAndReadAll();
    if (isCancelled()) return true;
    const names = reader.columnNames();
    if (names.length === 0) return true;
    const { columns, isVector } = this.columnShape(names, reader.columnTypes());
    onChunk({ type: "resultset", columns });
    const cap = opts.rowCap ?? this.rowCap;
    const allRows = reader.getRows();
    const truncated = allRows.length > cap;
    const wireRows = allRows
      .slice(0, cap)
      .map((row) => row.map((v, c) => duckToWire(duckdb, v, isVector[c] ?? false)));
    if (wireRows.length > 0) onChunk({ type: "rows", rows: wireRows });
    onChunk({ type: "resultsetEnd", rowCount: wireRows.length, truncated });
    const changed = reader.rowsChanged;
    if (changed > 0) onChunk({ type: "message", text: `(${changed} row${changed === 1 ? "" : "s"} affected)` });
    // The whole query executed (materialized), so the profile is valid even when the display is
    // truncated — emit it unless the run was cancelled.
    if (!isCancelled()) this.emitProfile(profilePath, onChunk, opts);
    return true;
  }

  async close(): Promise<void> {
    this.closed = true;
    const pending = this.init;
    this.init = null;
    if (!pending) return;
    try {
      const { instance, internal } = await pending;
      try {
        internal.closeSync();
      } catch {
        // best-effort
      }
      try {
        instance.closeSync();
      } catch {
        // best-effort
      }
    } catch {
      // boot failed — nothing to close
    }
  }
}

/** Map a DuckDBValue to the JSON-safe wire form. Vector columns (fixed-size FLOAT/DOUBLE arrays —
 *  how the lance extension surfaces Lance vectors) reuse the {$:"vec"} summary so the grid renders
 *  them exactly like browse/search results (BASED-LANCE-WIRE). */
export function duckToWire(duckdb: DuckDbModule, v: unknown, isVectorCol: boolean): WireValue {
  if (v === null || v === undefined) return null;
  if (typeof v === "bigint") return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
  if (v instanceof duckdb.DuckDBArrayValue || v instanceof duckdb.DuckDBListValue) {
    return serializeLanceValue(v.items, isVectorCol);
  }
  if (v instanceof duckdb.DuckDBBlobValue) return serializeValue(v.bytes);
  if (v instanceof duckdb.DuckDBStructValue || v instanceof duckdb.DuckDBMapValue) {
    try {
      return String(v);
    } catch {
      return "[unrenderable]";
    }
  }
  // Timestamp/date/time/decimal/interval/uuid values all carry a faithful toString; scalars pass through.
  return serializeValue(v);
}
