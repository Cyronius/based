// Traces: BASED-EMBED-PIPELINE
// Pure math core of the Embeddings view. Everything operates on flat row-major Float32Arrays and
// takes an explicit seed, so the exact same code runs inside the worker and headless under bun,
// and a given table + seed always produces the identical layout. No DOM, no worker APIs, no deps.

/** Small fast seeded PRNG (32-bit state), uniform in [0,1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seeded standard normal via Box-Muller. */
function gaussian(rand: () => number): () => number {
  let spare: number | null = null;
  return () => {
    if (spare !== null) {
      const v = spare;
      spare = null;
      return v;
    }
    let u = 0;
    let v = 0;
    while (u === 0) u = rand();
    v = rand();
    const r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  };
}

/** Johnson–Lindenstrauss random projection n×dim → n×outDim. Distance-preserving in expectation;
 *  used to knock 768/1536-dim embeddings down to ~100 before exact PCA becomes affordable. */
export function randomProject(data: Float32Array, n: number, dim: number, outDim: number, seed: number): Float32Array {
  const g = gaussian(mulberry32(seed));
  const scale = 1 / Math.sqrt(outDim);
  const R = new Float32Array(dim * outDim);
  for (let i = 0; i < R.length; i++) R[i] = g() * scale;
  const out = new Float32Array(n * outDim);
  for (let i = 0; i < n; i++) {
    const row = i * dim;
    const orow = i * outDim;
    for (let j = 0; j < dim; j++) {
      const x = data[row + j]!;
      if (x === 0) continue;
      const rrow = j * outDim;
      for (let k = 0; k < outDim; k++) out[orow + k] += x * R[rrow + k]!;
    }
  }
  return out;
}

/** Exact PCA via covariance + orthogonalized subspace iteration. Returns the projected n×outDim
 *  data and the components (component-major: component k occupies [k*dim, (k+1)*dim)), ordered by
 *  descending explained variance. Intended for dim ≤ ~100 (random-project first above that). */
export function pca(
  data: Float32Array,
  n: number,
  dim: number,
  outDim: number,
  seed: number,
): { projected: Float32Array; components: Float32Array } {
  const k = Math.min(outDim, dim, n);
  const mean = new Float64Array(dim);
  for (let i = 0; i < n; i++) for (let j = 0; j < dim; j++) mean[j]! += data[i * dim + j]!;
  for (let j = 0; j < dim; j++) mean[j]! /= n;

  const centered = new Float64Array(n * dim);
  for (let i = 0; i < n; i++) for (let j = 0; j < dim; j++) centered[i * dim + j] = data[i * dim + j]! - mean[j]!;

  // Covariance (dim×dim, symmetric).
  const cov = new Float64Array(dim * dim);
  const denom = Math.max(1, n - 1);
  for (let i = 0; i < n; i++) {
    const row = i * dim;
    for (let a = 0; a < dim; a++) {
      const xa = centered[row + a]!;
      if (xa === 0) continue;
      for (let b = a; b < dim; b++) cov[a * dim + b]! += xa * centered[row + b]!;
    }
  }
  for (let a = 0; a < dim; a++) {
    for (let b = a; b < dim; b++) {
      const v = cov[a * dim + b]! / denom;
      cov[a * dim + b] = v;
      cov[b * dim + a] = v;
    }
  }

  // Subspace iteration: Q ← orth(C·Q), columns stored component-major in q[c*dim + j].
  const rand = mulberry32(seed);
  let q = new Float64Array(k * dim);
  for (let i = 0; i < q.length; i++) q[i] = rand() - 0.5;
  const z = new Float64Array(k * dim);
  for (let iter = 0; iter < 60; iter++) {
    for (let c = 0; c < k; c++) {
      for (let a = 0; a < dim; a++) {
        let s = 0;
        for (let b = 0; b < dim; b++) s += cov[a * dim + b]! * q[c * dim + b]!;
        z[c * dim + a] = s;
      }
    }
    // Modified Gram-Schmidt.
    for (let c = 0; c < k; c++) {
      for (let p = 0; p < c; p++) {
        let dot = 0;
        for (let j = 0; j < dim; j++) dot += z[c * dim + j]! * z[p * dim + j]!;
        for (let j = 0; j < dim; j++) z[c * dim + j]! -= dot * z[p * dim + j]!;
      }
      let norm = 0;
      for (let j = 0; j < dim; j++) norm += z[c * dim + j]! ** 2;
      norm = Math.sqrt(norm) || 1;
      for (let j = 0; j < dim; j++) z[c * dim + j]! /= norm;
    }
    q.set(z);
  }

  // Order components by Rayleigh quotient (explained variance), descending.
  const lambda = new Array<number>(k).fill(0);
  for (let c = 0; c < k; c++) {
    let s = 0;
    for (let a = 0; a < dim; a++) {
      let cq = 0;
      for (let b = 0; b < dim; b++) cq += cov[a * dim + b]! * q[c * dim + b]!;
      s += cq * q[c * dim + a]!;
    }
    lambda[c] = s;
  }
  const order = lambda.map((v, i) => [v, i] as const).sort((x, y) => y[0] - x[0]).map(([, i]) => i);

  const components = new Float32Array(k * dim);
  for (let c = 0; c < k; c++) for (let j = 0; j < dim; j++) components[c * dim + j] = q[order[c]! * dim + j]!;

  const projected = new Float32Array(n * k);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < k; c++) {
      let s = 0;
      for (let j = 0; j < dim; j++) s += centered[i * dim + j]! * components[c * dim + j]!;
      projected[i * k + c] = s;
    }
  }
  return { projected, components };
}

