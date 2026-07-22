// Traces: BASED-SKILL-REGISTRY, BASED-LANCE-AGENT-SURFACE
// A developer-authored capability module. Only `name` + `description` sit in the system prompt
// (cheap); the agent pulls the full `body` on demand via the load_skill tool (progressive disclosure).
import type { DbEngine } from "../../db/types";

export interface Skill {
  name: string;
  description: string;
  body: string;
  /** Engines this skill applies to. Omit for a universal skill (advertised in every session). */
  engines?: DbEngine[];
}
