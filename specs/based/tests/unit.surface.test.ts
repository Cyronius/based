// Traces: BASED-LANCE-AGENT-SURFACE, BASED-AGENT-SURFACE-VARIANT, BASED-AGENT-CAPABILITY-DISCOVERY
//
// The agent surface is a property of the CONNECTION, not the engine. Two rules are enforced here and
// they pull in opposite directions on purpose:
//
//  1. Tool NAMES are stable across every engine and variant. A chat thread has to stay coherent when
//     the user switches connections mid-conversation, and the model must never learn three names for
//     one concept. So there is no read_table_lance, no lance_count_rows.
//  2. Tool AVAILABILITY and PARAMETERS vary by capability, and a capability the connection lacks
//     means the tool is ABSENT — not present-and-refusing. A tool the model can see is a tool it
//     will eventually propose to the user; discovering a limit by hitting it is the failure mode
//     this whole surface exists to prevent.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentInstructions, agentSurfaceFor, AuditStore, GENERIC_CORE, openDb, skills, type ToolDeps } from "@based/core";
import type { EngineCapabilities } from "@based/core";

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

const MSSQL: EngineCapabilities = {
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

const LANCE_LOCAL: EngineCapabilities = {
  sql: true,
  search: true,
  write: false,
  createTable: true,
  orderedBrowse: false,
  script: false,
  relations: false,
  engine: "lancedb",
  variant: "lancedb-local",
  containers: null,
  wherePredicate: true,
  structuredFilters: false,
  countRows: true,
  takeByKey: true,
  indexIntrospect: true,
};

const LANCE_BASEFOLDER: EngineCapabilities = {
  ...LANCE_LOCAL,
  variant: "lancedb-basefolder",
  containers: ["docs", "logs"],
};

/** Cloud is the sharp case: no SQL at all. */
const LANCE_CLOUD: EngineCapabilities = { ...LANCE_LOCAL, sql: false, createTable: false, variant: "lancedb-cloud" };

/** The parameters a tool actually advertises to the model. */
function paramsOf(tool: unknown): string[] {
  const schema = (tool as { inputSchema?: { shape?: Record<string, unknown> } }).inputSchema;
  return Object.keys(schema?.shape ?? {});
}

function surfaceNames(caps: EngineCapabilities): string[] {
  return Object.keys(agentSurfaceFor(caps, deps()).tools);
}

describe("BASED-AGENT-SURFACE-VARIANT: the four connection variants", () => {
  test("every variant gets the capability-discovery tool and the stable core", () => {
    for (const caps of [MSSQL, LANCE_LOCAL, LANCE_BASEFOLDER, LANCE_CLOUD]) {
      const names = surfaceNames(caps);
      expect(names).toContain("get_connection_info");
      expect(names).toContain("list_objects");
      expect(names).toContain("describe_table");
      expect(names).toContain("read_table");
      expect(names).toContain("count_rows");
      expect(names).toContain("get_indexes");
      expect(names).toContain("export_data");
      expect(names).toContain("load_skill");
    }
  });

  test("run_query is ABSENT on cloud and present everywhere else", () => {
    expect(surfaceNames(LANCE_CLOUD)).not.toContain("run_query");
    expect(surfaceNames(LANCE_LOCAL)).toContain("run_query");
    expect(surfaceNames(LANCE_BASEFOLDER)).toContain("run_query");
    expect(surfaceNames(MSSQL)).toContain("run_query");
  });

  test("search tools are LanceDB-only; take_rows is too", () => {
    for (const caps of [LANCE_LOCAL, LANCE_BASEFOLDER, LANCE_CLOUD]) {
      const names = surfaceNames(caps);
      expect(names).toContain("vector_search");
      expect(names).toContain("text_search");
      expect(names).toContain("hybrid_search");
      expect(names).toContain("list_search_profiles");
      expect(names).toContain("take_rows");
    }
    const mssql = surfaceNames(MSSQL);
    expect(mssql).not.toContain("vector_search");
    expect(mssql).not.toContain("list_search_profiles");
    expect(mssql).not.toContain("take_rows");
  });

  test("no variant exposes run_mutation from the backend surface", () => {
    // The frontend half is the one that actually regressed — see unit.capiTools.test.ts.
    for (const caps of [MSSQL, LANCE_LOCAL, LANCE_BASEFOLDER, LANCE_CLOUD]) {
      expect(surfaceNames(caps)).not.toContain("run_mutation");
    }
  });

  // Traces: BASED-AGENT-DELEGATE — the one tool on this surface whose presence tracks the RUN
  // rather than the connection, so it has to be checked across every variant in both directions.
  test("delegate follows the run, not the variant: absent by default, present on all four when the runner is injected", () => {
    for (const caps of [MSSQL, LANCE_LOCAL, LANCE_BASEFOLDER, LANCE_CLOUD]) {
      expect(surfaceNames(caps)).not.toContain("delegate");
      const withRunner = Object.keys(agentSurfaceFor(caps, { ...deps(), runSubagent: async () => [] }).tools);
      expect(withRunner).toContain("delegate");
      // The protocol tool the subagent reports through is never on the parent's surface.
      expect(withRunner).not.toContain("report_findings");
    }
  });

  // Traces: BASED-AGENT-TRANSCRIPT — the second run-scoped tool, gated the same way for the same
  // reason: a subagent shares the parent's thread id but is handed no reader, so the tool is absent
  // from its surface instead of present and refusing.
  test("save_chat_transcript follows the run, not the variant", () => {
    for (const caps of [MSSQL, LANCE_LOCAL, LANCE_BASEFOLDER, LANCE_CLOUD]) {
      expect(surfaceNames(caps)).not.toContain("save_chat_transcript");
      const withReader = Object.keys(
        agentSurfaceFor(caps, { ...deps(), threadId: () => "t1", recallThread: async () => [] }).tools,
      );
      expect(withReader).toContain("save_chat_transcript");
      // save_file, by contrast, is a plain filesystem tool — always there, on every variant.
      expect(surfaceNames(caps)).toContain("save_file");
    }
  });

  test("the LanceDB surface carries skillTags; the MSSQL one does not", () => {
    expect(agentSurfaceFor(LANCE_CLOUD, deps()).skillTags).toEqual(["lancedb"]);
    expect(agentSurfaceFor(MSSQL, deps()).skillTags).toBeUndefined();
  });
});

describe("BASED-AGENT-SURFACE-VARIANT: stable names, variant-shaped parameters", () => {
  test("the shared tool names are byte-identical across engines", () => {
    // The guard against re-introducing per-engine aliases: if someone adds read_table_lance, the
    // shared core stops being present under one name on both sides and this fails.
    const shared = [
      "get_connection_info",
      "list_objects",
      "describe_table",
      "read_table",
      "count_rows",
      "get_indexes",
      "export_data",
      "save_file",
    ];
    const mssql = new Set(surfaceNames(MSSQL));
    const lance = new Set(surfaceNames(LANCE_CLOUD));
    for (const name of shared) {
      expect(mssql.has(name)).toBe(true);
      expect(lance.has(name)).toBe(true);
    }
  });

  test("read_table takes orderBy/filters on SQL Server and `where` on LanceDB — never both", () => {
    const mssql = paramsOf(agentSurfaceFor(MSSQL, deps()).tools.read_table);
    expect(mssql).toContain("orderBy");
    expect(mssql).toContain("filters");
    expect(mssql).toContain("schema");
    expect(mssql).not.toContain("where");
    expect(mssql).not.toContain("folder");

    const lance = paramsOf(agentSurfaceFor(LANCE_LOCAL, deps()).tools.read_table);
    expect(lance).toContain("where");
    expect(lance).not.toContain("orderBy");
    expect(lance).not.toContain("filters");
    expect(lance).not.toContain("schema");
  });

  test("`folder` appears only on base-folder connections, and names the real folders", () => {
    expect(paramsOf(agentSurfaceFor(LANCE_BASEFOLDER, deps()).tools.read_table)).toContain("folder");
    expect(paramsOf(agentSurfaceFor(LANCE_LOCAL, deps()).tools.read_table)).not.toContain("folder");
    expect(paramsOf(agentSurfaceFor(LANCE_CLOUD, deps()).tools.read_table)).not.toContain("folder");
    // The base-folder ambiguity bug: the search tools had no folder param at all, so a table name
    // present in two folders was unreachable with no way for the agent to disambiguate.
    expect(paramsOf(agentSurfaceFor(LANCE_BASEFOLDER, deps()).tools.vector_search)).toContain("folder");
  });

  test("export_data offers a `sql` source only where SQL exists", () => {
    expect(paramsOf(agentSurfaceFor(LANCE_LOCAL, deps()).tools.export_data)).toContain("sql");
    expect(paramsOf(agentSurfaceFor(LANCE_CLOUD, deps()).tools.export_data)).not.toContain("sql");
  });

  test("vector tuning knobs are nested under one optional object, not flattened", () => {
    // Traces: BASED-LANCE-SEARCH-KNOBS — Mastra's OpenAI schema-compat layer marks every property
    // required with anyOf:[...,null], and a model under that pressure fills plausible values rather
    // than nulls. Eight flat knobs became eight spurious values on tables with no index; one
    // optional object is one decision.
    const params = paramsOf(agentSurfaceFor(LANCE_LOCAL, deps()).tools.vector_search);
    expect(params).toContain("tuning");
    for (const knob of ["nprobes", "ef", "refineFactor", "postfilter", "bypassVectorIndex", "distanceType"]) {
      expect(params).not.toContain(knob);
    }
    // text_search has no vector query to tune, so it has no tuning object at all.
    expect(paramsOf(agentSurfaceFor(LANCE_LOCAL, deps()).tools.text_search)).not.toContain("tuning");
  });

  test("BASED-SEARCH-PARAM-NAMES: the renamed search params are the only ones offered", () => {
    const params = paramsOf(agentSurfaceFor(LANCE_LOCAL, deps()).tools.vector_search);
    expect(params).toContain("candidatePool");
    expect(params).toContain("minScore");
    expect(params).toContain("maxScoreGapFromTop");
    expect(params).toContain("vectorColumn");
    expect(params).not.toContain("sampleSize");
    expect(params).not.toContain("floor");
    expect(params).not.toContain("delta");
  });
});

describe("BASED-AGENT-SURFACE-VARIANT: descriptions are unconditionally true", () => {
  /** Everything prose-shaped the model reads: the generated briefing, the persona, and every tool
   *  description. */
  function prose(caps: EngineCapabilities): string {
    const surface = agentSurfaceFor(caps, deps());
    const descriptions = Object.values(surface.tools).map((t) => (t as { description?: string }).description ?? "");
    return [surface.briefing, surface.persona, ...descriptions].join("\n");
  }

  test("a cloud session is never told about run_query", () => {
    // The old prose said "Local connections also support read-only SQL via run_query… LanceDB Cloud
    // connections have no SQL; run_query will error there" — to a model that can't see which variant
    // it's on, that is an invitation to try.
    expect(prose(LANCE_CLOUD)).not.toMatch(/\brun_query\b/);
    expect(prose(LANCE_LOCAL)).toMatch(/\brun_query\b/);
  });

  test("only a base-folder session is told to qualify folder.main.table, and the folders are named", () => {
    const basefolder = prose(LANCE_BASEFOLDER);
    expect(basefolder).toContain("folder.main.table");
    expect(basefolder).toContain("docs");
    expect(basefolder).toContain("logs");
    expect(prose(LANCE_LOCAL)).not.toContain("folder.main.table");
    expect(prose(LANCE_CLOUD)).not.toContain("folder.main.table");
  });

  test("no description names a tool absent from its own surface", () => {
    const ALL_TOOLS = [
      "run_query",
      "take_rows",
      "count_rows",
      "get_indexes",
      "vector_search",
      "text_search",
      "hybrid_search",
      "list_search_profiles",
      "read_table",
      "describe_table",
      "list_objects",
    ];
    for (const caps of [MSSQL, LANCE_LOCAL, LANCE_BASEFOLDER, LANCE_CLOUD]) {
      const present = new Set(surfaceNames(caps));
      const text = prose(caps);
      for (const name of ALL_TOOLS) {
        if (present.has(name)) continue;
        expect(text).not.toMatch(new RegExp(`\\b${name}\\b`));
      }
    }
  });

  test("a read-only session is told plainly that it cannot write", () => {
    expect(prose(LANCE_CLOUD)).toMatch(/read-only/i);
    // …and is never pointed at approval tools it doesn't have.
    expect(prose(LANCE_CLOUD)).not.toMatch(/\brun_mutation\b/);
    expect(prose(LANCE_CLOUD)).not.toMatch(/\bimport_csv\b/);
    // SQL Server keeps the propose-for-approval doctrine.
    expect(prose(MSSQL)).toMatch(/\brun_mutation\b/);
  });

  // Traces: BASED-AGENT-LANCE-CREATE — the briefing mentions create_table exactly where it exists.
  test("the briefing names create_table iff the capability is true", () => {
    expect(prose(LANCE_LOCAL)).toMatch(/\bcreate_table\b/);
    expect(prose(LANCE_BASEFOLDER)).toMatch(/\bcreate_table\b/);
    expect(prose(LANCE_CLOUD)).not.toMatch(/\bcreate_table\b/);
    // Rows stay read-only either way, and the briefing still says so.
    expect(prose(LANCE_LOCAL)).toMatch(/read-only/i);
  });
});

describe("BASED-LANCE-AGENT-SURFACE: skills stay engine-filtered", () => {
  test("the skill catalog is engine-filtered", () => {
    const universal = skills.catalog().map((s) => s.name); // no tags → universal only
    expect(universal).toContain("diagrams");
    expect(universal).not.toContain("lance-search");

    const lance = skills.catalog(["lancedb"]).map((s) => s.name);
    expect(lance).toContain("diagrams"); // universal still shows
    expect(lance).toContain("lance-search"); // plus the LanceDB-tagged skill
  });
});

// Traces: BASED-AGENT-INSTRUCTIONS — the prompt splits into a generated capability briefing (facts
// about this connection, never user-editable) and a persona (voice and policy, editable).
//
// The split exists so that editing the agent's voice can't pin stale claims about a connection. That
// only holds if the persona is genuinely variant-neutral: the moment a connection-specific fact
// leaks into it, forking it silently reintroduces exactly the problem the split removed. These tests
// are what keep the two halves honest about which is which.
describe("BASED-AGENT-INSTRUCTIONS: briefing owns the facts, persona owns the voice", () => {
  const VARIANTS: Array<[string, EngineCapabilities]> = [
    ["mssql", MSSQL],
    ["lancedb-local", LANCE_LOCAL],
    ["lancedb-basefolder", LANCE_BASEFOLDER],
    ["lancedb-cloud", LANCE_CLOUD],
  ];

  test("the persona is byte-identical across every variant of its engine", () => {
    // If this fails, something connection-specific has leaked into the editable half.
    const lancePersonas = new Set([LANCE_LOCAL, LANCE_BASEFOLDER, LANCE_CLOUD].map((c) => agentSurfaceFor(c, deps()).persona));
    expect(lancePersonas.size).toBe(1);
  });

  test("the briefing DOES vary across variants — that's the half doing the adapting", () => {
    const briefings = new Set([LANCE_LOCAL, LANCE_BASEFOLDER, LANCE_CLOUD].map((c) => agentSurfaceFor(c, deps()).briefing));
    expect(briefings.size).toBe(3);
  });

  test("no persona mentions a variant-specific capability", () => {
    // These are the exact claims that used to go stale when a user forked a persona: a tool that
    // doesn't exist on Cloud, a qualification rule that only applies to base folders, and the
    // read-only status, which differs by engine.
    const LEAKY = [/\brun_query\b/, /folder\.main\.table/, /\bfolder\b/, /read-only/i, /\btake_rows\b/];
    for (const [name, caps] of VARIANTS) {
      const persona = agentSurfaceFor(caps, deps()).persona;
      for (const pattern of LEAKY) {
        expect(`${name}: ${persona}`).not.toMatch(pattern);
      }
    }
  });

  test("the briefing carries the facts the persona no longer does", () => {
    expect(agentSurfaceFor(LANCE_CLOUD, deps()).briefing).toMatch(/read-only/i);
    expect(agentSurfaceFor(LANCE_LOCAL, deps()).briefing).toMatch(/\brun_query\b/);
    expect(agentSurfaceFor(LANCE_BASEFOLDER, deps()).briefing).toContain("folder.main.table");
    expect(agentSurfaceFor(MSSQL, deps()).briefing).toMatch(/\brun_mutation\b/);
  });

  test("a fully custom persona still gets the connection's briefing", () => {
    // The whole point: overriding the voice cannot cost the user the facts. buildAgent takes a
    // persona override but never a briefing override, so the briefing survives any customization.
    const caps = LANCE_CLOUD;
    const surface = agentSurfaceFor(caps, deps());
    const composed = agentInstructions(GENERIC_CORE, "Answer only in haiku.", surface.skillTags, surface.briefing);
    expect(composed).toContain("Answer only in haiku.");
    expect(composed).not.toContain(surface.persona); // the built-in voice really was replaced…
    expect(composed).toContain(surface.briefing); // …and the facts really did survive
    expect(composed).toMatch(/read-only/i);
  });

  test("omitting the briefing composes core + persona unchanged", () => {
    // Previews and tests compose without a live connection; that path must not inject a fabricated
    // briefing for a variant nobody selected.
    const withNone = agentInstructions(GENERIC_CORE, "P");
    expect(withNone.startsWith(GENERIC_CORE)).toBe(true);
    expect(withNone).toContain("P");
  });
});

// Traces: BASED-SNOWFLAKE-ENGINE, BASED-ENGINE-REGISTRY
//
// Snowflake is the first engine added after the registry, so it is also the regression test for the
// defect the registry exists to remove: under the old `if (engine === "mssql") … else <LanceDB>`
// surface, a Snowflake connection would silently have been handed LanceDB's search tools, LanceDB's
// persona, and prose telling it to write DuckDB SQL.
const SNOWFLAKE: EngineCapabilities = {
  sql: true,
  search: false,
  write: true,
  createTable: false,
  orderedBrowse: true,
  script: true,
  relations: true,
  engine: "snowflake",
  variant: "snowflake",
  containers: null,
  wherePredicate: false,
  structuredFilters: true,
  countRows: true,
  takeByKey: false,
  indexIntrospect: false,
};

describe("BASED-SNOWFLAKE-ENGINE: the Snowflake surface", () => {
  test("it gets the stable core, and none of LanceDB's engine-only tools", () => {
    const names = surfaceNames(SNOWFLAKE);
    for (const stable of ["get_connection_info", "list_objects", "describe_table", "read_table", "count_rows", "run_query", "export_data"]) {
      expect(names).toContain(stable);
    }
    for (const lanceOnly of ["vector_search", "text_search", "hybrid_search", "list_search_profiles", "take_rows"]) {
      expect(names).not.toContain(lanceOnly);
    }
  });

  test("get_indexes is ABSENT, because Snowflake has no user-defined indexes", () => {
    // Not an omission: present-and-empty would invite the agent to recommend adding an index, which
    // is never the right advice on Snowflake (clustering keys and warehouse size are).
    expect(surfaceNames(SNOWFLAKE)).not.toContain("get_indexes");
    expect(surfaceNames(MSSQL)).toContain("get_indexes");
  });

  test("its persona and briefing are its own, not SQL Server's or LanceDB's", () => {
    const surface = agentSurfaceFor(SNOWFLAKE, deps());
    expect(surface.briefing).toContain("Snowflake");
    expect(surface.briefing).not.toContain("Microsoft SQL Server");
    expect(surface.persona).toMatch(/LIMIT instead of TOP/);
    expect(surface.persona).not.toMatch(/TOP instead of LIMIT/);
    // It opts into no engine skill tags, so it never picks up LanceDB's.
    expect(surface.skillTags).toBeUndefined();
  });

  test("its SQL prose names the Snowflake dialect, and the namespace defaults to PUBLIC", () => {
    const tools = agentSurfaceFor(SNOWFLAKE, deps()).tools as Record<string, { description?: string }>;
    expect(tools.run_query!.description).toMatch(/Snowflake SQL/);
    expect(tools.run_query!.description).not.toMatch(/T-SQL|DuckDB/);
    expect(paramsOf(tools.describe_table)).toContain("schema");
    expect(tools.describe_table!.description).not.toMatch(/T-SQL/);
  });

  test("describe_table offers no \"alter\" template, because GET_DDL has no equivalent", () => {
    const shape = (agentSurfaceFor(SNOWFLAKE, deps()).tools as Record<string, { inputSchema?: { shape?: Record<string, { options?: string[] }> } }>)
      .describe_table!.inputSchema!.shape!;
    const formats = (shape.format as unknown as { unwrap?: () => { options?: string[] } }).unwrap?.()?.options ?? [];
    expect(formats).toContain("ddl");
    expect(formats).not.toContain("alter");
  });
});
