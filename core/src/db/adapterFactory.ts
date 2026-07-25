// Traces: BASED-LANCE-ENGINE, BASED-CONN-TEST, BASED-LAZY-ENGINES
// The single place that maps a ConnectionConfig to a concrete DatabaseAdapter. Every consumer holds
// the DatabaseAdapter interface, never a concrete class — so adding an engine is adding a case here,
// not editing call sites. engineOf is the back-compat seam: legacy configs have no `engine` field and
// must keep behaving as MSSQL. Adapter modules are dynamic-imported per branch so an engine's native
// stack (tedious, @lancedb napi, DuckDB) only loads when a connection of that engine is opened.
import type { SecretProvider } from "./entra";
import type { ConnectionConfig, DatabaseAdapter, DbEngine, TestResult } from "./types";

/** The engine a config targets. Absent `engine` (every pre-LanceDB connection) means "mssql". */
export function engineOf(cfg: ConnectionConfig): DbEngine {
  return cfg.engine ?? "mssql";
}

/** Build the adapter for a connection. `transientSecret` (used by the test path) overrides the stored
 *  secret for this instance only — never persisted. */
export async function createAdapter(
  cfg: ConnectionConfig,
  getSecret: SecretProvider,
  opts?: { database?: string; transientSecret?: string },
): Promise<DatabaseAdapter> {
  const secretProvider: SecretProvider =
    opts?.transientSecret != null ? () => opts.transientSecret ?? null : getSecret;
  switch (engineOf(cfg)) {
    case "mssql": {
      const { MssqlAdapter } = await import("./mssqlAdapter");
      return new MssqlAdapter(cfg, secretProvider, { database: opts?.database });
    }
    case "lancedb": {
      const { LanceDbAdapter } = await import("./lanceAdapter");
      return new LanceDbAdapter(cfg, secretProvider, { database: opts?.database });
    }
  }
}

// Traces: BASED-CONN-TEST — engine-agnostic: build the adapter, run its own probe, tear down.
export async function testConnection(
  cfg: ConnectionConfig,
  getSecret: SecretProvider,
  transientSecret?: string,
): Promise<TestResult> {
  let adapter: DatabaseAdapter;
  try {
    adapter = await createAdapter(cfg, getSecret, { transientSecret });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  return adapter.probe();
}
