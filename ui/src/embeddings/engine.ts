// Traces: BASED-EMBED-PIPELINE, BASED-EMBED-VECTORS
// Main-thread owner of one table tab's embeddings run: fetches the binary vector sample, drives
// the layout worker, and exposes an immutable snapshot for useSyncExternalStore. Engines live in a
// module registry keyed by tab id — NOT React state — so switching the tab's sub-view (or
// unmounting the canvas) never kills an in-flight UMAP; closing the tab does, via a single store
// subscription that disposes engines whose tab id has vanished.
import { useSyncExternalStore } from "react";
import { fetchTableVectors } from "../api/client";
import { cellText, type VectorSampleHeader } from "../api/types";
import { useStore } from "../store";
import type { MainToWorker, WorkerToMain } from "./protocol";

export interface EmbeddingsRunParams {
  connId: string;
  schema: string;
  table: string;
  column: string;
  limit: number;
  seed: number;
  /** Index into header.columns supplying tooltip/TF-IDF text, or null when the table has none. */
  textColumnIndex: number | null;
}

export interface EmbeddingsSnapshot {
  status: "idle" | "fetching" | "reducing" | "ready" | "error";
  stage: "project" | "pca" | "umap" | "cluster" | "tfidf" | null;
  epoch: number;
  totalEpochs: number;
  /** Latest n×3 layout (live during UMAP); version bumps every update so canvases re-upload. */
  positions: Float32Array | null;
  positionsVersion: number;
  header: VectorSampleHeader | null;
  n: number;
  pcaOnly: boolean;
  clusters: { k: number; labels: Int16Array; centroids: Float32Array } | null;
  /** TF-IDF top terms per cluster (instant labels). */
  terms: string[][] | null;
  /** AI-generated cluster names, once the user asks for them (BASED-EMBED-LABELS-AI). */
  aiLabels: string[] | null;
  similar: { index: number; indices: Int32Array; scores: Float32Array } | null;
  error: string | null;
  params: EmbeddingsRunParams | null;
}

const IDLE: EmbeddingsSnapshot = {
  status: "idle",
  stage: null,
  epoch: 0,
  totalEpochs: 0,
  positions: null,
  positionsVersion: 0,
  header: null,
  n: 0,
  pcaOnly: false,
  clusters: null,
  terms: null,
  aiLabels: null,
  similar: null,
  error: null,
  params: null,
};

interface CachedRun {
  header: VectorSampleHeader;
  n: number;
  positions: Float32Array;
  pcaOnly: boolean;
  clusters: EmbeddingsSnapshot["clusters"];
  terms: string[][] | null;
  aiLabels: string[] | null;
  data50: Float32Array;
  reducedDim: number;
}

const CACHE_MAX = 3;
const cache = new Map<string, CachedRun>();

function cacheKey(p: EmbeddingsRunParams): string {
  return [p.connId, p.schema, p.table, p.column, p.limit, p.seed].join("|");
}

function cachePut(key: string, run: CachedRun): void {
  cache.delete(key);
  cache.set(key, run);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
}

export class EmbeddingsEngine {
  private worker: Worker | null = null;
  private gen = 0;
  private snap: EmbeddingsSnapshot = IDLE;
  private listeners = new Set<() => void>();
  /** Reduced-space block retained for worker re-seeding after a cache hit. */
  private data50: Float32Array | null = null;
  private reducedDim = 0;
  private docs: (string | null)[] | null = null;

  getSnapshot = (): EmbeddingsSnapshot => this.snap;

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  private set(patch: Partial<EmbeddingsSnapshot>): void {
    this.snap = { ...this.snap, ...patch };
    for (const cb of this.listeners) cb();
  }

