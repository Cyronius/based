// Traces: BASED-EMBED-UI, BASED-EMBED-LABELS-AI
// The Embeddings sub-view of a table tab: an observatory over the table's vector space. Layout
// runs in the engine's worker (survives sub-view switches); this component is presentation —
// toolbar, deck.gl canvas, cluster labels, legend, tooltip, lasso, details + selection panels.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle, type ImperativePanelHandle } from "react-resizable-panels";
import type { EmbedDeck } from "./EmbeddingsCanvas";
import type { TableTabState } from "../../store";
import { useStore } from "../../store";
import { cellText } from "../../api/types";
import { labelClusters } from "../../api/client";
import { useEmbeddingsEngine } from "../../embeddings/engine";
import { embeddingColors } from "../../embeddings/colors";
import { EmbeddingsCanvas, type PlotMode } from "./EmbeddingsCanvas";
import { LassoOverlay } from "./LassoOverlay";
import { PointDetailsPanel } from "./PointDetailsPanel";
import { SelectionGrid } from "./SelectionGrid";
import { BottomTabPanel, type BottomTab } from "../BottomTabPanel";
import { CellView } from "../CellView";

const POINT_CHOICES = [1000, 2500, 5000, 10000, 20000];
const SNIPPET_LEN = 180;

function isTextType(t: string): boolean {
  return /utf8|string|char|text/i.test(t);
}

