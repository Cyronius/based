// Traces: BASED-UI-SCRIPT-AS
// Right-click menu for the object explorer: open actions (single selection) and "Script as" over
// the whole (type-homogeneous) selection — all selected objects script into one query tab.
// Positioning/close behavior mirrors TabContextMenu.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStore } from "../store";
import type { DbObject } from "../api/types";
import { actionsFor, type ScriptableType } from "./ScriptDropdown";

const MENU_WIDTH = 230;

export function ExplorerContextMenu({
  objects,
  x,
  y,
  onClose,
}: {
  /** The current selection — guaranteed type-homogeneous by ObjectExplorer. */
  objects: DbObject[];
  x: number;
  y: number;
  onClose: () => void;
}) {
  const openTableTab = useStore((s) => s.openTableTab);
  const openRoutineTab = useStore((s) => s.openRoutineTab);
  const scriptObjects = useStore((s) => s.scriptObjects);
  const openDiagramTab = useStore((s) => s.openDiagramTab);
  const capabilities = useStore((s) => s.capabilities);
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

  const first = objects[0];
  if (!first) return null;
  const type = first.type as ScriptableType;
  const single = objects.length === 1 ? first : null;
  const isTableLike = type === "table" || type === "view";

  const item = (label: string, onClick: () => void) => (
    <button
      key={label}
      className="w-full text-left px-3 py-1.5 text-[length:var(--fs-base)] text-paper-dim hover:bg-ink-900"
      onClick={() => {
        onClick();
        onClose();
      }}
    >
      {label}
    </button>
  );

  return (
    <div
      ref={ref}
      className="fixed z-40 rounded border border-line bg-ink-850 shadow-xl shadow-black/40 fade-up py-1"
      style={{ top: pos.top, left: pos.left, width: MENU_WIDTH }}
    >
      {single && isTableLike && (
        <>
          {item("Open details", () => void openTableTab(single.schema, single.name, single.type as "table" | "view", "details"))}
          {item("Open data", () => void openTableTab(single.schema, single.name, single.type as "table" | "view", "data"))}
          {capabilities?.sql &&
            item("Open sql", () => void openTableTab(single.schema, single.name, single.type as "table" | "view", "sql"))}
        </>
      )}
      {single && !isTableLike && item("Open details", () => void openRoutineTab(single.schema, single.name, single.type as "procedure" | "function"))}
      {single && type === "table" && capabilities?.relations && item("View diagram", () => openDiagramTab(single.schema))}

      {capabilities?.script && (
        <>
          {single && <div className="my-1 border-t border-line-soft" />}
          {!single && (
            <div className="px-3 py-1 text-[length:var(--fs-xs)] text-faint border-b border-line-soft mb-1">
              {objects.length} objects selected
            </div>
          )}
          {actionsFor(type).map(({ action, label }) =>
            item(label, () => void scriptObjects(objects.map((o) => ({ schema: o.schema, name: o.name, type: o.type })), action)),
          )}
        </>
      )}
    </div>
  );
}
