// Traces: BASED-LANCE-AGENT-SURFACE, BASED-AGENT-SURFACE-VARIANT, BASED-AGENT-DELEGATE
// The agent surface is a property of the CONNECTION, not just the engine: which tools the AI can
// call, the persona describing how to use them, and which skills apply. Tool *names* are stable
// across engines and variants — a chat thread stays coherent when the user switches connections,
// and the model never learns three names for one concept. What varies is each tool's parameter list
// and description, both generated from EngineCapabilities so every sentence is unconditionally true
// for the connection it was generated for.
//
// A capability the connection lacks means the tool (or the parameter) is ABSENT, not present-and-
// refusing. A tool the model can see is a tool it will eventually offer the user.
import type { DbEngine, EngineCapabilities } from "../db/types";
import { sharedTools, type ToolDeps } from "./tools/shared";
import { mssqlBriefing, MSSQL_PERSONA } from "./tools/mssql";
import { lanceTools, lanceBriefing, LANCE_PERSONA } from "./tools/lancedb";

/** Mastra ToolSet shape kept loose here so this module (and db/types) need not depend on mastra. */
export type ToolSet = Record<string, unknown>;

export interface EngineAgentSurface {
  tools: ToolSet;
  /** Traces: BASED-AGENT-INSTRUCTIONS — generated facts about this connection: which tools exist,
   *  what it can't do, how to qualify a table. Injected between the core and the persona and NEVER
   *  user-editable, because a fact that can be forked into a fixed string is a fact that can go
   *  stale against the connection it describes. */
  briefing: string;
  /** The built-in editable half: voice and policy, deliberately variant-neutral. A user's custom
   *  instruction set replaces this and only this, so forking it can never cost them the briefing. */
  persona: string;
  /** Skill catalog tags this engine opts into; undefined = only universal (untagged) skills. */
  skillTags?: DbEngine[];
}

/** Traces: BASED-AGENT-DELEGATE — appended to the briefing, never to the persona, for the same
 *  reason every other generated fact is: a persona can be forked into a fixed string by the user,
 *  and a forked fact goes stale. It states the one thing the model reliably gets wrong about a
 *  subagent — that it is NOT a second copy of Capi, and reaches nothing on the client. */
const DELEGATION_BRIEFING = `Delegation: you can hand self-contained investigation tasks to subagents with the delegate tool. A subagent runs on this same connection with these same database tools, but it is not you: it cannot see this conversation, the workspace, or any tool result you already hold, and it has none of the tools that reach the user's screen (show_results, list_tabs, get_tab, open_query_tab, run_mutation, import_csv). It reports back a summary and, when useful, artifacts — including queries it validated, which you can hand to show_results yourself. Delegate when the digging would cost you more context than the answer is worth; do it yourself when it's a call or two.`;

/** Assemble the agent surface for a live connection, binding tools to the session via `deps`. */
export function agentSurfaceFor(caps: EngineCapabilities, deps: ToolDeps): EngineAgentSurface {
  const core = sharedTools(deps, caps);
  const withDelegation = (briefing: string) =>
    deps.runSubagent ? `${briefing}\n\n${DELEGATION_BRIEFING}` : briefing;
  if (caps.engine === "mssql") {
    return { tools: core, briefing: withDelegation(mssqlBriefing(caps)), persona: MSSQL_PERSONA };
  }
  return {
    tools: { ...core, ...lanceTools(deps, caps) },
    briefing: withDelegation(lanceBriefing(caps)),
    persona: LANCE_PERSONA,
    skillTags: ["lancedb"],
  };
}

/** The capability object a bare engine name implies, for callers that have no live adapter (tests,
 *  the back-compat shim). Real sessions always pass the adapter's own `capabilities`, which is the
 *  only thing that knows cloud from local from base-folder. */
export function defaultCapabilitiesFor(engine: DbEngine): EngineCapabilities {
  return engine === "mssql"
    ? {
        sql: true,
        search: false,
        write: true,
        orderedBrowse: true,
        script: true,
        relations: true,
        engine: "mssql",
        variant: "mssql",
        containers: null,
        wherePredicate: false,
        structuredFilters: true,
        countRows: true,
        takeByKey: false,
        indexIntrospect: true,
      }
    : {
        sql: true,
        search: true,
        write: false,
        orderedBrowse: false,
        script: false,
        relations: false,
        engine: "lancedb",
        variant: "lancedb-local",
        containers: null,
        wherePredicate: true,
        structuredFilters: false,
        countRows: true,
        takeByKey: true,
        indexIntrospect: true,
      };
}
