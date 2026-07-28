// Traces: BASED-LANCE-ENGINE, BASED-CONN-TEST, BASED-LAZY-ENGINES, BASED-ENGINE-REGISTRY
// Adapter construction now resolves through the engine registry (../engines/registry), so this file
// no longer holds a switch: every consumer holds the DatabaseAdapter interface, never a concrete
// class, and adding an engine is adding a descriptor rather than editing here. engineOf remains the
// back-compat seam — legacy configs have no `engine` field and must keep behaving as MSSQL.
import { createAdapterFor, engineOf } from "../engines/registry";
import type { SecretProvider } from "./entra";
import type { ConnectionConfig, DatabaseAdapter, TestResult } from "./types";

export { engineOf };

/** Build the adapter for a connection. `transientSecret` (used by the test path) overrides the stored
 *  secret for this instance only — never persisted. */
export function createAdapter(
  cfg: ConnectionConfig,
  getSecret: SecretProvider,
  opts?: { database?: string; transientSecret?: string },
): Promise<DatabaseAdapter> {
  return createAdapterFor(cfg, getSecret, opts);
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