  private ensureWorker(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
      this.worker.onmessage = (e: MessageEvent<WorkerToMain>) => this.onMessage(e.data);
      this.worker.onerror = (e) => this.set({ status: "error", error: e.message || "Layout worker crashed" });
    }
    return this.worker;
  }

  private postToWorker(msg: MainToWorker, transfer: Transferable[] = []): void {
    this.ensureWorker().postMessage(msg, transfer);
  }

  async run(params: EmbeddingsRunParams): Promise<void> {
    this.gen++;
    const gen = this.gen;
    const key = cacheKey(params);
    const cached = cache.get(key);
    if (cached) {
      this.data50 = cached.data50;
      this.reducedDim = cached.reducedDim;
      this.docs = this.buildDocs(cached.header, params.textColumnIndex);
      // A fresh worker (if any) needs the reduced space back for findSimilar.
      if (this.worker) this.postToWorker({ type: "cancel", gen });
      this.snap = {
        ...IDLE,
        status: "ready",
        positions: cached.positions,
        positionsVersion: this.snap.positionsVersion + 1,
        header: cached.header,
        n: cached.n,
        pcaOnly: cached.pcaOnly,
        clusters: cached.clusters,
        terms: cached.terms,
        aiLabels: cached.aiLabels,
        params,
      };
      for (const cb of this.listeners) cb();
      return;
    }

    this.set({ ...IDLE, status: "fetching", params, positionsVersion: this.snap.positionsVersion });
    try {
      const { header, vectors } = await fetchTableVectors(params.schema, params.table, params.column, params.limit);
      if (gen !== this.gen) return;
      this.docs = this.buildDocs(header, params.textColumnIndex);
      this.set({ status: "reducing", header, n: header.count });
      // Copy into a transferable buffer (the fetch view shares the response's larger ArrayBuffer).
      const block = vectors.slice();
      this.postToWorker(
        {
          type: "run",
          gen,
          vectors: block,
          dim: header.dim,
          n: header.count,
          seed: params.seed,
          docs: this.docs,
          params: { nNeighbors: 15, minDist: 0.1 },
        },
        [block.buffer],
      );
    } catch (err) {
      if (gen !== this.gen) return;
      this.set({ status: "error", error: err instanceof Error ? err.message : String(err) });
    }
  }

  private buildDocs(header: VectorSampleHeader, textColumnIndex: number | null): (string | null)[] | null {
    if (textColumnIndex == null || textColumnIndex < 0) return null;
    return header.rows.map((row) => {
      const v = row[textColumnIndex];
      return v == null ? null : typeof v === "string" ? v : cellText(v);
    });
  }

  private onMessage(msg: WorkerToMain): void {
    if (msg.gen !== this.gen) return; // stale generation — a newer run superseded it
    switch (msg.type) {
      case "progress":
        this.set({ stage: msg.stage });
        break;
      case "pca-done":
        break;
      case "umap-epoch":
        this.set({
          stage: "umap",
          epoch: msg.epoch,
          totalEpochs: msg.total,
          positions: msg.positions,
          positionsVersion: this.snap.positionsVersion + 1,
        });
        break;
      case "umap-done":
        this.set({
          positions: msg.positions,
          positionsVersion: this.snap.positionsVersion + 1,
          pcaOnly: msg.pcaOnly,
          epoch: this.snap.totalEpochs,
        });
        break;
      case "clusters-done": {
        this.data50 = msg.data50;
        this.reducedDim = msg.reducedDim;
        const clusters = { k: msg.k, labels: msg.labels, centroids: msg.centroids };
        this.set({ status: "ready", stage: null, clusters });
        this.commitCache();
        break;
      }
      case "tfidf-done":
        this.set({ terms: msg.terms });
        this.commitCache();
        break;
      case "similar-done":
        this.set({ similar: { index: msg.index, indices: msg.indices, scores: msg.scores } });
        break;
      case "error":
        this.set({ status: "error", error: msg.message, stage: null });
        break;
    }
  }

  private commitCache(): void {
    const s = this.snap;
    if (!s.params || !s.header || !s.positions || !this.data50) return;
    cachePut(cacheKey(s.params), {
      header: s.header,
      n: s.n,
      positions: s.positions,
      pcaOnly: s.pcaOnly,
      clusters: s.clusters,
      terms: s.terms,
      aiLabels: s.aiLabels,
      data50: this.data50,
      reducedDim: this.reducedDim,
    });
  }

  findSimilar(index: number, k = 25): void {
    if (this.snap.status !== "ready" || !this.data50) return;
    // A worker recreated after a cache hit has no reduced space — re-seed it first.
    if (!this.worker) {
      const seedBlock = this.data50.slice();
      this.postToWorker({ type: "seed", gen: this.gen, data50: seedBlock, n: this.snap.n, reducedDim: this.reducedDim }, [
        seedBlock.buffer,
      ]);
    }
    this.postToWorker({ type: "findSimilar", gen: this.gen, index, k });
  }

  clearSimilar(): void {
    if (this.snap.similar) this.set({ similar: null });
  }

  setAiLabels(labels: string[]): void {
    this.set({ aiLabels: labels });
    this.commitCache();
  }

  cancel(): void {
    this.gen++;
    if (this.worker) this.postToWorker({ type: "cancel", gen: this.gen });
    if (this.snap.status === "fetching" || this.snap.status === "reducing") {
      this.set({ status: this.snap.positions ? "ready" : "idle", stage: null });
    }
  }

  dispose(): void {
    this.gen++;
    this.worker?.terminate();
    this.worker = null;
    this.data50 = null;
    this.listeners.clear();
    this.snap = IDLE;
  }
}

const registry = new Map<string, EmbeddingsEngine>();
let watching = false;

/** Dispose engines whose tab has been closed. One store subscription for the whole registry. */
function watchTabs(): void {
  if (watching) return;
  watching = true;
  useStore.subscribe((state) => {
    if (registry.size === 0) return;
    const open = new Set(state.tabs.map((t) => t.id));
    for (const [tabId, engine] of registry) {
      if (!open.has(tabId)) {
        engine.dispose();
        registry.delete(tabId);
      }
    }
  });
}

export function embeddingsEngineFor(tabId: string): EmbeddingsEngine {
  watchTabs();
  let engine = registry.get(tabId);
  if (!engine) {
    engine = new EmbeddingsEngine();
    registry.set(tabId, engine);
  }
  return engine;
}

export function useEmbeddingsEngine(tabId: string): { engine: EmbeddingsEngine; snap: EmbeddingsSnapshot } {
  const engine = embeddingsEngineFor(tabId);
  const snap = useSyncExternalStore(engine.subscribe, engine.getSnapshot);
  return { engine, snap };
}