function lloyd(
  data: Float32Array,
  n: number,
  dim: number,
  k: number,
  rand: () => number,
): { labels: Int16Array; centroids: Float64Array; inertia: number } {
  // k-means++ init.
  const centroids = new Float64Array(k * dim);
  const dist2 = new Float64Array(n).fill(Infinity);
  let first = Math.floor(rand() * n);
  for (let j = 0; j < dim; j++) centroids[j] = data[first * dim + j]!;
  for (let c = 1; c < k; c++) {
    let total = 0;
    for (let i = 0; i < n; i++) {
      let d = 0;
      for (let j = 0; j < dim; j++) d += (data[i * dim + j]! - centroids[(c - 1) * dim + j]!) ** 2;
      if (d < dist2[i]!) dist2[i] = d;
      total += dist2[i]!;
    }
    let target = rand() * total;
    let pick = n - 1;
    for (let i = 0; i < n; i++) {
      target -= dist2[i]!;
      if (target <= 0) {
        pick = i;
        break;
      }
    }
    for (let j = 0; j < dim; j++) centroids[c * dim + j] = data[pick * dim + j]!;
  }

  const labels = new Int16Array(n);
  const counts = new Int32Array(k);
  let inertia = 0;
  for (let iter = 0; iter < 60; iter++) {
    let moved = 0;
    inertia = 0;
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < k; c++) {
        let d = 0;
        for (let j = 0; j < dim; j++) d += (data[i * dim + j]! - centroids[c * dim + j]!) ** 2;
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      if (labels[i] !== best) {
        labels[i] = best;
        moved++;
      }
      inertia += bestD;
    }
    centroids.fill(0);
    counts.fill(0);
    for (let i = 0; i < n; i++) {
      const c = labels[i]!;
      counts[c]!++;
      for (let j = 0; j < dim; j++) centroids[c * dim + j]! += data[i * dim + j]!;
    }
    for (let c = 0; c < k; c++) {
      if (counts[c] === 0) {
        // Empty cluster: reseat on a random point so k stays honest.
        const p = Math.floor(rand() * n);
        for (let j = 0; j < dim; j++) centroids[c * dim + j] = data[p * dim + j]!;
      } else {
        for (let j = 0; j < dim; j++) centroids[c * dim + j]! /= counts[c]!;
      }
    }
    if (moved === 0 && iter > 0) break;
  }
  return { labels, centroids, inertia };
}

/** k-means++ with automatic k: maximizes the Calinski-Harabasz index over k=2..12 (bounded by n).
 *  Tiny inputs (n<8) collapse to a single cluster. Deterministic under a fixed seed. */
export function kmeansAuto(
  data: Float32Array,
  n: number,
  dim: number,
  seed: number,
  kMax = 12,
): { k: number; labels: Int16Array; centroids: Float32Array } {
  if (n < 8) {
    const centroid = new Float32Array(dim);
    for (let i = 0; i < n; i++) for (let j = 0; j < dim; j++) centroid[j]! += data[i * dim + j]! / Math.max(1, n);
    return { k: 1, labels: new Int16Array(n), centroids: centroid };
  }
  const mean = new Float64Array(dim);
  for (let i = 0; i < n; i++) for (let j = 0; j < dim; j++) mean[j]! += data[i * dim + j]!;
  for (let j = 0; j < dim; j++) mean[j]! /= n;

  let best: { k: number; labels: Int16Array; centroids: Float64Array; score: number } | null = null;
  const upper = Math.min(kMax, Math.floor(n / 2));
  for (let k = 2; k <= upper; k++) {
    const { labels, centroids, inertia } = lloyd(data, n, dim, k, mulberry32(seed + k * 7919));
    // Between-cluster dispersion.
    const counts = new Int32Array(k);
    for (let i = 0; i < n; i++) counts[labels[i]!]!++;
    let between = 0;
    for (let c = 0; c < k; c++) {
      let d = 0;
      for (let j = 0; j < dim; j++) d += (centroids[c * dim + j]! - mean[j]!) ** 2;
      between += counts[c]! * d;
    }
    const within = Math.max(inertia, 1e-12);
    const score = (between / (k - 1)) / (within / (n - k));
    if (!best || score > best.score) best = { k, labels, centroids, score };
  }
  const b = best!;
  return { k: b.k, labels: b.labels, centroids: Float32Array.from(b.centroids) };
}

