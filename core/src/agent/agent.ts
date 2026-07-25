// Traces: BASED-AGENT-ENDPOINT, BASED-AGENT-SCHEMA-CTX, BASED-LANCE-AGENT-SURFACE, BASED-AGENT-INSTRUCTIONS-COMPOSE, BASED-AGENT-MULTISTEP
// Builds the Capi agent. Constructed per request so its tools bind to the live session
// adapter; the model and memory are resolved once and passed in. The toolset + persona vary by
// engine (see ./surface.ts) — a SQL Server session and a LanceDB session get different tools.
import { Agent } from "@mastra/core/agent";
import type { LanguageModel } from "ai";
import type { Memory } from "@mastra/memory";
import type { DbEngine } from "../db/types";
import { agentSurfaceFor } from "./surface";
import { type ToolDeps } from "./tools/shared";
import { catalog as skillCatalog } from "./skills";
import type { ExecutionDefaults } from "./provider";

export const AGENT_ID = "capi";

// Traces: BASED-AGENT-MULTISTEP — the AG-UI bridge calls agent.stream() with no maxSteps/stopWhen,
// so Mastra's implicit stepCountIs(5) would end a schema-audit run right after its 5th round of tool
// calls with no final assistant message. Agent-config defaultOptions deep-merge under per-call
// options, so this is the value that actually governs the loop.
export const AGENT_MAX_STEPS = 30;

/** Engine-neutral core: identity, the work-from-real-schema discipline, and output format. Every
 *  engine's persona fragment is appended after this. */
export const GENERIC_CORE = `You are "Capi" — an assistant embedded in a database client, living in the right-hand rail next to the user's query editor. You help the user understand their database and work with its data.

Ground rules:
- Work from the actual schema. Call get_schema to list objects, or get_schema with a table name to see its columns, before making claims about tables you have not inspected. Never invent table or column names.
- You only ever see schema and, when you explicitly ask for them, small samples of rows. You do not have the full data. To read more than a sample, page with read_rows (offset/limit) rather than pulling a whole table.
- You live next to the user's tab strip. When a <workspace_context> block is present it describes the active tab (its SQL and results) and every open tab; treat the active tab as the default subject of the conversation, and use list_tabs / get_tab to read another tab's SQL or results when the user refers to it.
- When the user asks to SEE data ("show me…", "list the…"), call open_query_tab so the results land in a real results grid — do not paste large row sets into chat. run_query/read_rows are for your own analysis; keep their raw output out of your answer unless it is small.
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
  /** Per-profile model params split into Mastra execution defaults (BASED-AI-PROFILE-PARAMS). */
  executionDefaults?: ExecutionDefaults;
  /** Per-run workspace snapshot (rendered <workspace_context> block, BASED-AGENT-TAB-CONTEXT),
   *  appended after the composed instructions. Omitted → instructions identical to before. */
  contextNote?: string;
}): Agent {
  const surface = agentSurfaceFor(opts.engine, opts.toolDeps);
  const { modelSettings, providerOptions } = opts.executionDefaults ?? {};
  const baseInstructions = agentInstructions(opts.core ?? GENERIC_CORE, opts.persona ?? surface.persona, surface.skillTags);
  return new Agent({
    id: AGENT_ID,
    name: "based capi",
    instructions: opts.contextNote ? `${baseInstructions}\n\n${opts.contextNote}` : baseInstructions,
    // `as never`: the AI SDK model spec and Mastra's bundled copy are structurally identical but
    // nominally distinct across package boundaries (version skew) — runtime-compatible (spike-proven).
    model: opts.model as never,
    tools: surface.tools as never,
    memory: opts.memory as never,
    defaultOptions: {
      maxSteps: AGENT_MAX_STEPS,
      ...(modelSettings ? { modelSettings: modelSettings as never } : {}),
      ...(providerOptions ? { providerOptions: providerOptions as never } : {}),
    },
  });
}
