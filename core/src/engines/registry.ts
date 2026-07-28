// Traces: BASED-ENGINE-REGISTRY, BASED-LAZY-ENGINES
// The single map from engine id to descriptor. This is the ONE place that knows every engine
// exists; everything else asks the registry rather than branching. Adding an engine is:
//   1. add the id to DbEngine in db/types.ts
//   2. write engines/<id>.ts
//   3. add the line here — the Record<DbEngine, …> annotation makes step 3 a compile error
//      until it is done, which is the property the old `if (engine === "mssql") … else <lancedb>`
//      fallthroughs did not have.
// Importing this module must stay free of native stacks: descriptors hold adapter *loaders*, and
// the dynamic import inside each one is not evaluated here.
import type { ConnectionConfig, DatabaseAdapter, DbEngine, EngineCapabilities } from "../db/types";
import type { SecretProvider } from "../db/entra";
import type { EngineDescriptor, EngineProfile } from "./descriptor";
import { MSSQL_ENGINE } from "./mssql";
import { LANCEDB_ENGINE } from "./lancedb";
import { SNOWFLAKE_ENGINE } from "./snowflake";

export const ENGINES: Record<DbEngine, EngineDescriptor> = {
  mssql: MSSQL_ENGINE,
  lancedb: LANCEDB_ENGINE,
  snowflake: SNOWFLAKE_ENGINE,
};

/** Every engine id, in registration order. */
export const ENGINE_IDS = Object.keys(ENGINES) as DbEngine[];

/** The engine a config targets. Absent `engine` (every pre-LanceDB connection) means "mssql". */
export function engineOf(cfg: { engine?: DbEngine }): DbEngine {
  return cfg.engine ?? "mssql";
}

export function descriptorFor(engine: DbEngine): EngineDescriptor {
  const descriptor = ENGINES[engine];
  if (!descriptor) throw new Error(`Unknown engine "${engine}"`);
  return descriptor;
}

export function descriptorForConfig(cfg: { engine?: DbEngine }): EngineDescriptor {
  return descriptorFor(engineOf(cfg));
}

/** Traces: BASED-ENGINE-PROFILE-WIRE — the JSON the webview renders connection forms from, so the
 *  UI never holds a hand-mirrored copy of the engine list to drift against. */
export function engineProfiles(): EngineProfile[] {
  return ENGINE_IDS.map((id) => ENGINES[id].profile);
}

/** The capability object a bare engine name implies, for callers with no live adapter (tests, the
 *  back-compat shim). Real sessions always pass the adapter's own capabilities, which is the only
 *  thing that knows cloud from local from base-folder. */
export function defaultCapabilitiesFor(engine: DbEngine): EngineCapabilities {
  return descriptorFor(engine).profile.defaultCapabilities;
}

/** Build the adapter for a connection. `transientSecret` (used by the test path) overrides the
 *  stored secret for this instance only — never persisted. */
export function createAdapterFor(
  cfg: ConnectionConfig,
  getSecret: SecretProvider,
  opts?: { database?: string; transientSecret?: string },
): Promise<DatabaseAdapter> {
  const secretProvider: SecretProvider =
    opts?.transientSecret != null ? () => opts.transientSecret ?? null : getSecret;
  return descriptorForConfig(cfg).loadAdapter(cfg, secretProvider, { database: opts?.database });
}
