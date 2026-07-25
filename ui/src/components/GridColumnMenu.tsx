// Traces: BASED-GRID-SORT, BASED-GRID-FILTER
// Column header menu for the canvas grids: Glide headers are canvas-drawn, so the menu is a DOM
// popover positioned from the header bounds Glide reports on the menu-icon click. Hosts sort
// actions and the per-column filter input (mini-language: contains / operators / NULL).
// Reused by ResultGrid (client-side view) and, in phase 2b, TableDataGrid (server-side).
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { SortDir } from "../gridView";

const MENU_WIDTH = 230;

export function GridColumnMenu({
  columnName,
  x,
  y,
  sortDir,
  filter,
  filterPlaceholder = "Filter (=x, >x, NULL, text…)",
  onSort,
  onFilterChange,
  onClose,
}: {
  columnName: string;
  /** Screen coords to anchor at (typically the header cell's bottom-left). */
  x: number;
  y: number;
  /** This column's current sort direction, if it is the sorted column. */
  sortDir: SortDir | null;
  filter: string;
  filterPlaceholder?: string;
  /** null clears the sort. */
  onSort: (dir: SortDir | null) => void;
  onFilterChange: (expr: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState({ top: y, left: x });

  useLayoutEffect(() => {
    if (!ref.current) return;
    const h = ref.current.offsetHeight;
    setPos({ top: Math.min(y, window.innerHeight - h - 8), left: Math.min(x, window.innerWidth - MENU_WIDTH - 8) });
  }, [x, y]);

  useEffect(() => {
    inputRef.current?.focus();
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

  const sortBtn = (label: string, dir: SortDir) => (
    <button
      className={`w-full text-left px-3 py-1.5 text-[length:var(--fs-base)] hover:bg-ink-900 ${
        sortDir === dir ? "text-brass" : "text-paper-dim"
      }`}
      onClick={() => {
        onSort(sortDir === dir ? null : dir);
        onClose();
      }}
    >
      {label}
      {sortDir === dir && <span className="ml-1.5 text-[length:var(--fs-sm)]">✓</span>}
    </button>
  );

  return (
    <div
      ref={ref}
      className="fixed z-40 rounded border border-line bg-ink-850 shadow-xl shadow-black/40 fade-up py-1"
      style={{ top: pos.top, left: pos.left, width: MENU_WIDTH }}
    >
      <div className="px-3 py-1 text-[length:var(--fs-xs)] text-faint font-mono truncate border-b border-line-soft">{columnName}</div>
      {sortBtn("Sort ascending", "asc")}
      {sortBtn("Sort descending", "desc")}
      <div className="px-3 py-1.5 border-t border-line-soft">
        <input
          ref={inputRef}
          className="w-full px-2 py-1 rounded border border-line bg-ink-950 text-paper font-mono text-[length:var(--fs-sm)] focus:outline-none focus:border-brass-soft placeholder:text-faint placeholder:font-sans"
          placeholder={filterPlaceholder}
          value={filter}
          onChange={(e) => onFilterChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onClose();
          }}
        />
        {filter.trim() && (
          <button
            className="mt-1 text-[length:var(--fs-sm)] text-brass hover:underline"
            onClick={() => {
              onFilterChange("");
              onClose();
            }}
          >
            Clear filter
          </button>
        )}
      </div>
    </div>
  );
}
