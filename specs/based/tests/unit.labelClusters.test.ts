// Traces: BASED-EMBED-LABELS-AI
// Pure halves of the cluster-naming endpoint: prompt construction (with the server-enforced cost
// guard) and response parsing (models wrap JSON in prose/fences; parsing must survive that and
// fall back per-cluster to the TF-IDF hint).
import { describe, expect, test } from "bun:test";
import { buildLabelPrompt, clampClusters, parseLabelResponse } from "@based/core";

const clusters = [
  { id: 0, hint: "invoice, payment", samples: ["Invoice overdue for order 12", "Payment failed on retry"] },
  { id: 1, hint: "shipping, parcel", samples: ["Parcel stuck in customs", "Shipping delayed again"] },
];

describe("BASED-EMBED-LABELS-AI: prompt construction + cost guard", () => {
  test("prompt lists every cluster with id, hint, and samples", () => {
    const { system, prompt } = buildLabelPrompt(clusters);
    expect(system).toMatch(/JSON array/);
    expect(prompt).toContain("Cluster 0");
    expect(prompt).toContain("Cluster 1");
    expect(prompt).toContain("invoice, payment");
    expect(prompt).toContain("Parcel stuck in customs");
  });

  test("clampClusters truncates instead of rejecting: ≤24 clusters, ≤10 samples, ≤300 chars each", () => {
    const oversized = Array.from({ length: 30 }, (_, id) => ({
      id,
      samples: Array.from({ length: 15 }, (_, s) => `sample ${s} ${"x".repeat(500)}`),
    }));
    const clamped = clampClusters(oversized);
    expect(clamped.length).toBe(24);
    expect(clamped[0]!.samples.length).toBe(10);
    for (const c of clamped) for (const s of c.samples) expect(s.length).toBeLessThanOrEqual(300);
  });
});

describe("BASED-EMBED-LABELS-AI: response parsing", () => {
  test("parses a clean JSON array", () => {
    const out = parseLabelResponse('[{"id":0,"label":"Billing disputes"},{"id":1,"label":"Shipping issues"}]', clusters);
    expect(out).toEqual([
      { id: 0, label: "Billing disputes" },
      { id: 1, label: "Shipping issues" },
    ]);
  });

  test("parses JSON wrapped in prose and code fences", () => {
    const text = 'Sure! Here are the labels:\n```json\n[{"id":0,"label":"Billing"},{"id":1,"label":"Logistics"}]\n```\nHope that helps.';
    const out = parseLabelResponse(text, clusters);
    expect(out.find((l) => l.id === 0)!.label).toBe("Billing");
    expect(out.find((l) => l.id === 1)!.label).toBe("Logistics");
  });

  test("missing or malformed entries fall back to the cluster's hint", () => {
    const out = parseLabelResponse('[{"id":0,"label":"Billing"},{"id":9,"label":"Bogus"},{"label":"NoId"}]', clusters);
    expect(out.find((l) => l.id === 0)!.label).toBe("Billing");
    expect(out.find((l) => l.id === 1)!.label).toBe("shipping, parcel"); // hint fallback
    expect(out.some((l) => l.id === 9)).toBe(false); // unknown ids dropped
  });

  test("total garbage falls back for every cluster", () => {
    const out = parseLabelResponse("I could not do that.", clusters);
    expect(out).toEqual([
      { id: 0, label: "invoice, payment" },
      { id: 1, label: "shipping, parcel" },
    ]);
  });
});
