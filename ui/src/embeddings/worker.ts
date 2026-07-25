/// <reference lib="webworker" />
// Traces: BASED-EMBED-PIPELINE
// The Embeddings layout worker: random-projection → PCA → UMAP (epoch-streamed) → k-means →
// TF-IDF, all off the main thread. Generation tokens (see protocol.ts) make cancellation soft:
// a newer `gen` simply outruns the old one, and stale stages abort at their next checkpoint.
import { UMAP } from "umap-js";
import {
  cosineTopK,
  kmeansAuto,
  mulberry32,
  normalizePositions,
  pca,
  randomProject,
  tfidfTopTerms,
} from "./pipeline";
import type { MainToWorker, WorkerToMain } from "./protocol";

const PROJECT_DIM = 100;
const PCA_DIM = 50;
const UMAP_MIN_ROWS = 50;
const EPOCH_POST_MS = 80;

let currentGen = -1;
/** Reduced-space cache for findSimilar; survives across runs, replaced per generation. */
let cache: { data50: Float32Array; n: number; reducedDim: number } | null = null;

function post(msg: WorkerToMain, transfer: Transferable[] = []): void {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg, transfer);
}

const yieldMacrotask = () => new Promise<void>((r) => setTimeout(r, 0));

/** Flat n×k → number[][] (umap-js's input shape). */
function toRows(data: Float32Array, n: number, k: number): number[][] {
  const rows = new Array<number[]>(n);
  for (let i = 0; i < n; i++) rows[i] = Array.from(data.subarray(i * k, (i + 1) * k));
  return rows;
}

/** Layout positions as a normalized n×3 flat block (z=0 when the source has <3 components). */
function toPositions(rows: ArrayLike<ArrayLike<number>>, n: number): Float32Array {
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const r = rows[i]!;
    out[i * 3] = r[0] ?? 0;
    out[i * 3 + 1] = r[1] ?? 0;
    out[i * 3 + 2] = r[2] ?? 0;
  }
  normalizePositions(out, n, 3);
  return out;
}

async function run(msg: Extract<MainToWorker, { type: "run" }>): Promise<void> {
  const { gen, dim, n, seed, docs, params } = msg;
  let data = msg.vectors;

  // Stage 1: knock very high dims down before exact PCA.
  let reducedDim = dim;
  if (dim > PROJECT_DIM) {
    post({ type: "progress", gen, stage: "project", pct: 0 });
    data = randomProject(data, n, dim, PROJECT_DIM, seed);
    reducedDim = PROJECT_DIM;
  }
  if (gen !== currentGen) return;

  // Stage 2: exact PCA to the working space.
  post({ type: "progress", gen, stage: "pca", pct: 0 });
  const t0 = performance.now();
  const pcaDim = Math.min(PCA_DIM, reducedDim, n);
  const { projected: data50 } = pca(data, n, reducedDim, pcaDim, seed);
  cache = { data50, n, reducedDim: pcaDim };
  post({ type: "pca-done", gen, ms: performance.now() - t0 });
  if (gen !== currentGen) return;

  // Stage 3: UMAP with epoch streaming — or straight PCA for tiny tables where UMAP is noise.
  let positions: Float32Array;
  let pcaOnly = false;
  if (n < UMAP_MIN_ROWS) {
    positions = toPositions(toRows(data50, n, pcaDim), n);
    pcaOnly = true;
  } else {
    const umap = new UMAP({
      nComponents: 3,
      nNeighbors: Math.min(params.nNeighbors, Math.max(2, Math.floor((n - 1) / 3))),
      minDist: params.minDist,
      random: mulberry32(seed),
    });
    const rows = toRows(data50, n, pcaDim);
    const suggested = umap.initializeFit(rows);
    const total = params.epochs && params.epochs > 0 ? Math.min(params.epochs, suggested) : suggested;
    let lastPost = 0;
    for (let epoch = 0; epoch < total; epoch++) {
      if (gen !== currentGen) return;
      umap.step();
      const now = performance.now();
      if (now - lastPost >= EPOCH_POST_MS) {
        lastPost = now;
        const snapshot = toPositions(umap.getEmbedding(), n);
        post({ type: "umap-epoch", gen, epoch, total, positions: snapshot }, [snapshot.buffer]);
      }
      // Yield so cancel/newer-run messages can preempt between epochs.
      if (epoch % 5 === 0) await yieldMacrotask();
    }
    positions = toPositions(umap.getEmbedding(), n);
  }
  if (gen !== currentGen) return;
  post({ type: "umap-done", gen, positions, pcaOnly });

  // Stage 4: clusters in PCA space, centroids in layout space.
  post({ type: "progress", gen, stage: "cluster", pct: 0 });
  await yieldMacrotask();
  if (gen !== currentGen) return;
  const { k, labels } = kmeansAuto(data50, n, pcaDim, seed);
  const centroids = new Float32Array(k * 3);
  const counts = new Int32Array(k);
  for (let i = 0; i < n; i++) {
    const c = labels[i]!;
    counts[c]!++;
    for (let j = 0; j < 3; j++) centroids[c * 3 + j]! += positions[i * 3 + j]!;
  }
  for (let c = 0; c < k; c++) {
    if (counts[c]! > 0) for (let j = 0; j < 3; j++) centroids[c * 3 + j]! /= counts[c]!;
  }
  const data50Copy = data50.slice();
  post({ type: "clusters-done", gen, k, labels, centroids, data50: data50Copy, reducedDim: pcaDim }, [
    data50Copy.buffer,
  ]);
  if (gen !== currentGen) return;

  // Stage 5: instant keyword labels (the AI naming pass is a separate, user-triggered endpoint).
  if (docs) {
    post({ type: "progress", gen, stage: "tfidf", pct: 0 });
    await yieldMacrotask();
    if (gen !== currentGen) return;
    post({ type: "tfidf-done", gen, terms: tfidfTopTerms(docs, labels, k) });
  }
}

self.onmessage = (e: MessageEvent<MainToWorker>) => {
  const msg = e.data;
  if (msg.type === "cancel") {
    if (msg.gen >= currentGen) currentGen = -1;
    return;
  }
  if (msg.gen > currentGen) currentGen = msg.gen;
  if (msg.type === "seed") {
    cache = { data50: msg.data50, n: msg.n, reducedDim: msg.reducedDim };
    return;
  }
  if (msg.type === "findSimilar") {
    if (!cache) {
      post({ type: "error", gen: msg.gen, message: "No layout loaded" });
      return;
    }
    const { indices, scores } = cosineTopK(cache.data50, cache.n, cache.reducedDim, msg.index, msg.k);
    post({ type: "similar-done", gen: msg.gen, index: msg.index, indices, scores });
    return;
  }
  if (msg.type === "run") {
    void run(msg).catch((err) => {
      post({ type: "error", gen: msg.gen, message: err instanceof Error ? err.message : String(err) });
    });
  }
};
