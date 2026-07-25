// Traces: BASED-EMBED-PIPELINE
// Pure math core of the Embeddings view: seeded RNG, random projection, PCA, k-means++ with
// auto-k, TF-IDF cluster terms, cosine kNN, and position normalization — all over flat
// Float32Arrays so the same code runs in the worker and headless under bun.
import { describe, expect, test } from "bun:test";
import {
  cosineTopK,
  kmeansAuto,
  mulberry32,
  normalizePositions,
  pca,
  randomProject,
  tfidfTopTerms,
} from "../../../ui/src/embeddings/pipeline";

/** n points around `center` with per-axis jitter, appended into `out`. */
function blob(out: number[], rand: () => number, center: number[], n: number, jitter = 0.05): void {
  for (let i = 0; i < n; i++) for (const c of center) out.push(c + (rand() - 0.5) * jitter);
}

describe("BASED-EMBED-PIPELINE: seeded primitives", () => {
  test("mulberry32 is deterministic per seed and uniform-ish in [0,1)", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const c = mulberry32(7);
    const seqA = Array.from({ length: 5 }, () => a());
    const seqB = Array.from({ length: 5 }, () => b());
    const seqC = Array.from({ length: 5 }, () => c());
    expect(seqA).toEqual(seqB);
    expect(seqA).not.toEqual(seqC);
    for (const v of seqA) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  test("randomProject keeps row count, hits outDim, and is seed-deterministic", () => {
    const n = 20;
    const dim = 64;
    const rand = mulberry32(1);
    const data = new Float32Array(n * dim).map(() => rand() - 0.5);
    const p1 = randomProject(data, n, dim, 16, 42);
    const p2 = randomProject(data, n, dim, 16, 42);
    const p3 = randomProject(data, n, dim, 16, 43);
    expect(p1.length).toBe(n * 16);
    expect(Array.from(p1)).toEqual(Array.from(p2));
    expect(Array.from(p1)).not.toEqual(Array.from(p3));
  });
});

describe("BASED-EMBED-PIPELINE: PCA", () => {
  test("recovers a planted dominant axis in 5D", () => {
    // Points spread along v = (1,1,0,0,0)/√2 with tiny isotropic noise.
    const rand = mulberry32(3);
    const n = 200;
    const dim = 5;
    const data = new Float32Array(n * dim);
    for (let i = 0; i < n; i++) {
      const t = (rand() - 0.5) * 10;
      const inv = Math.SQRT1_2;
      const noise = () => (rand() - 0.5) * 0.05;
      data[i * dim + 0] = t * inv + noise();
      data[i * dim + 1] = t * inv + noise();
      data[i * dim + 2] = noise();
      data[i * dim + 3] = noise();
      data[i * dim + 4] = noise();
    }
    const { projected, components } = pca(data, n, dim, 2, 42);
    expect(projected.length).toBe(n * 2);
    // First principal direction ≈ ±v.
    const c0 = [0, 1, 2, 3, 4].map((j) => components[j]!);
    const dot = Math.abs(c0[0]! * Math.SQRT1_2 + c0[1]! * Math.SQRT1_2);
    expect(dot).toBeGreaterThan(0.99);
    // Variance along component 0 dominates component 1.
    let v0 = 0;
    let v1 = 0;
    for (let i = 0; i < n; i++) {
      v0 += projected[i * 2]! ** 2;
      v1 += projected[i * 2 + 1]! ** 2;
    }
    expect(v0).toBeGreaterThan(v1 * 10);
  });
});

describe("BASED-EMBED-PIPELINE: k-means auto-k", () => {
  test("finds k=3 on three separated blobs and labels them consistently", () => {
    const rand = mulberry32(9);
    const pts: number[] = [];
    blob(pts, rand, [0, 0, 0, 0], 60);
    blob(pts, rand, [5, 5, 0, 0], 60);
    blob(pts, rand, [0, 5, 5, 5], 60);
    const data = new Float32Array(pts);
    const { k, labels, centroids } = kmeansAuto(data, 180, 4, 42);
    expect(k).toBe(3);
    expect(labels.length).toBe(180);
    expect(centroids.length).toBe(3 * 4);
    // Every blob maps to exactly one label.
    for (let b = 0; b < 3; b++) {
      const slice = Array.from(labels.slice(b * 60, (b + 1) * 60));
      expect(new Set(slice).size).toBe(1);
    }
    // And the three labels are distinct.
    expect(new Set([labels[0], labels[60], labels[120]]).size).toBe(3);
  });

  test("is deterministic under a fixed seed and degrades to k=1 for tiny n", () => {
    const rand = mulberry32(5);
    const pts: number[] = [];
    blob(pts, rand, [0, 0], 30);
    blob(pts, rand, [4, 4], 30);
    const data = new Float32Array(pts);
    const r1 = kmeansAuto(data, 60, 2, 7);
    const r2 = kmeansAuto(data, 60, 2, 7);
    expect(Array.from(r1.labels)).toEqual(Array.from(r2.labels));
    expect(r1.k).toBe(2);

    const tiny = new Float32Array([0, 0, 1, 1, 2, 2]);
    const rt = kmeansAuto(tiny, 3, 2, 7);
    expect(rt.k).toBe(1);
    expect(Array.from(rt.labels)).toEqual([0, 0, 0]);
  });
});

describe("BASED-EMBED-PIPELINE: TF-IDF cluster terms", () => {
  test("surfaces distinctive terms per cluster, skipping stopwords", () => {
    const docs = [
      "the invoice for the payment is overdue",
      "payment overdue on invoice again",
      "invoice payment received",
      "shipping label printed for the parcel",
      "parcel shipping delayed",
      "the parcel shipping arrived",
    ];
    const labels = Int16Array.from([0, 0, 0, 1, 1, 1]);
    const terms = tfidfTopTerms(docs, labels, 2, 3);
    expect(terms.length).toBe(2);
    expect(terms[0]!.join(" ")).toMatch(/invoice|payment|overdue/);
    expect(terms[1]!.join(" ")).toMatch(/shipping|parcel/);
    expect(terms[0]!.join(" ")).not.toMatch(/\bthe\b|\bfor\b|\bis\b/);
    // null docs are tolerated
    const withNulls = tfidfTopTerms([null, "alpha beta", null, "gamma delta"], Int16Array.from([0, 0, 1, 1]), 2, 2);
    expect(withNulls.length).toBe(2);
  });
});

describe("BASED-EMBED-PIPELINE: cosine kNN", () => {
  test("returns the known nearest neighbours, excluding the query row", () => {
    // Rows 0 and 1 nearly parallel; row 2 orthogonal; row 3 opposite.
    const data = new Float32Array([
      1, 0, 0.01,
      1, 0.02, 0,
      0, 1, 0,
      -1, 0, 0,
    ]);
    const { indices, scores } = cosineTopK(data, 4, 3, 0, 2);
    expect(Array.from(indices)).toEqual([1, 2]);
    expect(scores[0]!).toBeGreaterThan(0.99);
    expect(Array.from(indices)).not.toContain(0);
  });
});

describe("BASED-EMBED-PIPELINE: position normalization", () => {
  test("maps positions into a centered [-500,500] box preserving aspect", () => {
    const pos = new Float32Array([10, 100, 0, 20, 100, 0, 30, 140, 0]);
    normalizePositions(pos, 3, 3, 500);
    let maxAbs = 0;
    for (const v of pos) maxAbs = Math.max(maxAbs, Math.abs(v));
    expect(maxAbs).toBeGreaterThan(499);
    expect(maxAbs).toBeLessThanOrEqual(500);
    // Centered: mean ≈ 0 on the dominant axis.
    const meanY = (pos[1]! + pos[4]! + pos[7]!) / 3;
    expect(Math.abs(meanY)).toBeLessThan(120);
  });
});
