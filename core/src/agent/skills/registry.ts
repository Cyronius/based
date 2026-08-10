// Traces: BASED-SKILL-REGISTRY
// The skill registry. `catalog()` yields the cheap name+description pairs for the system prompt;
// `get(name)` returns the full skill (body included) for the load_skill tool. TS modules, not
// runtime-loaded files — bundler-safe for the packaged core bundle (cf. the keyring saga in the spec).
import type { DbEngine } from "../../db/types";
import type { Skill } from "./types";
import { diagrams } from "./diagrams";
import { lanceSearch } from "./lanceSearch";

const SKILLS: readonly Skill[] = [diagrams, lanceSearch];

export function list(): readonly Skill[] {
  return SKILLS;
}

/** A skill is advertised in a session when it is universal (no `engines`) or opts into the active
 *  engine. `tags` is the active engine(s); omit to advertise only universal skills. */
function applies(skill: Skill, tags?: DbEngine[]): boolean {
  if (!skill.engines) return true;
  if (!tags) return false;
  return skill.engines.some((e) => tags.includes(e));
}

/** Name + description only — never the body. This is what the system prompt advertises, filtered to
 *  the active engine's applicable skills. */
export function catalog(tags?: DbEngine[]): Array<{ name: string; description: string }> {
  return SKILLS.filter((s) => applies(s, tags)).map((s) => ({ name: s.name, description: s.description }));
}

export function get(name: string): Skill | undefined {
  return SKILLS.find((s) => s.name === name);
}
