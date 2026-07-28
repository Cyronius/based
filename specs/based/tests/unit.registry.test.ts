// Traces: BASED-ENGINE-REGISTRY, BASED-ENGINE-PROFILE-WIRE, BASED-AGENT-SURFACE-VARIANT
//
// These tests exist because of a specific defect class, not for coverage. Before the registry, the
// agent surface and the LSP both chose backends with `if (engine === "mssql") … else <LanceDB>`,
// and the persona resolver with `engine === "mssql" ? mssqlPersona : lancePersona`. None of those
// were compile errors for a NEW engine — they silently handed it LanceDB's search tools, LanceDB's
// persona, and T-SQL completion. Everything below is table-driven over ENGINE_IDS, so an engine
// added later is covered the moment it is registered rather than when someone remembers to add a
// case here.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentSurfaceFor,
  AuditStore,
  ENGINES,
  ENGINE_IDS,
  descriptorFor,
  engineProfiles,
  openDb,
  type ToolDeps,
} from "@based/core";

function deps(): ToolDeps {
  return {
    getAdapter: () => {
      throw new Error("registry test must not touch the adapter");
    },
    connectionId: () => "c",
    database: () => "d",
    audit: new AuditStore(openDb(join(mkdtempSync(join(tmpdir(), "based-registry-")), "app.db"))),
  };
}

describe("BASED-ENGINE-REGISTRY: every registered engine is complete", () => {
  test("more than one engine is registered (the table-driven tests below are not vacuous)", () => {
    expect(ENGINE_IDS.length).toBeGreaterThan(1);
    expect(ENGINE_IDS).toContain("mssql");
    expect(ENGINE_IDS).toContain("lancedb");
    expect(ENGINE_IDS).toContain("snowflake");
  });

  for (const id of ENGINE_IDS) {
    describe(id, () => {
      const engine = ENGINES[id];

      test("its profile id matches its registry key and its capabilities agree", () => {
        expect(engine.profile.id).toBe(id);
        expect(engine.profile.defaultCapabilities.engine).toBe(id);
        expect(engine.profile.label.trim()).not.toBe("");
      });

      test("descriptorFor resolves it", () => {
        expect(descriptorFor(id)).toBe(engine);
      });

      test("it declares a persona, a briefing, and a dialect", () => {
        expect(engine.persona.trim()).not.toBe("");
        expect(engine.briefing(engine.profile.defaultCapabilities).trim()).not.toBe("");
        expect(engine.dialect.name.trim()).not.toBe("");
      });

      test("its namespace default matches the prose default the tools resolve against", () => {
        // Two readers of the same fact — the dialog/tree (profile) and the agent tools (prose) —
        // so they get an explicit equality rather than a comment asking future engines to remember.
        expect(engine.agentProse.namespaceDefault).toBe(engine.profile.namespace.default);
      });

      test("every FieldSpec has a key and label, and visibleWhen targets a real field", () => {
        const keys = new Set(engine.profile.fields.map((f) => f.key));
        keys.add("authType"); // always present on the form, not a FieldSpec
        for (const f of engine.profile.fields) {
          expect(f.key.trim()).not.toBe("");
          expect(f.label.trim()).not.toBe("");
          if (f.visibleWhen) {
            expect(keys.has(f.visibleWhen.field)).toBe(true);
            expect(f.visibleWhen.equals.length).toBeGreaterThan(0);
          }
        }
      });

      test("every auth mode a field gates on actually exists", () => {
        const modes = new Set(engine.profile.authModes.map((m) => m.id));
        expect(modes.size).toBeGreaterThan(0);
        for (const f of engine.profile.fields) {
          if (f.visibleWhen?.field !== "authType") continue;
          for (const value of f.visibleWhen.equals) expect(modes.has(value)).toBe(true);
        }
      });

      test("indexIntrospect and the index prose agree", () => {
        // get_indexes is built only when the capability is on, and it reads prose.indexes without a
        // guard — so an engine that claims the capability but omits the prose would throw at
        // surface-assembly time rather than here.
        if (engine.profile.defaultCapabilities.indexIntrospect) {
          expect(engine.agentProse.indexes).toBeDefined();
        }
      });

      test("its surface assembles and carries the stable core tool names", () => {
        const names = Object.keys(agentSurfaceFor(engine.profile.defaultCapabilities, deps()).tools);
        for (const stable of ["get_connection_info", "list_objects", "describe_table", "read_table", "load_skill", "export_data"]) {
          expect(names).toContain(stable);
        }
      });

      test("capability-absent tools are omitted, never present-and-refusing", () => {
        const caps = engine.profile.defaultCapabilities;
        const names = Object.keys(agentSurfaceFor(caps, deps()).tools);
        expect(names.includes("run_query")).toBe(caps.sql);
        expect(names.includes("count_rows")).toBe(caps.countRows);
        expect(names.includes("take_rows")).toBe(caps.takeByKey);
        expect(names.includes("get_indexes")).toBe(caps.indexIntrospect);
        // Search tools belong to engines that advertise search, and to no others.
        expect(names.includes("vector_search")).toBe(caps.search);
      });
    });
  }
});

describe("BASED-ENGINE-PROFILE-WIRE: profiles survive the wire", () => {
  test("engineProfiles() round-trips through JSON unchanged", () => {
    // The UI receives these as JSON. A function or class instance leaking into the profile half
    // would vanish silently in transit and leave the dialog rendering a partial form.
    const profiles = engineProfiles();
    expect(profiles).toHaveLength(ENGINE_IDS.length);
    expect(JSON.parse(JSON.stringify(profiles))).toEqual(profiles);
  });

  test("every profile names a subtitle field the engine actually has", () => {
    for (const p of engineProfiles()) {
      const keys = p.fields.map((f) => f.key);
      expect(keys).toContain(p.subtitleField);
    }
  });

  test("quote characters are non-empty, so UI-generated SQL is never unquoted", () => {
    for (const p of engineProfiles()) {
      expect(p.quote.open.length).toBeGreaterThan(0);
      expect(p.quote.close.length).toBeGreaterThan(0);
      expect(p.quote.escape.length).toBeGreaterThan(0);
    }
  });
});
