// Traces: BASED-AGENT-INSTRUCTIONS, BASED-AGENT-SURFACE-VARIANT
// User-editable agent instruction sets. The "default" set is virtual — never persisted, never
// editable — so it can't drift from the code.
//
// What a set holds is deliberately only half the prompt: the engine-neutral core and each engine's
// *persona* (voice and policy). The capability briefing — which tools exist on this connection, what
// it can't do, how to qualify a table — is generated per variant by agentSurfaceFor and is never
// stored here, so editing the agent's voice cannot pin a stale claim about a connection the user
// wasn't looking at. Personas are plain strings and safe to fork precisely because nothing in them
// varies by connection.
import type { Database } from "bun:sqlite";
import type { DbEngine } from "../db/types";
import { ENGINES, ENGINE_IDS, descriptorFor } from "../engines/registry";
import { GENERIC_CORE } from "./agent";

export interface InstructionSet {
  id: string;
  name: string;
  /** Shared, engine-neutral core. */
  core: string;
  /** Persona per engine id. A missing entry falls back to that engine's built-in persona, which is
   *  what lets a new engine appear without leaving every stored custom set half-populated —
   *  the reason this is a record rather than one named field per engine. */
  personas: Partial<Record<DbEngine, string>>;
}

/** Stored shape before personas became a record (two hardcoded fields). Read-migrated below. */
interface LegacyInstructionSet {
  mssqlPersona?: string;
  lancePersona?: string;
}

/** Lift a stored set into the current shape. Old rows heal on their next save; nothing is
 *  rewritten in bulk, so a downgrade never finds a half-migrated table. */
function migrateSet(raw: InstructionSet & LegacyInstructionSet): InstructionSet {
  if (raw.personas) return { id: raw.id, name: raw.name, core: raw.core, personas: raw.personas };
  const personas: Partial<Record<DbEngine, string>> = {};
  if (raw.mssqlPersona) personas.mssql = raw.mssqlPersona;
  if (raw.lancePersona) personas.lancedb = raw.lancePersona;
  return { id: raw.id, name: raw.name, core: raw.core, personas };
}

export interface AgentInstructionsConfig {
  /** "default" or a customSets[].id. */
  activeId: string;
  customSets: InstructionSet[];
}

export const DEFAULT_INSTRUCTIONS_CONFIG: AgentInstructionsConfig = {
  activeId: "default",
  customSets: [],
};

const DEFAULT_SET: InstructionSet & { editable: false } = {
  id: "default",
  name: "Default",
  core: GENERIC_CORE,
  // Built from the registry, so a newly registered engine's persona is present in the default set
  // the moment it exists — no second place to remember to edit.
  personas: Object.fromEntries(ENGINE_IDS.map((id) => [id, ENGINES[id].persona])) as Record<DbEngine, string>,
  editable: false,
};

export class AgentInstructionsStore {
  constructor(private readonly db: Database) {}

  private get(): AgentInstructionsConfig {
    const row = this.db.query<{ json: string }, []>("SELECT json FROM agent_instructions WHERE id = 1").get();
    if (!row) return DEFAULT_INSTRUCTIONS_CONFIG;
    const parsed = { ...DEFAULT_INSTRUCTIONS_CONFIG, ...(JSON.parse(row.json) as Partial<AgentInstructionsConfig>) };
    return { ...parsed, customSets: (parsed.customSets ?? []).map(migrateSet) };
  }

  private persist(next: AgentInstructionsConfig): void {
    this.db.run(
      "INSERT INTO agent_instructions (id, json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json",
      [JSON.stringify(next)],
    );
  }

  /** The default set plus every custom set, each tagged with whether it can be edited/deleted. */
  list(): { activeId: string; sets: Array<InstructionSet & { editable: boolean }> } {
    const cfg = this.get();
    return {
      activeId: cfg.activeId,
      sets: [DEFAULT_SET, ...cfg.customSets.map((s) => ({ ...s, editable: true }))],
    };
  }

  /** Create (no `id`) or update (matching `id`) a custom set. Rejects `id === "default"`. */
  saveSet(input: { id?: string; name: string; core: string; personas: Partial<Record<DbEngine, string>> }) {
    if (input.id === "default") throw new Error("Default instructions are not editable");
    const cfg = this.get();
    const id = input.id ?? crypto.randomUUID();
    const set: InstructionSet = { id, name: input.name, core: input.core, personas: input.personas ?? {} };
    const idx = cfg.customSets.findIndex((s) => s.id === id);
    const customSets = idx >= 0 ? cfg.customSets.map((s, i) => (i === idx ? set : s)) : [...cfg.customSets, set];
    const next = { ...cfg, customSets };
    this.persist(next);
    return this.list();
  }

  /** Removes a custom set; falls back the active selection to "default" if it was active. Rejects
   *  `id === "default"`. */
  deleteSet(id: string) {
    if (id === "default") throw new Error("Default instructions cannot be deleted");
    const cfg = this.get();
    const customSets = cfg.customSets.filter((s) => s.id !== id);
    const activeId = cfg.activeId === id ? "default" : cfg.activeId;
    const next = { activeId, customSets };
    this.persist(next);
    return this.list();
  }

  /** Switches the active set. `id` must be "default" or an existing custom set id. */
  setActive(id: string) {
    const cfg = this.get();
    if (id !== "default" && !cfg.customSets.some((s) => s.id === id)) {
      throw new Error(`Unknown instruction set "${id}"`);
    }
    const next = { ...cfg, activeId: id };
    this.persist(next);
    return this.list();
  }

  /** Resolve the active set's core + engine-appropriate persona for building the agent. Falls back
   *  to the default if the active id no longer resolves to a set (e.g. deleted from elsewhere). */
  resolveActive(engine: DbEngine): { core: string; persona: string } {
    return this.resolveById(this.get().activeId, engine);
  }

  /** Resolve a specific set's core + engine-appropriate persona. Falls back to the default set if
   *  `id` no longer resolves (e.g. the set a profile linked to was deleted).
   *
   *  Both values are plain strings for every set, default included: a persona carries no
   *  connection-specific claims, so it needs no per-variant regeneration. The capability briefing
   *  that does is generated separately by agentSurfaceFor and is never part of a set. */
  resolveById(id: string, engine: DbEngine): { core: string; persona: string } {
    const cfg = this.get();
    const set = id === "default" ? DEFAULT_SET : cfg.customSets.find((s) => s.id === id) ?? DEFAULT_SET;
    // A set that predates this engine simply has no entry for it; fall back to the engine's own
    // persona rather than to another engine's, which is what an `=== "mssql" ? … : …` would do.
    return { core: set.core, persona: set.personas[engine] ?? descriptorFor(engine).persona };
  }
}
