// Traces: BASED-GRID-CONTEXT-MENU
// Right-click menu for grid cells/selections — the same shared action set the grid toolbars use
// (one useGridExportActions instance per host feeds both), so results, Data, and embeddings
// Selection grids behave identically. File exports are scoped to the selection when one exists.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { CsvIcon, ExcelIcon, MarkdownIcon, type GridExportActions } from "./GridToolbarActions";

const MENU_WIDTH = 210;

export function GridContextMenu({
  x,
  y,
  actions,
  onClose,
}: {
  x: number;
  y: number;
  actions: GridExportActions;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: y, left: x });

  useLayoutEffect(() => {
    if (!ref.current) return;
    const h = ref.current.offsetHeight;
    setPos({ top: Math.min(y, window.innerHeight - h - 8), left: Math.min(x, window.innerWidth - MENU_WIDTH - 8) });
  }, [x, y]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const item = (label: string, icon: React.ReactNode, run: () => void) => (
    <button
      className="w-full flex items-center gap-2 text-left px-3 py-1.5 text-[length:var(--fs-base)] text-paper-dim hover:bg-ink-900"
      onClick={() => {
        run();
        onClose();
      }}
    >
      <span className="w-4 grid place-items-center text-muted">{icon}</span>
      {label}
    </button>
  );

  return (
    <div
      ref={ref}
      className="fixed z-40 rounded border border-line bg-ink-850 shadow-xl shadow-black/40 fade-up py-1"
      style={{ top: pos.top, left: pos.left, width: MENU_WIDTH }}
    >
      {item("Copy", null, () => void actions.copy())}
      {item("Copy as Markdown", <MarkdownIcon />, () => void actions.copyMarkdown())}
      <div className="my-1 border-t border-line-soft" />
      {item("Save as CSV", <CsvIcon />, () => void actions.exportFile("csv", { scope: "selection" }))}
      {item("Open in Excel", <ExcelIcon />, () => void actions.exportFile("xlsx", { openAfter: true, scope: "selection" }))}
    </div>
  );
}