export function EmbeddingsView({ tab }: { tab: TableTabState }) {
  const connId = useStore((s) => s.activeConnectionId);
  const themeId = useStore((s) => s.theme);
  const { engine, snap } = useEmbeddingsEngine(tab.id);

  const vectorCols = useMemo(() => (tab.columns ?? []).filter((c) => c.isVector), [tab.columns]);
  const nonVectorCols = useMemo(() => (tab.columns ?? []).filter((c) => !c.isVector), [tab.columns]);
  const textCols = useMemo(() => nonVectorCols.filter((c) => isTextType(c.type)), [nonVectorCols]);

  const [mode, setMode] = useState<PlotMode>("2d");
  const [vectorCol, setVectorCol] = useState<string>(
    () => (vectorCols.find((c) => c.vectorMetric) ?? vectorCols[0])?.name ?? "",
  );
  const [textCol, setTextCol] = useState<string | null>(() => textCols[0]?.name ?? null);
  const [limit, setLimit] = useState(5000);
  const [seed, setSeed] = useState(42);
  const [labelsOn, setLabelsOn] = useState(true);
  const [lassoMode, setLassoMode] = useState(false);
  const [hiddenClusters, setHiddenClusters] = useState<ReadonlySet<number>>(new Set());
  const [hover, setHover] = useState<{ index: number; x: number; y: number } | null>(null);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [lassoSel, setLassoSel] = useState<number[] | null>(null);
  const [deck, setDeck] = useState<EmbedDeck | null>(null);
  const [viewTick, setViewTick] = useState(0);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);

  const selectionPanelRef = useRef<ImperativePanelHandle>(null);
  const detailsPanelRef = useRef<ImperativePanelHandle>(null);

  // Both side panels start collapsed — they only matter once a click/lasso produces content.
  useLayoutEffect(() => {
    selectionPanelRef.current?.collapse();
    detailsPanelRef.current?.collapse();
  }, []);

  /** Index of the text column within the sample's non-vector cell order (server preserves table
   *  column order, so this is computable before the header arrives). */
  const textColumnIndex = useMemo(() => {
    if (!textCol) return null;
    const i = nonVectorCols.findIndex((c) => c.name === textCol);
    return i >= 0 ? i : null;
  }, [textCol, nonVectorCols]);

  // Kick a run whenever the effective params change (first open included). The engine's LRU cache
  // makes back-navigation instant; a genuinely new param set streams a fresh layout.
  useEffect(() => {
    if (!connId || !vectorCol) return;
    const cur = engine.getSnapshot().params;
    if (
      cur &&
      cur.connId === connId &&
      cur.column === vectorCol &&
      cur.limit === limit &&
      cur.seed === seed &&
      cur.textColumnIndex === textColumnIndex &&
      engine.getSnapshot().status !== "idle"
    ) {
      return;
    }
    setSelectedIndex(null);
    setLassoSel(null);
    setHiddenClusters(new Set());
    void engine.run({ connId, schema: tab.schema, table: tab.table, column: vectorCol, limit, seed, textColumnIndex });
  }, [engine, connId, tab.schema, tab.table, vectorCol, limit, seed, textColumnIndex]);

  // Theme-reactive color system.
  const colorSys = useMemo(() => embeddingColors(), [themeId]);

  // A 2D/3D toggle swaps the deck view asynchronously; reproject labels once the new camera lands.
  useEffect(() => {
    const raf = requestAnimationFrame(() => setViewTick((t) => t + 1));
    return () => cancelAnimationFrame(raf);
  }, [mode]);

  const similar = snap.similar;
  const clusters = snap.clusters;

  // Point color block: cluster tint × (dim | highlight | hidden) states, rebuilt as a whole —
  // cheap at these sizes and a single attribute upload for deck.
  const colorsVersionRef = useRef(0);
  const colors = useMemo(() => {
    const n = snap.n;
    const arr = new Uint8Array(n * 4);
    const simSet = similar ? new Set([similar.index, ...similar.indices]) : null;
    const lasSet = lassoSel ? new Set(lassoSel) : null;
    for (let i = 0; i < n; i++) {
      const cluster = clusters ? clusters.labels[i]! : -1;
      let rgb = cluster >= 0 ? colorSys.palette[cluster % colorSys.palette.length]! : colorSys.highlight;
      let alpha = 215;
      const dimmed =
        (simSet && !simSet.has(i)) || (lasSet && !lasSet.has(i)) || (cluster >= 0 && hiddenClusters.has(cluster));
      if (dimmed) {
        rgb = colorSys.dim;
        alpha = 70;
      } else if (simSet?.has(i) || i === selectedIndex) {
        rgb = colorSys.highlight;
        alpha = 255;
      }
      arr[i * 4] = rgb[0];
      arr[i * 4 + 1] = rgb[1];
      arr[i * 4 + 2] = rgb[2];
      arr[i * 4 + 3] = alpha;
    }
    colorsVersionRef.current++;
    return arr;
  }, [snap.n, clusters, similar, lassoSel, hiddenClusters, selectedIndex, colorSys]);

  const highlight = useMemo(() => {
    const out: number[] = [];
    if (selectedIndex != null) out.push(selectedIndex);
    if (similar) out.push(...Array.from(similar.indices));
    return out.length ? out : null;
  }, [selectedIndex, similar]);

  // Numeric by default — TF-IDF term strings are too long to float on the canvas; they survive as
  // legend-chip tooltips and as the AI-labeling hint. AI names (2-4 words) replace the number.
  const clusterName = (c: number): string => snap.aiLabels?.[c] ?? String(c + 1);
  const clusterHint = (c: number): string | undefined =>
    snap.terms?.[c]?.length ? snap.terms[c]!.join(" · ") : undefined;

  // Projected label positions — recomputed on camera moves (viewTick) and layout updates.
  const labelSpots = useMemo(() => {
    if (!labelsOn || !clusters || !deck || snap.status !== "ready") return [];
    const viewport = deck.getViewports()[0];
    if (!viewport) return [];
    const spots: Array<{ c: number; x: number; y: number; bx: number; by: number }> = [];
    const w = viewport.width;
    const h = viewport.height;
    for (let c = 0; c < clusters.k; c++) {
      if (hiddenClusters.has(c)) continue;
      const [x, y] = viewport.project([
        clusters.centroids[c * 3]!,
        clusters.centroids[c * 3 + 1]!,
        clusters.centroids[c * 3 + 2]!,
      ]) as [number, number];
      // A callout whose anchor left the viewport would clamp into a corner and float over the
      // legend — drop it like a map label until the cluster scrolls back into view.
      if (x < -20 || x > w + 20 || y < -20 || y > h + 20) continue;
      // Callout position: push the badge away from the canvas center so it clears its own points,
      // clamped to stay on screen. The leader line (rendered below) points back at the centroid.
      let dx = x - w / 2;
      let dy = y - h / 2;
      const len = Math.hypot(dx, dy) || 1;
      dx /= len;
      dy /= len;
      const bx = Math.min(w - 40, Math.max(40, x + dx * 64));
      const by = Math.min(h - 26, Math.max(26, y + dy * 64));
      spots.push({ c, x, y, bx, by });
    }
    return spots;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [labelsOn, clusters, deck, viewTick, snap.positionsVersion, snap.status, hiddenClusters, mode, snap.aiLabels, snap.terms]);

  // No zoom-fade: callout badges sit clear of the points, so they stay at full strength at every
  // zoom (the "labels" toggle is the off switch). Fading them just made AI names illegible.

  // Bottom panel: the lasso Selection grid with a Cell viewer pane underneath — clicking a row
  // shows the value in place instead of swapping the grid out for a separate tab.
  const [cellViewText, setCellViewText] = useState<string | null>(null);
  const cellPanelRef = useRef<ImperativePanelHandle>(null);

  const openSelection = (indices: number[]) => {
    setCellViewText(null); // fresh lasso → no cell selected yet
    setLassoSel(indices.length ? indices : null);
    if (indices.length) selectionPanelRef.current?.expand();
    else selectionPanelRef.current?.collapse();
  };

  const closeSelection = () => {
    setLassoSel(null);
    selectionPanelRef.current?.collapse();
  };

  const handleClick = (index: number | null) => {
    engine.clearSimilar();
    setHover(null); // the click repositions panels; a lingering tooltip would point at stale pixels
    setSelectedIndex(index);
    if (index != null) detailsPanelRef.current?.expand();
  };

  const runAiLabels = async () => {
    if (!clusters || !snap.header || textColumnIndex == null || aiBusy) return;
    setAiBusy(true);
    setAiError(null);
    try {
      const perCluster: string[][] = Array.from({ length: clusters.k }, () => []);
      for (let i = 0; i < snap.n && perCluster.some((s) => s.length < 10); i++) {
        const c = clusters.labels[i]!;
        if (perCluster[c]!.length >= 10) continue;
        const cell = snap.header.rows[i]?.[textColumnIndex];
        if (cell == null) continue;
        perCluster[c]!.push(typeof cell === "string" ? cell : cellText(cell));
      }
      const res = await labelClusters({
        clusters: perCluster.map((samples, id) => ({ id, hint: snap.terms?.[id]?.join(", "), samples })),
      });
      const names = Array.from({ length: clusters.k }, (_, c) => clusterName(c));
      for (const { id, label } of res.labels) if (id >= 0 && id < names.length && label) names[id] = label;
      engine.setAiLabels(names);
    } catch (err) {
      setAiError(err instanceof Error ? err.message : String(err));
    } finally {
      setAiBusy(false);
    }
  };

  const toggleCluster = (c: number) => {
    setHiddenClusters((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });
  };

  const modeBtn = (m: PlotMode, label: string) => (
    <button
      className={`px-2 py-0.5 text-[length:var(--fs-sm)] rounded ${
        mode === m ? "bg-brass/10 text-brass" : "text-muted hover:text-paper"
      }`}
      onClick={() => {
        setMode(m);
        if (m === "3d") setLassoMode(false);
      }}
    >
      {label}
    </button>
  );

  const selectCls =
    "bg-ink-950 border border-line rounded px-1.5 py-0.5 text-[length:var(--fs-sm)] text-paper-dim focus:outline-none focus:border-brass-soft/60";

  const progressNote = (() => {
    if (snap.status === "fetching") return "Fetching vectors…";
    if (snap.status === "reducing") {
      if (snap.stage === "umap" && snap.totalEpochs > 0) return `Layout ${snap.epoch}/${snap.totalEpochs}`;
      if (snap.stage === "cluster") return "Clustering…";
      if (snap.stage === "tfidf") return "Labeling…";
      return "Preparing space…";
    }
    if (snap.status === "ready" && snap.header) {
      const note = snap.header.sampled
        ? `${snap.n.toLocaleString()} of ${snap.header.totalRows.toLocaleString()} rows`
        : `${snap.n.toLocaleString()} rows`;
      return snap.pcaOnly ? `${note} · PCA (too few rows for UMAP)` : note;
    }
    return null;
  })();

  const hoverInfo = (() => {
    if (hover == null || !snap.header) return null;
    const row = snap.header.rows[hover.index];
    if (!row) return null;
    let snippet: string;
    if (textColumnIndex != null && row[textColumnIndex] != null) {
      const v = row[textColumnIndex]!;
      snippet = typeof v === "string" ? v : cellText(v);
    } else {
      snippet = row
        .slice(0, 3)
        .map((v, i) => `${snap.header!.columns[i]?.name}: ${v == null ? "NULL" : cellText(v)}`)
        .join("  ");
    }
    const cluster = clusters ? clusters.labels[hover.index]! : null;
    return { snippet: snippet.slice(0, SNIPPET_LEN), cluster };
  })();

  const bottomTabs: BottomTab[] = [];
  if (lassoSel && snap.header) {
    bottomTabs.push({
      id: "selection",
      label: `Selection (${lassoSel.length})`,
      content: (
        <PanelGroup direction="vertical" className="h-full">
          <Panel minSize={20}>
            <SelectionGrid
              header={snap.header}
              indices={lassoSel}
              onCellTextChange={setCellViewText}
              onCellActivate={(text) => {
                setCellViewText(text);
                cellPanelRef.current?.expand();
              }}
            />
          </Panel>
          <PanelResizeHandle className="pane-handle" />
          <Panel ref={cellPanelRef} defaultSize={32} minSize={10} collapsible collapsedSize={0}>
            <CellView text={cellViewText} />
          </Panel>
        </PanelGroup>
      ),
    });
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* Toolbar */}
      <div className="px-5 pb-2 flex items-center gap-3 flex-wrap shrink-0">
        <div className="flex items-center rounded border border-line overflow-hidden">
          {modeBtn("2d", "2D")}
          {modeBtn("3d", "3D")}
        </div>
        {vectorCols.length > 1 && (
          <label className="flex items-center gap-1.5 text-[length:var(--fs-sm)] text-muted">
            vector
            <select className={selectCls} value={vectorCol} onChange={(e) => setVectorCol(e.target.value)}>
              {vectorCols.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {textCols.length > 0 && (
          <label className="flex items-center gap-1.5 text-[length:var(--fs-sm)] text-muted">
            text
            <select
              className={selectCls}
              value={textCol ?? ""}
              onChange={(e) => setTextCol(e.target.value || null)}
            >
              {textCols.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
              <option value="">none</option>
            </select>
          </label>
        )}
        <label className="flex items-center gap-1.5 text-[length:var(--fs-sm)] text-muted">
          points
          <select className={selectCls} value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
            {POINT_CHOICES.map((p) => (
              <option key={p} value={p}>
                {p.toLocaleString()}
              </option>
            ))}
          </select>
        </label>
        <button
          className="px-2.5 py-1 text-[length:var(--fs-base)] rounded border border-line text-muted hover:text-paper hover:border-brass-soft/60"
          title="Re-run layout (shift-click: new random arrangement)"
          onClick={(e) => {
            const params = engine.getSnapshot().params;
            if (e.shiftKey) setSeed((s) => s + 1);
            else if (params) void engine.run(params);
          }}
          disabled={snap.status === "fetching" || snap.status === "reducing"}
        >
          Run
        </button>
        <button
          className={`px-2.5 py-1 text-[length:var(--fs-base)] rounded border ${
            lassoMode ? "border-brass-soft/60 text-brass bg-brass/5" : "border-line text-muted hover:text-paper"
          } disabled:opacity-40`}
          onClick={() => setLassoMode((v) => !v)}
          disabled={mode === "3d" || snap.status !== "ready"}
          title="Lasso select points"
        >
          Lasso
        </button>
        <label className="flex items-center gap-1.5 text-[length:var(--fs-sm)] text-muted cursor-pointer">
          <input type="checkbox" checked={labelsOn} onChange={(e) => setLabelsOn(e.target.checked)} />
          labels
        </label>
        <button
          className="px-2.5 py-1 text-[length:var(--fs-base)] rounded border border-line text-muted hover:text-paper hover:border-brass-soft/60 disabled:opacity-40"
          onClick={() => void runAiLabels()}
          disabled={!clusters || textColumnIndex == null || aiBusy || snap.status !== "ready"}
          title="Name clusters with the configured AI model"
        >
          {aiBusy ? "Labeling…" : "AI label"}
        </button>
        <span className="text-[length:var(--fs-sm)] text-faint font-mono">{progressNote}</span>
        {aiError && <span className="text-[length:var(--fs-sm)] text-err truncate max-w-64">{aiError}</span>}
      </div>

      <PanelGroup direction="horizontal" className="flex-1 min-h-0">
        <Panel minSize={30}>
          <PanelGroup direction="vertical" className="h-full">
            <Panel minSize={30}>
              <div className="relative h-full w-full overflow-hidden" style={{ background: colorSys.background }}>
                {snap.positions && snap.n > 0 && (
                  <EmbeddingsCanvas
                    positions={snap.positions}
                    positionsVersion={snap.positionsVersion}
                    n={snap.n}
                    colors={colors}
                    colorsVersion={colorsVersionRef.current}
                    mode={mode}
                    highlight={highlight}
                    highlightColor={colorSys.highlight}
                    controllerEnabled={!lassoMode}
                    onHover={(index, x, y) => setHover(index == null ? null : { index, x, y })}
                    onClick={handleClick}
                    onDeck={setDeck}
                    onViewChange={() => setViewTick((t) => t + 1)}
                  />
                )}

                {/* Cluster labels — offset callout badges tethered to their centroids */}
                {snap.status === "ready" && labelSpots.length > 0 && (
                  <>
                    {/* Leader lines from each callout badge back to its cluster's centroid. */}
                    <svg className="absolute inset-0 h-full w-full pointer-events-none">
                      {labelSpots.map(({ c, x, y, bx, by }) => (
                        <g key={c} stroke={colorSys.paletteHex[c % colorSys.paletteHex.length]}>
                          <line x1={bx} y1={by} x2={x} y2={y} strokeWidth={1.5} />
                          <circle cx={x} cy={y} r={3} fill={colorSys.paletteHex[c % colorSys.paletteHex.length]} />
                        </g>
                      ))}
                    </svg>
                    {labelSpots.map(({ c, bx, by }) => {
                      const name = clusterName(c);
                      return (
                        <div
                          key={c}
                          className="absolute pointer-events-none"
                          style={{ left: bx, top: by, transform: "translate(-50%, -50%)" }}
                        >
                          {/* Callout badge: solid theme-background pill + cluster-colored ring, held
                              off to the side of the cluster so the text never fights the points. */}
                          <div
                            className="font-display whitespace-nowrap rounded-full border-2"
                            style={{
                              background: colorSys.background,
                              borderColor: colorSys.paletteHex[c % colorSys.paletteHex.length],
                              color: colorSys.textHex,
                              boxShadow: `0 2px 14px ${colorSys.background}`,
                              // Bare numbers get poster size; worded AI labels step down to stay tidy.
                              fontSize: name.length <= 3 ? "22px" : "16px",
                              fontWeight: 800,
                              letterSpacing: "0.03em",
                              padding: name.length <= 3 ? "0px 13px" : "2px 12px",
                            }}
                          >
                            {name}
                          </div>
                        </div>
                      );
                    })}
                  </>
                )}

                {/* Lasso capture layer */}
                {lassoMode && snap.positions && (
                  <LassoOverlay
                    deck={deck}
                    positions={snap.positions}
                    n={snap.n}
                    accent={colorSys.accentHex}
                    onSelect={openSelection}
                  />
                )}

                {/* Hover tooltip */}
                {hoverInfo && hover && !lassoMode && (
                  <div
                    className="absolute pointer-events-none max-w-72 px-2.5 py-1.5 rounded border border-line bg-ink-950/95 shadow-lg"
                    style={{ left: hover.x + 12, top: hover.y + 12 }}
                  >
                    {hoverInfo.cluster != null && (
                      <div
                        className="text-[length:var(--fs-sm)] font-semibold mb-0.5"
                        style={{ color: colorSys.paletteHex[hoverInfo.cluster % colorSys.paletteHex.length] }}
                      >
                        {clusterName(hoverInfo.cluster)}
                      </div>
                    )}
                    <div className="text-[length:var(--fs-sm)] text-paper-dim font-mono break-words">
                      {hoverInfo.snippet}
                    </div>
                  </div>
                )}

                {/* Status overlays */}
                {(snap.status === "fetching" || (snap.status === "reducing" && !snap.positions)) && (
                  <div className="absolute inset-0 grid place-items-center">
                    <div className="text-muted pulse-soft text-[length:var(--fs-base)]">{progressNote}</div>
                  </div>
                )}
                {snap.status === "error" && (
                  <div className="absolute inset-0 grid place-items-center p-6">
                    <div className="px-3 py-2 text-[length:var(--fs-base)] text-err bg-err/10 border border-err/30 rounded font-mono max-w-lg">
                      {snap.error}
                    </div>
                  </div>
                )}

                {/* Legend — quiet chip row, click to dim a cluster in place */}
                {clusters && snap.status === "ready" && (
                  <div className="absolute left-3 bottom-3 flex flex-wrap gap-1.5 max-w-[70%]">
                    {Array.from({ length: clusters.k }, (_, c) => (
                      <button
                        key={c}
                        className={`flex items-center gap-1.5 pl-1.5 pr-2 py-0.5 rounded-full border text-[length:var(--fs-sm)] transition ${
                          hiddenClusters.has(c)
                            ? "border-line-soft text-faint opacity-60"
                            : "border-line text-paper-dim hover:text-paper"
                        }`}
                        style={{ background: `${colorSys.background}cc` }}
                        onClick={() => toggleCluster(c)}
                        title={[hiddenClusters.has(c) ? "Show cluster" : "Dim cluster", clusterHint(c)]
                          .filter(Boolean)
                          .join(" — ")}
                      >
                        <span
                          className="inline-block h-2 w-2 rounded-full"
                          style={{ background: colorSys.paletteHex[c % colorSys.paletteHex.length] }}
                        />
                        <span className="max-w-40 truncate">{clusterName(c)}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </Panel>
            <PanelResizeHandle className="pane-handle" />
            <Panel ref={selectionPanelRef} defaultSize={26} minSize={8} collapsible collapsedSize={0}>
              <BottomTabPanel
                tabs={bottomTabs}
                activeId="selection"
                onActivate={() => {}}
                onClose={closeSelection}
              />
            </Panel>
          </PanelGroup>
        </Panel>
        <PanelResizeHandle className="pane-handle" />
        <Panel ref={detailsPanelRef} defaultSize={24} minSize={12} collapsible collapsedSize={0}>
          {selectedIndex != null && snap.header && (
            <PointDetailsPanel
              header={snap.header}
              index={selectedIndex}
              clusterName={clusters ? clusterName(clusters.labels[selectedIndex]!) : null}
              similarActive={similar != null && similar.index === selectedIndex}
              onFindSimilar={() => engine.findSimilar(selectedIndex)}
              onClearSimilar={() => engine.clearSimilar()}
              onClose={() => {
                setSelectedIndex(null);
                engine.clearSimilar();
                detailsPanelRef.current?.collapse();
              }}
            />
          )}
        </Panel>
      </PanelGroup>
    </div>
  );
}