const STOPWORDS = new Set(
  (
    "a an and are as at be but by for from has have if in into is it its of on or not no so such " +
    "that the their then there these they this to was were will with you your we our i he she his " +
    "her them us am do does did done can could should would may might about after again all also " +
    "any because been before being between both down during each few further here how more most " +
    "other out over own same some than too under until up very what when where which while who why"
  ).split(" "),
);

function tokenize(doc: string): string[] {
  return (doc.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}']+/gu) ?? []).filter((t) => !STOPWORDS.has(t));
}

/** Top distinctive terms per cluster: within-cluster term frequency × inverse document frequency
 *  over the whole sample. Null docs (rows without a text column) are simply skipped. */
export function tfidfTopTerms(
  docs: ReadonlyArray<string | null>,
  labels: ArrayLike<number>,
  k: number,
  topN = 4,
): string[][] {
  const df = new Map<string, number>();
  let docCount = 0;
  const tokenized: (string[] | null)[] = docs.map((d) => {
    if (d == null) return null;
    docCount++;
    const toks = tokenize(d);
    for (const t of new Set(toks)) df.set(t, (df.get(t) ?? 0) + 1);
    return toks;
  });
  const result: string[][] = [];
  for (let c = 0; c < k; c++) {
    const tf = new Map<string, number>();
    for (let i = 0; i < tokenized.length; i++) {
      if (labels[i] !== c) continue;
      const toks = tokenized[i];
      if (!toks) continue;
      for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
    }
    const scored = [...tf.entries()]
      .map(([t, f]) => [t, f * Math.log((docCount + 1) / (df.get(t)! + 0.5))] as const)
      .sort((a, b) => b[1] - a[1]);
    result.push(scored.slice(0, topN).map(([t]) => t));
  }
  return result;
}

/** Exact cosine k-nearest-neighbours of one row against the whole sample (query row excluded). */
export function cosineTopK(
  data: Float32Array,
  n: number,
  dim: number,
  queryIdx: number,
  topK: number,
): { indices: Int32Array; scores: Float32Array } {
  const qrow = queryIdx * dim;
  let qnorm = 0;
  for (let j = 0; j < dim; j++) qnorm += data[qrow + j]! ** 2;
  qnorm = Math.sqrt(qnorm) || 1;
  const scored: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    if (i === queryIdx) continue;
    let dot = 0;
    let norm = 0;
    const row = i * dim;
    for (let j = 0; j < dim; j++) {
      dot += data[row + j]! * data[qrow + j]!;
      norm += data[row + j]! ** 2;
    }
    scored.push([dot / (qnorm * (Math.sqrt(norm) || 1)), i]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  const take = Math.min(topK, scored.length);
  const indices = new Int32Array(take);
  const scores = new Float32Array(take);
  for (let i = 0; i < take; i++) {
    indices[i] = scored[i]![1];
    scores[i] = scored[i]![0];
  }
  return { indices, scores };
}

/** Center positions and scale uniformly (aspect-preserving) so the widest axis spans [-extent,
 *  extent]. In place; run after every UMAP epoch so the deck.gl view never needs refitting. */
export function normalizePositions(pos: Float32Array, n: number, dims: number, extent = 500): void {
  if (n === 0) return;
  const mean = new Float64Array(dims);
  for (let i = 0; i < n; i++) for (let j = 0; j < dims; j++) mean[j]! += pos[i * dims + j]!;
  for (let j = 0; j < dims; j++) mean[j]! /= n;
  let maxAbs = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < dims; j++) {
      const v = pos[i * dims + j]! - mean[j]!;
      pos[i * dims + j] = v;
      if (Math.abs(v) > maxAbs) maxAbs = Math.abs(v);
    }
  }
  const scale = maxAbs > 0 ? extent / maxAbs : 1;
  for (let i = 0; i < n * dims; i++) pos[i] = pos[i]! * scale;
}
