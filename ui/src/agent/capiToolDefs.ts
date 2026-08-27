// Traces: BASED-AGENT-TAB-TOOLS, BASED-AGENT-MUTATION-GATE, BASED-AGENT-SHOW-RESULTS,
//         BASED-AGENT-SURFACE-VARIANT
//
// The frontend agent tools' *schemas* and their capability policy — the part the model actually
// sees — kept free of React, the store, and the api client so it can be asserted directly. Handlers
// and approval-card renderers live in capiTools.tsx and compose onto these.
//
// This split exists because the schemas were previously unreachable from a test (importing them
// dragged in monaco), so the one thing that mattered — which tools the model is offered — was
// covered only by a backend test that inspected the other half of the surface and passed while
// run_mutation was being advertised on read-only connections.
import type { StandardTool } from "@itkennel/lm-ag-ui";
import type { EngineCapabilities } from "../api/types";

/** Each proposal tool's required capability. A tool that proposes a change the connection cannot
 *  accept is meaningless — and actively misleading: the agent offers, the user approves, the
 *  server refuses, and the agent looks incompetent for having offered. create_table follows its
 *  own narrow capability rather than `write` (BASED-AGENT-LANCE-CREATE): local LanceDB creates
 *  tables while rows stay read-only, and SQL engines create tables through run_mutation DDL. */
export const TOOL_REQUIRED_CAPABILITY = {
  run_mutation: "write",
  import_csv: "write",
  create_table: "createTable",
} as const satisfies Partial<Record<string, keyof EngineCapabilities>>;

export const capiToolDefs = {
  list_tabs: {
    name: "list_tabs",
    description:
      "List the user's open workspace tabs: the active tab id plus each tab's id, kind (query/table/routine/diagram), title, and result summary. Use get_tab to read a specific tab's SQL or results.",
    parameters: { type: "object", properties: {}, required: [] },
  },

  get_tab: {
    name: "get_tab",
    description:
      "Read one workspace tab: a query tab's SQL, run stats, output, and result rows (bounded); a table/routine tab's object identity and definition. Tab ids come from the workspace context or list_tabs.",
    parameters: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab id from workspace context or list_tabs" },
        maxRows: { type: "integer", description: "Rows to return per result set (default 50, max 200)" },
      },
      required: ["tabId"],
    },
  },

  // Traces: BASED-AGENT-SHOW-RESULTS — "put the rows in a real grid" as one stable tool name across
  // every engine. On a SQL connection it opens and runs a query tab; on one without SQL (LanceDB
  // Cloud) it opens the table's Data tab with an optional `where`. Dropping it on SQL-less
  // connections would take the "don't paste rows into chat" norm away exactly where the agent also
  // can't aggregate — the worst possible place to lose it — so it dispatches instead of vanishing.
  show_results: {
    name: "show_results",
    description:
      'Show data to the USER in a real results grid instead of pasting rows into chat — the right response to "show me…" / "list the…". On a SQL connection pass `sql` and it opens a query tab and runs it. On a connection without SQL pass `table` (and optionally `where`) and it opens that table\'s data grid, filtered. Returns the tab id, run status, and a small preview for you to narrate from.',
    parameters: {
      type: "object",
      properties: {
        sql: { type: "string", description: "The SQL to place in the new query tab (SQL connections)" },
        table: { type: "string", description: "Table to open in the data grid (connections without SQL)" },
        where: { type: "string", description: "Filter predicate for `table`, in the engine's predicate syntax" },
        schema: { type: "string", description: "Schema or base folder of `table`" },
        run: { type: "boolean", description: "Run immediately (default true; SQL only)" },
        title: { type: "string", description: "Optional tab title (SQL only)" },
      },
      required: [],
    },
  },

  import_csv: {
    name: "import_csv",
    description:
      "Propose importing a CSV file into a table. Shows the user an approval card previewing the file and the column mapping; the import runs only if the user approves. Omit `mapping` to auto-map by header names (or by position when hasHeader is false).",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the CSV file on the user's machine" },
        table: { type: "string", description: "Target table name" },
        schema: { type: "string", description: "Target schema (defaults to dbo)" },
        hasHeader: { type: "boolean", description: "First row is a header (default true)" },
        mapping: {
          type: "array",
          description: "Explicit csvIndex→column mapping; omit to auto-map",
          items: {
            type: "object",
            properties: {
              csvIndex: { type: "integer", description: "0-based CSV column index" },
              column: { type: "string", description: "Target table column name" },
            },
            required: ["csvIndex", "column"],
          },
        },
        nullEmpty: { type: "boolean", description: "Import empty fields as NULL (default true)" },
        skipBadRows: { type: "boolean", description: "Skip rows that fail coercion instead of aborting (default false)" },
        reason: { type: "string", description: "Short explanation of why this import is needed" },
      },
      required: ["path", "table"],
    },
  },

  // Traces: BASED-AGENT-LANCE-CREATE — Lance writes are SDK calls, not SQL, so table creation gets
  // its own proposal tool + approval card instead of riding run_mutation.
  create_table: {
    name: "create_table",
    description:
      "Propose creating a brand-new empty LanceDB table. Shows the user an approval card with the table name, target folder, and column list; the table is created only if the user approves. The table starts empty and rows cannot be inserted afterwards — this connection's rows are read-only.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "New table name (letters, digits, underscores; not starting with a digit)" },
        folder: {
          type: "string",
          description:
            "Base folder to create in (base-folder connections only): an existing folder, or a new name to create a new folder-database",
        },
        columns: {
          type: "array",
          description: "Column definitions — at least one",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Column name (letters, digits, underscores)" },
              type: {
                type: "string",
                enum: ["string", "int", "float", "bool", "date", "vector"],
                description: "Column type",
              },
              dim: {
                type: "integer",
                description: "Vector dimension — required for vector columns; match the embedding model that will fill it",
              },
            },
            required: ["name", "type"],
          },
        },
        reason: { type: "string", description: "Short explanation of why this table is needed" },
      },
      required: ["name", "columns"],
    },
  },

  run_mutation: {
    name: "run_mutation",
    description:
      "Request the user's approval to run a data- or schema-changing statement (INSERT/UPDATE/DELETE/DDL). Shows an approval card; the statement runs only if the user approves.",
    parameters: {
      type: "object",
      properties: {
        sql: { type: "string", description: "The exact SQL statement to run" },
        reason: { type: "string", description: "Short explanation of why this change is needed" },
      },
      required: ["sql"],
    },
  },
} satisfies Record<string, StandardTool>;

export type CapiToolName = keyof typeof capiToolDefs;

/** Drop the tools whose required capability this connection lacks. Null capabilities (not yet
 *  connected) keeps everything: there is nothing to gate on yet, and no run can happen anyway. */
export function filterToolsByCapabilities<T>(
  tools: Record<string, T>,
  capabilities: EngineCapabilities | null,
): Record<string, T> {
  if (!capabilities) return tools;
  const required = TOOL_REQUIRED_CAPABILITY as Partial<Record<string, keyof EngineCapabilities>>;
  return Object.fromEntries(
    Object.entries(tools).filter(([name]) => {
      const cap = required[name];
      return !cap || Boolean(capabilities[cap]);
    }),
  );
}
