# LanceDB Embeddings Visualization ("Atlas" view)

## Context

LanceDB tables in `based` hold vector embeddings, but the app only shows them as truncated previews (`vec[768] [0.12, …]`). This feature adds an **Embeddings** sub-view to LanceDB table tabs: an interactive 2D/3D scatter of the table's vectors, dimensionality-reduced client-side, with cluster coloring, cluster labels (TF-IDF instantly, AI-generated on demand), hover tooltips, click-for-row-details, find-similar highlighting, and lasso selection. The signature visual: UMAP runs epoch-by-epoch in a web worker and every epoch is rendered, so points visibly condense from a random cloud into structure — the computation *is* the animation.

Decisions confirmed with user: **2D + 3D toggle** (deck.gl), **AI labels + TF-IDF fallback**, v1 interactions = hover, click-details, **find similar**, **lasso → row grid** (no color-by-column in v1).

## Design direction (frontend-skill)

Observatory, not chart. Full-bleed `bg0` canvas; points glow subtly (alpha-blended, radius 3px); cluster tints derived at runtime from the active theme's tokens (`accent`/`info`/`ok`/`err` + `mixHex` blends → up to 12 swatches), so all 40 themes look native. Cluster labels are theme-font HTML overlays at centroids that fade with zoom, like map labels. Selection dims everything else to `mixHex(bg1, text, 0.25)`; highlights pop in `accent`. Legend is a quiet chip row bottom-left; click a chip to isolate a cluster.

## Key decisions

| Decision | Choice | Why |
|---|---|---|
| Rendering | `@deck.gl/core` + `@deck.gl/layers` ^9.1, **non-React `Deck` on a manual canvas** | Imperative `setProps` per UMAP epoch avoids React renders per frame; no React-19 peer-dep surface |
| 2D / 3D | `OrthographicView` + `ScatterplotLayer` / `OrbitView` + `PointCloudLayer`; reduce to 3 components once, 2D uses first two | One lib, cheap toggle |
| DR | Seeded random projection dim→100 (when dim>100) → exact PCA →50 → `umap-js` ^1.4 →3, all in a worker | Exact PCA on 1536 dims too slow in JS; umap-js has `initializeFit()`/`step()` for epoch streaming + seedable `random` |
| Clustering | Hand-rolled k-means++ in 50-dim space, auto-k via Calinski-Harabasz over k=2..12 | ~120 lines, deterministic, instant; no dep |
| Find similar | Client-side cosine over cached 50-dim PCA space in the worker | Vectors already local; <10ms; no server round-trip; raw buffer can be freed after PCA |
| Wire format | `[u32 headerLen][JSON header (4-byte padded)][raw f32 block n×dim]`, single binary response | 60MB JSON avoided; floats don't compress; curl-testable |
| Sampling | `countRows()` → evenly-strided 1024-row chunks; default 5k points (selector 1k–20k); server budget 128MB vector bytes | LanceDB has no cheap random sample; umap-js slows past ~10k |
| Lasso | Hand-rolled SVG overlay + point-in-polygon over `viewport.project()`ed coords; 2D only | 60 lines vs a heavy community dep |
| Labels | HTML overlay divs at projected centroids, CSS opacity from zoom | ≤12 labels; free theme fonts; avoids `@deck.gl/extensions` |
| Determinism | Single `seed` (default 42) drives projection, UMAP, k-means | Reproducible layouts; makes unit tests possible |

New deps (ui only): `@deck.gl/core@^9.1`, `@deck.gl/layers@^9.1`, `umap-js@^1.4.0`. Core: none.

## Changes — core

