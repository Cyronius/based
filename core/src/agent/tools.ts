// Back-compat shim. The agent toolset is now assembled from the connection's live
// EngineCapabilities (see ./surface.ts); the tools themselves live in ./tools/{shared,lancedb}.ts.
// This module preserves the original buildAgentTools/ToolDeps entry points, which return the SQL
// Server toolset.
import { sharedTools, type ToolDeps } from "./tools/shared";
import { defaultCapabilitiesFor, descriptorFor } from "../engines/registry";

export type { ToolDeps };

/** The SQL Server agent toolset. Prefer agentSurfaceFor with the live adapter's capabilities. */
export function buildAgentTools(deps: ToolDeps) {
  return sharedTools(deps, defaultCapabilitiesFor("mssql"), descriptorFor("mssql").agentProse);
}
