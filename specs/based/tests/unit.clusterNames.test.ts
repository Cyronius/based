// Traces: BASED-EMBED-CLUSTER-NAMES
import { describe, expect, test } from "bun:test";
import { clusterDisplayName, separateBadges, type Badge } from "../../../ui/src/embeddings/clusterNames";

describe("BASED-EMBED-CLUSTER-NAMES clusterDisplayName", () => {
  test("an AI label wins", () => {
    expect(clusterDisplayName("Billing disputes", ["refund", "charge"], 0)).toBe("Billing disputes");
  });

  test("with no AI label, the top two words name the cluster", () => {
    expect(clusterDisplayName(undefined, ["refund", "charge", "late"], 0)).toBe("refund · charge");
  });

  test("numbers and short tokens are skipped", () => {
    expect(clusterDisplayName(undefined, ["2024", "ok", "invoice"], 3)).toBe("invoice");
  });

  test("no usable words falls back to the 1-based number", () => {
    expect(clusterDisplayName(undefined, ["12", "a1"], 6)).toBe("7");
    expect(clusterDisplayName(undefined, undefined, 0)).toBe("1");
  });
});

describe("BASED-EMBED-CLUSTER-NAMES separateBadges", () => {
  const overlaps = (a: Badge, b: Badge) => Math.abs(a.x - b.x) < (a.w + b.w) / 2 && Math.abs(a.y - b.y) < (a.h + b.h) / 2;

  test("two badges on the same spot end up apart", () => {
    const out = separateBadges([{ x: 200, y: 200, w: 120, h: 28 }, { x: 205, y: 202, w: 100, h: 28 }], 800, 600);
    expect(overlaps(out[0]!, out[1]!)).toBe(false);
  });

  test("a crowded group ends with no overlaps and every badge on screen", () => {
    const start = Array.from({ length: 6 }, (_, i) => ({ x: 300 + i * 4, y: 300 + i * 3, w: 110, h: 28 }));
    const out = separateBadges(start, 800, 600);
    for (let i = 0; i < out.length; i++) {
      const b = out[i]!;
      expect(b.x - b.w / 2).toBeGreaterThanOrEqual(0);
      expect(b.y + b.h / 2).toBeLessThanOrEqual(600);
      for (let j = i + 1; j < out.length; j++) expect(overlaps(b, out[j]!)).toBe(false);
    }
  });

  test("badges that do not touch stay where they are", () => {
    const start = [{ x: 100, y: 100, w: 80, h: 28 }, { x: 400, y: 300, w: 80, h: 28 }];
    expect(separateBadges(start, 800, 600)).toEqual(start);
  });
});
