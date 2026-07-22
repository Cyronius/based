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
    expect(names).not.toContain("vector_search");
    expect(s.skillTags).toBeUndefined();
  });

  test("LanceDB surface exposes search tools and no SQL query", () => {
    const s = agentSurfaceFor("lancedb", deps());
    const names = Object.keys(s.tools);
    expect(names).toContain("vector_search");
    expect(names).toContain("text_search");
    expect(names).toContain("hybrid_search");
    expect(names).toContain("get_schema");
    expect(names).not.toContain("run_query");
    expect(s.skillTags).toEqual(["lancedb"]);
  });

  test("the two engines' toolsets do not match", () => {
    const mssql = new Set(Object.keys(agentSurfaceFor("mssql", deps()).tools));
    const lance = new Set(Object.keys(agentSurfaceFor("lancedb", deps()).tools));
    // shared tools overlap, but each has tools the other lacks
    expect([...lance].some((n) => !mssql.has(n))).toBe(true);
    expect([...mssql].some((n) => !lance.has(n))).toBe(true);
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
