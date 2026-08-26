// Traces: BASED-EMBED-UI
// The WebGL scatter itself. Owns a deck.gl Deck instance on a manual canvas — deliberately NOT
// @deck.gl/react: UMAP epochs stream ~12×/s and imperative setProps({layers}) re-uploads binary
// attributes without a React render per frame. React only re-runs the small effects below when a
// version counter ticks.
import { useEffect, useRef, useState } from "react";
import { Deck, OrbitView, OrthographicView, type PickingInfo } from "@deck.gl/core";
import { PointCloudLayer, ScatterplotLayer } from "@deck.gl/layers";
import type { Rgb } from "../../embeddings/colors";

export type PlotMode = "2d" | "3d";

/** The Deck instance parameterized over the two camera models the view toggles between. */
export type EmbedDeck = Deck<OrthographicView | OrbitView>;

const VIEW_2D = { target: [0, 0, 0] as [number, number, number], zoom: -0.9, minZoom: -6, maxZoom: 8 };
const VIEW_3D = {
  target: [0, 0, 0] as [number, number, number],
  zoom: -0.9,
  rotationX: 25,
  rotationOrbit: -30,
  minZoom: -6,
  maxZoom: 8,
};

/** Wheel zoom: `smooth` animates each tick toward its target instead of stepping, and inertia
 *  carries pan/orbit gestures — the difference between a CAD tool and a map. */
const CONTROLLER = { scrollZoom: { speed: 0.01, smooth: true }, inertia: 300 } as const;

function makeView(mode: PlotMode) {
  // Positions live in a [-500,500]³ box; the ortho camera must not depth-clip the z spread the
  // 3D layout leaves in place (default near/far would silently swallow whole clusters).
  return mode === "2d"
    ? new OrthographicView({ id: "ortho", flipY: false, near: -1000, far: 1000 })
    : new OrbitView({ id: "orbit", orbitAxis: "Y" });
}

export interface EmbeddingsCanvasProps {
  positions: Float32Array;
  positionsVersion: number;
  n: number;
  /** n×4 RGBA per point — rebuilt by the parent on cluster/selection/theme change. */
  colors: Uint8Array;
  colorsVersion: number;
  mode: PlotMode;
  /** Emphasized indices drawn as a ringed overlay (selection + find-similar neighbours). */
  highlight: number[] | null;
  highlightColor: Rgb;
  /** False while the lasso is armed so drag draws a polygon instead of panning. */
  controllerEnabled: boolean;
  onHover: (index: number | null, x: number, y: number) => void;
  onClick: (index: number | null) => void;
  /** Hands the parent the live Deck for screen-space projection (lasso, labels). */
  onDeck: (deck: EmbedDeck | null) => void;
  /** Fires (rAF-throttled) whenever the camera moves — reprojects labels. */
  onViewChange: (zoom: number) => void;
}

