// Traces: BASED-SKILL-REGISTRY (canonical spec: specs/based/spec.md)
import { describe, expect, test } from "bun:test";
import { skills } from "@based/core";

describe("BASED-SKILL-REGISTRY: registry & prompt catalog", () => {
  test("catalog() carries every skill's name + description and none of the body text", () => {
    // catalog() is engine-filtered; pass every engine tag to see the full set (BASED-LANCE-AGENT-SURFACE).
    const cat = skills.catalog(["mssql", "lancedb"]);
    const all = skills.list();
    expect(cat.map((c) => c.name).sort()).toEqual(all.map((s) => s.name).sort());
    for (const s of all) {
      const entry = cat.find((c) => c.name === s.name);
      expect(entry?.description).toBe(s.description);
    }
    // The (potentially large) body never leaks into the prompt catalog.
    const serialized = JSON.stringify(cat);
    for (const s of all) expect(serialized).not.toContain(s.body);
  });

  test("get(known) returns the full skill (with body); get(unknown) returns undefined", () => {
    const d = skills.get("diagrams");
    expect(d?.name).toBe("diagrams");
    expect(d?.body.length ?? 0).toBeGreaterThan(0);
    expect(skills.get("nope")).toBeUndefined();
  });

  test("at least the diagrams skill is registered", () => {
    expect(skills.list().some((s) => s.name === "diagrams")).toBe(true);
  });
});
