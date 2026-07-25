// Traces: BASED-LANCE-AGENT-SURFACE
// The agent surface is a property of the engine and the toolsets deliberately DO NOT match: SQL Server
// exposes run_query/sample_rows; LanceDB exposes vector/text/hybrid search. Also checks the skill
// catalog is engine-filtered (lance-search only in LanceDB sessions).
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentSurfaceFor, AuditStore, openDb, skills, type ToolDeps } from "@based/core";

function deps(): ToolDeps {
  return {
    getAdapter: () => {
      throw new Error("surface name test must not touch the adapter");
    },
    connectionId: () => "c",
    database: () => "d",
    audit: new AuditStore(openDb(join(mkdtempSync(join(tmpdir(), "based-surface-")), "app.db"))),
  };
}

describe("BASED-LANCE-AGENT-SURFACE: engine-specific toolsets", () => {
  test("SQL Server surface exposes SQL tools and no vector search", () => {
    const s = agentSurfaceFor("mssql", deps());
    const names = Object.keys(s.tools);
    expect(names).toContain("run_query");
    expect(names).toContain("sample_rows");
    expect(names).toContain("get_schema");
    // BASED-AGENT-READ-ROWS / BASED-AGENT-EXPORT / BASED-SCRIPT-OBJECT
    expect(names).toContain("read_rows");
    expect(names).toContain("export_data");
    expect(names).toContain("script_object");
    expect(names).not.toContain("vector_search");
    expect(s.skillTags).toBeUndefined();
  });

  test("LanceDB surface exposes search tools plus read-only SQL (BASED-LANCE-AGENT-SQL)", () => {
    const s = agentSurfaceFor("lancedb", deps());
    const names = Object.keys(s.tools);
    expect(names).toContain("vector_search");
    expect(names).toContain("text_search");
    expect(names).toContain("hybrid_search");
    expect(names).toContain("get_schema");
    expect(names).toContain("run_query"); // DuckDB SQL over local Lance tables
    // BASED-AGENT-READ-ROWS / BASED-AGENT-EXPORT / BASED-SCRIPT-OBJECT (lance flavor)
    expect(names).toContain("read_rows");
    expect(names).toContain("export_data");
    expect(names).toContain("script_object");
    expect(names).not.toContain("run_mutation"); // still read-only
    expect(s.skillTags).toEqual(["lancedb"]);
  });

  test("the two engines' toolsets do not match", () => {
    const mssql = new Set(Object.keys(agentSurfaceFor("mssql", deps()).tools));
    const lance = new Set(Object.keys(agentSurfaceFor("lancedb", deps()).tools));
    // Since BASED-LANCE-AGENT-SQL the Lance surface is a superset (search tools + its own
    // run_query); the sets still must not be identical.
    expect([...lance].some((n) => !mssql.has(n))).toBe(true);
    expect(lance.size).not.toBe(mssql.size);
  });

  test("the skill catalog is engine-filtered", () => {
    const universal = skills.catalog().map((s) => s.name); // no tags → universal only
    expect(universal).toContain("diagrams");
    expect(universal).not.toContain("lance-search");

    const lance = skills.catalog(["lancedb"]).map((s) => s.name);
    expect(lance).toContain("diagrams"); // universal still shows
    expect(lance).toContain("lance-search"); // plus the LanceDB-tagged skill
  });
});
