// Traces: BASED-AGENT-SURFACE-VARIANT, BASED-AGENT-MUTATION-GATE, BASED-AGENT-SHOW-RESULTS
//
// The frontend half of the agent's tool surface. This file exists because the backend surface test
// gave false assurance: it asserted `expect(names).not.toContain("run_mutation")` and passed, while
// run_mutation and import_csv were being handed to the model on every connection — they are
// *frontend* tools, shipped straight from the UI's tool map into RunAgentInput.tools, and nothing
// filtered them. So on a read-only LanceDB connection the agent would offer to fix the user's data,
// get refused, and look incompetent for having offered. Testing half a surface is not testing the
// surface.
//
// Imports capiToolDefs rather than capiTools: the schemas and the capability policy are deliberately
// free of React/store/monaco so they can be asserted here, and they are what the model actually sees.
import { describe, expect, test } from "bun:test";
import { capiToolDefs, filterToolsByCapabilities, TOOL_REQUIRED_CAPABILITY } from "../../../ui/src/agent/capiToolDefs";
import type { EngineCapabilities } from "../../../ui/src/api/types";

const WRITABLE: EngineCapabilities = {
  sql: true,
  search: false,
  write: true,
  createTable: false,
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
};

const READ_ONLY: EngineCapabilities = {
  ...WRITABLE,
  write: false,
  sql: false,
  search: true,
  script: false,
  relations: false,
  orderedBrowse: false,
  engine: "lancedb",
  variant: "lancedb-cloud",
  wherePredicate: true,
  structuredFilters: false,
  takeByKey: true,
};

// Traces: BASED-AGENT-LANCE-CREATE — local LanceDB: rows read-only, but table creation exists.
const LANCE_LOCAL: EngineCapabilities = {
  ...READ_ONLY,
  variant: "lancedb-local",
  sql: true,
  createTable: true,
};

const offered = (caps: EngineCapabilities | null) => Object.keys(filterToolsByCapabilities(capiToolDefs, caps));

describe("BASED-AGENT-SURFACE-VARIANT: frontend tools are capability-filtered", () => {
  test("a writable connection keeps the approval tools", () => {
    expect(offered(WRITABLE)).toContain("run_mutation");
    expect(offered(WRITABLE)).toContain("import_csv");
  });

  test("a read-only connection is never offered run_mutation or import_csv", () => {
    expect(offered(READ_ONLY)).not.toContain("run_mutation");
    expect(offered(READ_ONLY)).not.toContain("import_csv");
  });

  test("every tool named by the capability policy actually exists", () => {
    // Otherwise the policy silently stops covering a renamed tool and it leaks back onto read-only
    // connections — the original bug, one rename later.
    for (const name of Object.keys(TOOL_REQUIRED_CAPABILITY)) {
      expect(Object.keys(capiToolDefs)).toContain(name);
    }
  });

  // Traces: BASED-AGENT-LANCE-CREATE — create_table follows its own narrow capability, not `write`.
  test("create_table is offered exactly where the capability is true", () => {
    expect(offered(LANCE_LOCAL)).toContain("create_table");
    expect(offered(READ_ONLY)).not.toContain("create_table"); // lance cloud: createTable false
    expect(offered(WRITABLE)).not.toContain("create_table"); // mssql creates tables via run_mutation DDL
  });

  test("a createTable connection still never sees the row-write tools", () => {
    expect(offered(LANCE_LOCAL)).not.toContain("run_mutation");
    expect(offered(LANCE_LOCAL)).not.toContain("import_csv");
  });

  test("the workspace tools survive on every connection", () => {
    for (const caps of [WRITABLE, READ_ONLY]) {
      const names = offered(caps);
      expect(names).toContain("list_tabs");
      expect(names).toContain("get_tab");
      expect(names).toContain("show_results");
    }
  });

  test("null capabilities (not yet connected) keeps everything", () => {
    expect(offered(null)).toContain("run_mutation");
  });
});

describe("BASED-AGENT-SHOW-RESULTS: one tool, two dispatch paths", () => {
  test("show_results accepts both a SQL source and a table+where source", () => {
    // Dropping it on SQL-less connections would strip the "rows land in a real grid, don't paste
    // them into chat" norm exactly where the agent also cannot aggregate, so every answer would
    // degrade to rows in chat. It dispatches on capability instead of disappearing.
    const params = capiToolDefs.show_results.parameters as { properties: Record<string, unknown>; required: string[] };
    expect(Object.keys(params.properties)).toContain("sql");
    expect(Object.keys(params.properties)).toContain("table");
    expect(Object.keys(params.properties)).toContain("where");
    // Neither source is mandatory — which one applies depends on the connection.
    expect(params.required).toEqual([]);
  });

  test("the old open_query_tab name is gone", () => {
    expect(Object.keys(capiToolDefs)).not.toContain("open_query_tab");
  });
});

describe("frontend tool schemas", () => {
  test("every row/index count is an integer, not a bare number", () => {
    // A `number` where a count is meant invites a model to send 12.5.
    const counts: Array<{ type: string }> = [
      (capiToolDefs.get_tab.parameters as { properties: Record<string, { type: string }> }).properties.maxRows!,
      (
        (capiToolDefs.import_csv.parameters as {
          properties: { mapping: { items: { properties: Record<string, { type: string }> } } };
        }).properties.mapping.items.properties
      ).csvIndex!,
    ];
    for (const schema of counts) expect(schema.type).toBe("integer");
  });
});
