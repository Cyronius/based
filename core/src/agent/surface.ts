// Traces: BASED-LANCE-AGENT-SURFACE
// The agent surface is a property of the engine: which tools the AI can call, the persona fragment
// describing how to use them, and which skills apply. Toolsets deliberately DO NOT match across
// engines — SQL Server exposes run_query/sample_rows; LanceDB exposes vector/text/hybrid search.
import type { DbEngine } from "../db/types";
import { sharedTools, type ToolDeps } from "./tools/shared";
import { mssqlTools, MSSQL_PERSONA } from "./tools/mssql";
import { lanceTools, LANCE_PERSONA } from "./tools/lancedb";

/** Mastra ToolSet shape kept loose here so this module (and db/types) need not depend on mastra. */
export type ToolSet = Record<string, unknown>;

export interface EngineAgentSurface {
  tools: ToolSet;
  /** System-prompt fragment injected after the generic core. */
  persona: string;
  /** Skill catalog tags this engine opts into; undefined = only universal (untagged) skills. */
  skillTags?: DbEngine[];
}

/** Assemble the agent surface for an engine, binding tools to the live session via `deps`. */
export function agentSurfaceFor(engine: DbEngine, deps: ToolDeps): EngineAgentSurface {
  switch (engine) {
    case "mssql":
      return { tools: { ...sharedTools(deps), ...mssqlTools(deps) }, persona: MSSQL_PERSONA };
    case "lancedb":
      return {
        tools: { ...sharedTools(deps), ...lanceTools(deps) },
        persona: LANCE_PERSONA,
        skillTags: ["lancedb"],
      };
  }
}
