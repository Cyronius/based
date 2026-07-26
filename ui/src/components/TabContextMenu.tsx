import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useStore, visibleTabs } from "../store";

const MENU_WIDTH = 220;

interface Props {
  tabId: string;
  x: number;
  y: number;
  onClose: () => void;
}

export function TabContextMenu({ tabId, x, y, onClose }: Props) {
  const closeTabs = useStore((s) => s.closeTabs);
  // Subscribe to the stable `tabs` array, not `visibleTabs` — that selector allocates a new array
  // per call and zustand v5 compares snapshots with Object.is, so selecting it directly re-renders
  // forever ("Maximum update depth exceeded").
  const tabs = useStore((s) => s.tabs);
  const visible = useMemo(() => visibleTabs({ tabs }), [tabs]);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: y, left: x });

  useLayoutEffect(() => {
    if (!ref.current) return;
    const h = ref.current.offsetHeight;
    const left = Math.min(x, window.innerWidth - MENU_WIDTH - 8);
    const top = Math.min(y, window.innerHeight - h - 8);
    setPos({ top, left });
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

  const idx = visible.findIndex((t) => t.id === tabId);
  if (idx === -1) return null;

  const item = (label: string, disabled: boolean, ids: string[]) => (
    <button
      className="w-full text-left px-3 py-1.5 text-[length:var(--fs-base)] text-paper-dim hover:bg-ink-900 disabled:opacity-40 disabled:hover:bg-transparent disabled:cursor-default"
      disabled={disabled}
      onClick={() => {
        closeTabs(ids);
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
      {item("Close Tabs to the Left", idx <= 0, visible.slice(0, idx).map((t) => t.id))}
      {item("Close Tabs to the Right", idx === visible.length - 1, visible.slice(idx + 1).map((t) => t.id))}
      {item("Close Other Tabs", visible.length <= 1, visible.filter((_, i) => i !== idx).map((t) => t.id))}
      {item("Close All Tabs", false, visible.map((t) => t.id))}
    </div>
  );
}
