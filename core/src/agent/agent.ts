// Traces: BASED-AGENT-ENDPOINT, BASED-AGENT-SCHEMA-CTX, BASED-LANCE-AGENT-SURFACE, BASED-AGENT-INSTRUCTIONS-COMPOSE, BASED-AGENT-MULTISTEP
// Builds the Capi agent. Constructed per request so its tools bind to the live session
// adapter; the model and memory are resolved once and passed in. The toolset + persona vary by
// engine (see ./surface.ts) — a SQL Server session and a LanceDB session get different tools.
import { Agent } from "@mastra/core/agent";
import type { LanguageModel } from "ai";
import type { Memory } from "@mastra/memory";
import type { DbEngine, EngineCapabilities } from "../db/types";
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
- Your tools are generated for THIS connection: everything you can see, you can use here, and anything absent is genuinely unavailable — don't apologize for a tool you weren't given or assume a capability you can't see. When you're unsure what this connection supports, call get_connection_info; it is cheap and exact.
- Work from the actual schema. Call list_objects to see what exists, and describe_table before making claims about a table you have not inspected. Never invent table or column names.
- You only ever see schema and, when you explicitly ask for them, small samples of rows. You do not have the full data. To read more than a sample, page with read_table (offset/limit) rather than pulling a whole table, and call count_rows first when the scale matters.
- You live next to the user's tab strip. When a <workspace_context> block is present it describes the active tab (its SQL and results) and every open tab; treat the active tab as the default subject of the conversation, and use list_tabs / get_tab to read another tab's SQL or results when the user refers to it.
- When the user asks to SEE data ("show me…", "list the…"), call show_results so the rows land in a real results grid — do not paste large row sets into chat. run_query/read_table are for your own analysis; keep their raw output out of your answer unless it is small.
- Answer in concise markdown. Explain briefly what a query or search does; don't narrate every tool call.`;

/** Compose the system prompt: core + the connection's capability briefing + the persona + the
 *  (engine-filtered) skill catalog. Only each skill's name+description is advertised here; the body
 *  is pulled on demand via load_skill.
 *
 *  Traces: BASED-AGENT-INSTRUCTIONS — `core` and `persona` are user-overridable; `briefing` is not.
 *  The briefing states what this connection *is* (generated per variant), the persona states how to
 *  behave (a fixed string, safe to fork because nothing in it varies by connection). Keeping them
 *  separate is what lets a user rewrite the agent's voice without pinning stale claims about a
 *  connection they weren't looking at when they wrote it. `briefing` is optional so callers that
 *  compose only core+persona (tests, previews) keep working. */
export function agentInstructions(core: string, persona: string, skillTags?: DbEngine[], briefing?: string): string {
  const catalogText = skillCatalog(skillTags)
    .map((s) => `- ${s.name}: ${s.description}`)
    .join("\n");
  const skillsBlock = catalogText
    ? `\n\nSkills — extra capabilities you can pull in on demand. When a request matches a skill below, call the load_skill tool with its name to get the full instructions BEFORE acting on it; then follow them.\n${catalogText}`
    : "";
  const briefingBlock = briefing ? `\n\n${briefing}` : "";
  return `${core}${briefingBlock}

${persona}${skillsBlock}`;
}

export function buildAgent(opts: {
  model: LanguageModel;
  /** Traces: BASED-AGENT-DELEGATE-ISOLATION — omitted for a subagent run, which is how a child's
   *  work is kept out of the tab's thread: with no memory there is nothing to persist and nothing
   *  to clean up afterwards. Every user-facing run passes one. */
  memory?: Memory;
  /** The live adapter's capabilities — the only thing that knows cloud from local from base-folder.
   *  Callers with no adapter can use defaultCapabilitiesFor(engine). */
  capabilities: EngineCapabilities;
  toolDeps: ToolDeps;
  /** Override for the engine-neutral core (BASED-AGENT-INSTRUCTIONS); defaults to GENERIC_CORE. */
  core?: string;
  /** Override for the engine's persona — voice and policy only. The capability briefing is NOT
   *  overridable and is always injected, so a custom persona can never leave the agent with stale
   *  claims about what this connection can do. */
  persona?: string;
  /** Per-profile model params split into Mastra execution defaults (BASED-AI-PROFILE-PARAMS). */
  executionDefaults?: ExecutionDefaults;
  /** Per-run workspace snapshot (rendered <workspace_context> block, BASED-AGENT-TAB-CONTEXT),
   *  appended after the composed instructions. Omitted → instructions identical to before. */
  contextNote?: string;
  /** Per-profile tool-step budget (BASED-AI-PROFILE-STEPCAP); absent/invalid → AGENT_MAX_STEPS. */
  maxSteps?: number;
}): Agent {
  const surface = agentSurfaceFor(opts.capabilities, opts.toolDeps);
  const { modelSettings, providerOptions } = opts.executionDefaults ?? {};
  const baseInstructions = agentInstructions(
    opts.core ?? GENERIC_CORE,
    opts.persona ?? surface.persona,
    surface.skillTags,
    surface.briefing,
  );
  return new Agent({
    id: AGENT_ID,
    name: "based capi",
    instructions: opts.contextNote ? `${baseInstructions}\n\n${opts.contextNote}` : baseInstructions,
    // `as never`: the AI SDK model spec and Mastra's bundled copy are structurally identical but
    // nominally distinct across package boundaries (version skew) — runtime-compatible (spike-proven).
    model: opts.model as never,
    tools: surface.tools as never,
    ...(opts.memory ? { memory: opts.memory as never } : {}),
    defaultOptions: {
      maxSteps:
        typeof opts.maxSteps === "number" && Number.isFinite(opts.maxSteps) && opts.maxSteps > 0
          ? Math.floor(opts.maxSteps)
          : AGENT_MAX_STEPS,
      ...(modelSettings ? { modelSettings: modelSettings as never } : {}),
      ...(providerOptions ? { providerOptions: providerOptions as never } : {}),
    },
  });
}