- **`core/src/db/types.ts`** — add `VectorSampleResult { dim, count, totalRows, sampled, vectors: Float32Array, columns, rows }` and optional adapter method `readVectorSample?(schema, table, {column, limit, textCap?})`. Presence-gated like `search?`; no `EngineCapabilities` change.
- **`core/src/db/lanceAdapter.ts`** — implement `readVectorSample`: validate column via `getTableColumns` (`:267`), `t.countRows()`, clamp limit to `min(opts.limit, rowCap, floor(128MB/(dim*4)))`, strided `t.query().select([...]).offset(o).limit(1024).toArray()` chunks; skip null/ragged vectors; write floats straight into a preallocated `Float32Array` (bypass `serializeLanceValue`); non-vector strings capped at 2000 chars.
- **`core/src/db/vectorWire.ts`** (new, pure) — `encodeVectorSample()` binary encoder; unit-testable round trip.
- **`core/src/server.ts`** — two routes beside `/api/session/lance-search` (`:453`):
  - `GET /api/session/table-vectors?schema&table&column&limit` → octet-stream of `encodeVectorSample(...)`; 400 if adapter lacks the method.
  - `POST /api/session/label-clusters` → resolves model exactly like `agentStream` (`:918-925`: `activeAiProfile()` + `resolveModel(profile, getAiKey(profile.id))`), calls `labelClusters(...)`. Server-enforced cost guard: ≤24 clusters × ≤10 samples × ≤300 chars (truncate, don't reject). 60s `AbortSignal.timeout`.
- **`core/src/agent/labelClusters.ts`** (new) — pure `buildLabelPrompt(clusters)` / `parseLabelResponse(text, ids)` (extract first JSON array, per-cluster fallback to TF-IDF hint) + `labelClusters(model, clusters, signal)` using one `generateText` call — not the agent loop.

## Changes — ui

- **`ui/src/api/types.ts` / `client.ts`** — `VectorSampleHeader`, label-cluster types; `fetchTableVectors()` (arrayBuffer + inline decode: u32 headerLen, TextDecoder, `Float32Array` view over padded offset); `labelClusters()` via existing `api<T>` (`client.ts:59`).
- **`ui/src/store.ts:120`** — widen `TableTabState.view` to `"details" | "data" | "sql" | "embeddings"`; widen `setTableView` (`:859`). *Entire* store change.
- **`ui/src/components/TableDetailsView.tsx:251-283`** — 4th `tabBtn("embeddings", "Embeddings")`, shown only when `tab.columns?.some(c => c.isVector) && capabilities.search`; branch renders `<EmbeddingsView tab={tab}/>`.
- **`ui/src/embeddings/`** (new):
  - `pipeline.ts` — pure, no DOM: `mulberry32`, `randomProject`, `pca`, `kmeansAuto`, `tfidfTopTerms`, `cosineTopK`, all over flat Float32Arrays. **The testable heart.**
  - `protocol.ts` — worker message types (below).
  - `worker.ts` — Vite module worker running the pipeline; epoch streaming; generation-token cancellation.
  - `engine.ts` — module-level `Map<tabId, EmbeddingsEngine>`: owns worker + fetch + LRU(3) result cache keyed `connId|schema|table|column|limit|seed`; `useEmbeddingsEngine(tabId)` via `useSyncExternalStore`. Subscribes to the zustand store; disposes (terminate + evict) when the tab id disappears — so **sub-view switches survive an in-flight run; tab close cleans up**.
  - `colors.ts` — `embeddingPalette(k)` reading CSS vars per the `gridThemeFromCss` pattern ([theme.ts:236-260](ui/src/theme.ts#L236-L260)), `mixHex` blends of accent/info/ok/err × text/muted; dim/highlight/bg colors.
- **`ui/src/components/embeddings/`** (new):
  - `EmbeddingsView.tsx` — orchestrator; toolbar + `PanelGroup` (mirrors DataView pattern [TableDetailsView.tsx:205-242](ui/src/components/TableDetailsView.tsx#L205-L242)): canvas center; collapsible bottom panel = `SelectionGrid` (lasso results); collapsible right panel = `PointDetailsPanel`.
  - `EmbeddingsCanvas.tsx` — owns the `Deck` instance (ref, never re-created); binary attributes (`data: {length, attributes: {getPosition, getFillColor}}`, `Uint8Array` colors rebuilt on cluster/selection/theme change); epoch animation = write positions + `deck.setProps({layers})`; picking (hover tooltip, click select); highlight via small second layer in accent; ResizeObserver; theme subscription per [TableDataGrid.tsx:157-159](ui/src/components/TableDataGrid.tsx#L157-L159). Positions normalized worker-side to a fixed [-500,500] box so view fitting is static.
  - `EmbeddingsToolbar.tsx` — [2D|3D] toggle, vector-column picker (when >1; default = column with index metric), text-column picker (default first string column), point-count selector, Run, lasso toggle (disabled in 3D), labels on/off, "AI label" button, progress/sample note ("5,000 of 182,340 rows").
  - `ClusterLabels.tsx` — projected-centroid divs, zoom-fade, pointer-events none.
  - `LassoOverlay.tsx` — SVG path capture; point-in-polygon on pointerup.
  - `PointDetailsPanel.tsx` — key/value list from downloaded row cells + "Find similar" button.
  - `SelectionGrid.tsx` — synthesizes `ResultSetData` from header columns + selected indices, renders existing `ResultGrid` (pass no-op `onSelectionData`/`onFitColumns`).

## Worker protocol

Main→worker (all carry `gen`): `run {vectors (transferred), dim, n, seed, docs, params}`, `findSimilar {index, k}`, `cancel`.
Worker→main: `progress {stage, pct}`, `pca-done`, `umap-epoch {epoch, total, positions (transferred copy, throttled ≥80ms)}`, `umap-done`, `clusters-done {k, labels, centroids}`, `tfidf-done {terms}`, `similar-done {indices, scores}`, `error`. UMAP loop yields a macrotask per epoch so `cancel`/newer `gen` can preempt; stale generations abort silently.

## Edge cases

Multiple vector columns → picker. Tiny tables: n<50 → PCA-only positions (toolbar notes it), `nNeighbors=min(15, floor(n/3))`, n<8 → single cluster. Null vectors dropped server-side (`count` vs `totalRows`). No text column → tooltip shows first scalar cells; TF-IDF/AI-label disabled with explanation. Raw vector buffer transferred to worker and freed after PCA; cache keeps only positions (n×12B) + data50 (n×200B) + row cells. AI-label failure → inline toolbar error, TF-IDF labels stay.

## Spec impact (spec-driven doctrine)

New requirements in `specs/based/spec.md` (copy of this plan → `specs/based/plans/`, archive on completion):

- **BASED-EMBED-WIRE** (unit) — binary encode/decode round trip incl. 4-byte alignment padding. `unit.vectorWire.test.ts`.
- **BASED-EMBED-VECTORS** (integration) — endpoint returns correct dim/count, finite floats, skips null vectors, clamps to byte budget, `sampled` flag. Extend `integration.lancedb.test.ts` fixtures.
- **BASED-EMBED-PIPELINE** (unit) — PCA recovers planted axis; k-means auto-k finds k=3 on synthetic blobs; TF-IDF top terms; determinism under fixed seed. `unit.embedPipeline.test.ts` (pipeline.ts is DOM-free, runs under bun/vitest).
- **BASED-EMBED-LABELS-AI** (unit + integration) — `buildLabelPrompt`/`parseLabelResponse` unit tests; endpoint integration test self-skips without an AI profile (existing agent-test convention).
- **BASED-EMBED-UI** (manual) — documented procedure: open LanceDB table with vectors → Embeddings button appears (absent on MSSQL/vector-less tables); Run → galaxy-condensing animation; 3D toggle orbits; hover/click/find-similar/lasso→grid work; theme switch recolors live; tiny-table PCA fallback message.

## Build order (each step verifiable)

1. Wire + endpoint (core): types, `readVectorSample`, `vectorWire.ts`, route. Verify via curl `--output` + unit/integration tests.
2. `pipeline.ts` + unit tests (headless).
3. Client decode + `engine.ts` + `worker.ts` (no rendering) — temporary epoch-counter log in a stub view.
4. 2D canvas + epoch animation + view switcher wiring. Manual: galaxy condenses.
5. 3D toggle, clustering colors, TF-IDF labels, legend, theme subscription.
6. Interactions: hover/click/details/find-similar/lasso/SelectionGrid.
7. AI labeling endpoint + button + tests.
8. Polish, spec.md updates, manual-procedure PASS record, archive plan.

## Verification

- `bun test` from `specs/` (new unit + integration tests above; integration needs the dev LanceDB fixture DB).
- Manual end-to-end per BASED-EMBED-UI procedure using the dev LanceDB connection; check a dark, a midtone, and a light theme.
- Memory sanity: open a 768-dim table at 20k points, run, switch sub-views mid-run (must survive), close tab (worker must terminate — check no orphan in devtools).
