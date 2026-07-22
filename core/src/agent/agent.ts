// Traces: BASED-AGENT-ENDPOINT, BASED-AGENT-SCHEMA-CTX, BASED-LANCE-AGENT-SURFACE, BASED-AGENT-INSTRUCTIONS-COMPOSE
// Builds the Capy agent. Constructed per request so its tools bind to the live session
// adapter; the model and memory are resolved once and passed in. The toolset + persona vary by
// engine (see ./surface.ts) — a SQL Server session and a LanceDB session get different tools.
import { Agent } from "@mastra/core/agent";
import type { LanguageModel } from "ai";
import type { Memory } from "@mastra/memory";
import type { DbEngine } from "../db/types";
import { agentSurfaceFor } from "./surface";
import { type ToolDeps } from "./tools/shared";
import { catalog as skillCatalog } from "./skills";

export const AGENT_ID = "capy";

/** Engine-neutral core: identity, the work-from-real-schema discipline, and output format. Every
 *  engine's persona fragment is appended after this. */
export const GENERIC_CORE = `You are "Capy" — an assistant embedded in a database client, living in the right-hand rail next to the user's query editor. You help the user understand their database and work with its data.

Ground rules:
- Work from the actual schema. Call get_schema to list objects, or get_schema with a table name to see its columns, before making claims about tables you have not inspected. Never invent table or column names.
- You only ever see schema and, when you explicitly ask for them, small samples of rows. You do not have the full data.
- Answer in concise markdown. Explain briefly what a query or search does; don't narrate every tool call.`;

/** Compose the system prompt: core + the engine's persona + the (engine-filtered) skill
 *  catalog + the load-a-skill-first protocol. Only each skill's name+description is advertised here;
 *  the body is pulled on demand via load_skill. `core` defaults to GENERIC_CORE but is user-overridable
 *  (BASED-AGENT-INSTRUCTIONS). */
export function agentInstructions(core: string, persona: string, skillTags?: DbEngine[]): string {
  const catalogText = skillCatalog(skillTags)
    .map((s) => `- ${s.name}: ${s.description}`)
    .join("\n");
  const skillsBlock = catalogText
    ? `\n\nSkills — extra capabilities you can pull in on demand. When a request matches a skill below, call the load_skill tool with its name to get the full instructions BEFORE acting on it; then follow them.\n${catalogText}`
    : "";
  return `${core}

${persona}${skillsBlock}`;
}

export function buildAgent(opts: {
  model: LanguageModel;
  memory: Memory;
  engine: DbEngine;
  toolDeps: ToolDeps;
  /** Override for the engine-neutral core (BASED-AGENT-INSTRUCTIONS); defaults to GENERIC_CORE. */
  core?: string;
  /** Override for the engine's persona fragment; defaults to the engine surface's persona. */
  persona?: string;
}): Agent {
  const surface = agentSurfaceFor(opts.engine, opts.toolDeps);
  return new Agent({
    id: AGENT_ID,
    name: "based capy",
    instructions: agentInstructions(opts.core ?? GENERIC_CORE, opts.persona ?? surface.persona, surface.skillTags),
    // `as never`: the AI SDK model spec and Mastra's bundled copy are structurally identical but
    // nominally distinct across package boundaries (version skew) — runtime-compatible (spike-proven).
    model: opts.model as never,
    tools: surface.tools as never,
    memory: opts.memory as never,
  });
}