export function EmbeddingsCanvas(props: EmbeddingsCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const deckRef = useRef<EmbedDeck | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const rafPending = useRef(false);
  // WebGL2 context creation is async inside luma.gl, so its failures surface as unhandled rejections
  // that would crash the whole window rather than as errors an ancestor boundary can catch. Capture
  // them here and re-throw during render so the boundary around this view (TableDetailsView) can show
  // its fallback instead. See BASED-WEBKIT-DMABUF.
  const [fatal, setFatal] = useState<Error | null>(null);

  const buildLayers = () => {
    const p = propsRef.current;
    if (p.n === 0) return [];
    const data = {
      length: p.n,
      attributes: {
        getPosition: { value: p.positions, size: 3 },
        ...(p.mode === "2d"
          ? { getFillColor: { value: p.colors, size: 4 } }
          : { getColor: { value: p.colors, size: 4 } }),
      },
    };
    const base =
      p.mode === "2d"
        ? new ScatterplotLayer({
            id: "points",
            data,
            radiusUnits: "pixels" as const,
            getRadius: 3,
            stroked: false,
            pickable: true,
          })
        : new PointCloudLayer({
            id: "points",
            data,
            pointSize: 3,
            pickable: true,
          });
    if (!p.highlight || p.highlight.length === 0) return [base];
    const ring = new ScatterplotLayer<number>({
      id: "highlight",
      data: p.highlight,
      getPosition: (i: number) => [p.positions[i * 3]!, p.positions[i * 3 + 1]!, p.positions[i * 3 + 2]!],
      radiusUnits: "pixels" as const,
      getRadius: 5,
      stroked: true,
      filled: false,
      getLineColor: [...p.highlightColor, 255] as [number, number, number, number],
      lineWidthUnits: "pixels" as const,
      getLineWidth: 1.5,
      pickable: false,
      updateTriggers: { getPosition: props.positionsVersion },
    });
    return [base, ring];
  };

  // Mount once.
  useEffect(() => {
    // Probe for WebGL2 before handing the canvas to deck.gl: on hosts that can't provide a context
    // (some WebKitGTK/GPU combos), this fails fast into the fallback instead of luma.gl aborting
    // mid-init. A throwaway canvas keeps the real one's single context free for deck.gl.
    const probe = document.createElement("canvas").getContext("webgl2");
    if (!probe) {
      setFatal(new Error("WebGL2 is not available in this webview"));
      return;
    }
    probe.getExtension("WEBGL_lose_context")?.loseContext();

    const deck: EmbedDeck = new Deck<OrthographicView | OrbitView>({
      canvas: canvasRef.current!,
      views: makeView(propsRef.current.mode),
      initialViewState: propsRef.current.mode === "2d" ? VIEW_2D : VIEW_3D,
      controller: propsRef.current.controllerEnabled ? CONTROLLER : false,
      layers: buildLayers(),
      // Escalate any deck/luma error (context loss, failed device init) to the boundary rather than
      // letting it become an uncaught rejection.
      onError: (err: Error) => setFatal(err instanceof Error ? err : new Error(String(err))),
      onHover: (info: PickingInfo) => {
        const i = info.index != null && info.index >= 0 ? info.index : null;
        propsRef.current.onHover(i, info.x ?? 0, info.y ?? 0);
      },
      onClick: (info: PickingInfo) => {
        propsRef.current.onClick(info.index != null && info.index >= 0 ? info.index : null);
      },
      onViewStateChange: ({ viewState }) => {
        if (!rafPending.current) {
          rafPending.current = true;
          requestAnimationFrame(() => {
            rafPending.current = false;
            propsRef.current.onViewChange((viewState as { zoom?: number }).zoom ?? 0);
          });
        }
        return viewState;
      },
      getCursor: ({ isDragging }) => (isDragging ? "grabbing" : "crosshair"),
    });
    deckRef.current = deck;
    props.onDeck(deck);
    return () => {
      propsRef.current.onDeck(null);
      deck.finalize();
      deckRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Camera model swap on 2D/3D toggle (fresh initialViewState identity re-seats the camera).
  useEffect(() => {
    deckRef.current?.setProps({
      views: makeView(props.mode),
      initialViewState: props.mode === "2d" ? { ...VIEW_2D } : { ...VIEW_3D },
    });
  }, [props.mode]);

  useEffect(() => {
    deckRef.current?.setProps({ controller: props.controllerEnabled ? CONTROLLER : false });
  }, [props.controllerEnabled]);

  // Re-upload attributes when data, colors, mode, or highlights change.
  useEffect(() => {
    deckRef.current?.setProps({ layers: buildLayers() });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.positionsVersion, props.colorsVersion, props.mode, props.n, props.highlight]);

  // Re-throw a captured WebGL failure during render (not from the async effect) so the surrounding
  // ErrorBoundary catches it and swaps in the fallback pane.
  if (fatal) throw fatal;

  // Traces: BASED-UI-FONT-ZOOM — deck.gl's controller owns the wheel here (and a trackpad pinch
  // reaches the page as Ctrl+wheel), so this canvas opts out of the app-wide Ctrl+wheel text zoom.
  return <canvas ref={canvasRef} data-wheel-zoom="own" className="absolute inset-0 h-full w-full" />;
}
