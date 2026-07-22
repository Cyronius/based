// Back-compat shim. The agent toolset is now assembled per engine (see ./surface.ts); the tools
// themselves live in ./tools/{shared,mssql,lancedb}.ts. This module preserves the original
// buildAgentTools/ToolDeps entry points, which return the SQL Server toolset.
import { sharedTools, type ToolDeps } from "./tools/shared";
import { mssqlTools } from "./tools/mssql";

export type { ToolDeps };

/** The SQL Server agent toolset (shared + MSSQL tools). Prefer agentSurfaceFor for new code. */
export function buildAgentTools(deps: ToolDeps) {
  return { ...sharedTools(deps), ...mssqlTools(deps) };
}
