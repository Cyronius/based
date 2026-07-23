// Traces: BASED-AGENT-SCHEMA-CTX, BASED-AGENT-AUDIT, BASED-SKILL-LOAD, BASED-LANCE-AGENT-SURFACE
// Engine-neutral agent tools + shared deps/helpers. Every engine's toolset includes these; the
// engine-specific tools (SQL vs vector search) live alongside in mssql.ts / lancedb.ts and are
// assembled per engine by agentSurfaceFor (see ../surface.ts).
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { DatabaseAdapter } from "../../db/types";
import type { AuditStore } from "../audit";
import { catalog as skillCatalog, get as getSkill } from "../skills";

export interface ToolDeps {
  /** Returns the current session adapter, or throws if no connection is active. */
  getAdapter: () => DatabaseAdapter;
  connectionId: () => string;
  database: () => string;
  audit: AuditStore;
}

/** Record the read in the audit log. `op` is the SQL text for SQL engines, or a structured
 *  description (e.g. `vector_search(docs, k=10)`) for engines with no SQL surface. */
export function auditRead(
  deps: ToolDeps,
  op: string,
  status: "ok" | "error",
  durationMs: number,
  error: string | null,
): void {
  deps.audit.add({
    connectionId: deps.connectionId(),
    database: deps.database(),
    kind: "read",
    sql: op,
    approved: false,
    startedAt: new Date().toISOString(),
    durationMs,
    status,
    error,
  });
}

/** Tools every engine exposes: schema inspection and skill loading. */
export function sharedTools(deps: ToolDeps) {
  const getSchema = createTool({
    id: "get_schema",
    description:
      "Inspect the database schema. With no argument, returns all user objects with their schema names. With a table name, returns that table's columns (name, type, nullability, and any key/vector metadata). Returns schema only — never row data.",
    inputSchema: z.object({
      table: z.string().optional().describe("Table or view name to get columns for; omit to list all objects"),
      schema: z.string().optional().describe("Schema of the table (defaults to dbo on SQL engines)"),
    }),
    execute: async ({ table, schema }) => {
      const adapter = deps.getAdapter();
      if (!table) {
        const objects = await adapter.listObjects();
        return { objects };
      }
      const resolvedSchema = schema ?? (adapter.capabilities.sql ? "dbo" : "");
      const columns = await adapter.getTableColumns(resolvedSchema, table);
      return { schema: resolvedSchema, table, columns };
    },
  });

  // Traces: BASED-SKILL-LOAD — progressive disclosure: the prompt advertises the catalog (name+desc);
  // the agent pulls a full skill body only when it needs it. An unknown name returns the valid list.
  const loadSkill = createTool({
    id: "load_skill",
    description:
      "Load the full instructions for one of the skills listed in your system prompt's skill catalog. Call this before acting on a skill (e.g. before drawing a diagram). Returns the skill's body text.",
    inputSchema: z.object({
      name: z.string().describe("The skill name from the catalog (e.g. \"diagrams\")"),
    }),
    execute: async ({ name }) => {
      const skill = getSkill(name);
      if (!skill) {
        return { error: `Unknown skill "${name}"`, validNames: skillCatalog().map((s) => s.name) };
      }
      return { name: skill.name, body: skill.body };
    },
  });

  return { get_schema: getSchema, load_skill: loadSkill };
}
