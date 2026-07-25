// Traces: BASED-EMBED-PIPELINE
// Message contract between the Embeddings engine (main thread) and its worker. Every message
// carries `gen`, a monotonically increasing run-generation token: the worker silently drops work
// for any generation older than the newest it has seen, which is how param changes and re-runs
// cancel an in-flight layout without tearing down the worker.

export interface RunParams {
  /** UMAP neighbourhood size; clamped worker-side for tiny samples. */
  nNeighbors: number;
  minDist: number;
  /** Cap on UMAP epochs; 0/absent = umap-js's own heuristic. */
  epochs?: number;
}

export type MainToWorker =
  | {
      type: "run";
      gen: number;
      /** Raw n×dim row-major floats — transferred, the main-thread copy is neutered. */
      vectors: Float32Array;
      dim: number;
      n: number;
      seed: number;
      /** Text snippet per row (or null) feeding TF-IDF; null = table has no text column. */
      docs: (string | null)[] | null;
      params: RunParams;
    }
  | {
      /** Re-seed a fresh worker from a cached run so findSimilar works after a tab reopen. */
      type: "seed";
      gen: number;
      data50: Float32Array;
      n: number;
      reducedDim: number;
    }
  | { type: "findSimilar"; gen: number; index: number; k: number }
  | { type: "cancel"; gen: number };

export type WorkerToMain =
  | { type: "progress"; gen: number; stage: "project" | "pca" | "umap" | "cluster" | "tfidf"; pct: number }
  | { type: "pca-done"; gen: number; ms: number }
  | {
      type: "umap-epoch";
      gen: number;
      epoch: number;
      total: number;
      /** n×3, normalized to the fixed [-500,500] box; a fresh transferred copy per post. */
      positions: Float32Array;
    }
  | { type: "umap-done"; gen: number; positions: Float32Array; pcaOnly: boolean }
  | {
      type: "clusters-done";
      gen: number;
      k: number;
      labels: Int16Array;
      /** k×3 centroids in layout space. */
      centroids: Float32Array;
      /** n×reducedDim PCA space (transferred copy) — cached main-side for engine re-seeding. */
      data50: Float32Array;
      reducedDim: number;
    }
  | { type: "tfidf-done"; gen: number; terms: string[][] }
  | { type: "similar-done"; gen: number; index: number; indices: Int32Array; scores: Float32Array }
  | { type: "error"; gen: number; message: string };
