// Traces: BASED-EMBED-UI
// Freehand lasso selection (2D mode only). An SVG overlay captures the pointer path; on release,
// every point is projected to screen space via the live deck viewport and ray-cast against the
// polygon. ~60 lines beats a community editable-layers dependency.
import { useRef, useState } from "react";
import type { EmbedDeck } from "./EmbeddingsCanvas";

/** Standard even-odd ray casting. */
function insidePolygon(x: number, y: number, poly: Array<[number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function LassoOverlay({
  deck,
  positions,
  n,
  accent,
  onSelect,
}: {
  deck: EmbedDeck | null;
  positions: Float32Array;
  n: number;
  accent: string;
  onSelect: (indices: number[]) => void;
}) {
  const [path, setPath] = useState<Array<[number, number]>>([]);
  const dragging = useRef(false);

  const localPoint = (e: React.PointerEvent): [number, number] => {
    const rect = e.currentTarget.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  };

  const finish = (poly: Array<[number, number]>) => {
    setPath([]);
    dragging.current = false;
    if (poly.length < 3 || !deck) return;
    const viewport = deck.getViewports()[0];
    if (!viewport) return;
    const hits: number[] = [];
    for (let i = 0; i < n; i++) {
      const [sx, sy] = viewport.project([positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!]) as [
        number,
        number,
      ];
      if (insidePolygon(sx, sy, poly)) hits.push(i);
    }
    onSelect(hits);
  };

  return (
    <svg
      className="absolute inset-0 h-full w-full cursor-crosshair"
      onPointerDown={(e) => {
        dragging.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        setPath([localPoint(e)]);
      }}
      onPointerMove={(e) => {
        if (!dragging.current) return;
        const pt = localPoint(e); // must read currentTarget synchronously — React nulls it after the handler
        setPath((p) => [...p, pt]);
      }}
      onPointerUp={() => finish(path)}
    >
      {path.length > 1 && (
        <polygon
          points={path.map(([x, y]) => `${x},${y}`).join(" ")}
          fill={`${accent}18`}
          stroke={accent}
          strokeWidth={1.25}
          strokeDasharray="4 3"
        />
      )}
    </svg>
  );
}
