import { useRef, useState, type KeyboardEvent } from "react";
import { useStore } from "../store";
import { TabContextMenu } from "./TabContextMenu";
import { IconButton } from "./IconButton";
import { CapiMark } from "./icons";
import { accel } from "../platform";

export function TabStrip() {
  const tabs = useStore((s) => s.tabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const activateTab = useStore((s) => s.activateTab);
  const requestEditorFocus = useStore((s) => s.requestEditorFocus);
  const closeTab = useStore((s) => s.closeTab);
  const reorderTab = useStore((s) => s.reorderTab);
  const newQueryTab = useStore((s) => s.newQueryTab);
  const capabilities = useStore((s) => s.capabilities);
  const capturePlan = useStore((s) => s.capturePlan);
  const captureStats = useStore((s) => s.captureStats);
  const toggleCapturePlan = useStore((s) => s.toggleCapturePlan);
  const toggleCaptureStats = useStore((s) => s.toggleCaptureStats);
  const activeConnectionId = useStore((s) => s.activeConnectionId);
  // Traces: BASED-HELP-DOCS — the strip now also renders with no connection, for a lone help tab.
  // Everything from here right is about running queries against a session, so it needs one.
  const connected = activeConnectionId != null;
  // Traces: BASED-LANCE-SQL-GATING — driven by the real EngineCapabilities from the connection
  // response, not a hardcoded engine check. Default true while connected-but-not-yet-capable so
  // the affordance doesn't flicker (the store's newQueryTab guard makes the click a no-op then).
  const sqlEditor = connected && (capabilities?.sql ?? true);

  const [menu, setMenu] = useState<{ tabId: string; x: number; y: number } | null>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; side: "before" | "after" } | null>(null);

  const visible = tabs.filter((t) => !(t.kind === "query" && t.parentTabId));
  const stripRef = useRef<HTMLDivElement>(null);

  // Traces: BASED-UI-A11Y-KEYBOARD — tablist keys: arrows/Home/End move and activate, Delete closes.
  const focusTab = (id: string) => stripRef.current?.querySelector<HTMLElement>(`[data-tab-id="${id}"]`)?.focus();
  const onTabKey = (e: KeyboardEvent<HTMLDivElement>, idx: number) => {
    const go = (i: number) => {
      const t = visible[(i + visible.length) % visible.length];
      if (!t) return;
      e.preventDefault();
      activateTab(t.id);
      requestAnimationFrame(() => focusTab(t.id));
    };
    if (e.key === "ArrowRight") go(idx + 1);
    else if (e.key === "ArrowLeft") go(idx - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(visible.length - 1);
    else if (e.key === "Delete") {
      e.preventDefault();
      const next = visible[idx + 1] ?? visible[idx - 1];
      closeTab(visible[idx]!.id);
      if (next) requestAnimationFrame(() => focusTab(next.id));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      activateTab(visible[idx]!.id);
    } else if ((e.key === "F10" && e.shiftKey) || e.key === "ContextMenu") {
      e.preventDefault();
      const r = e.currentTarget.getBoundingClientRect();
      setMenu({ tabId: visible[idx]!.id, x: r.left, y: r.bottom });
    }
  };

  const toggleBtn = (active: boolean) =>
    `grid place-items-center h-full w-8 border-l border-line-soft text-[length:var(--fs-md)] shrink-0 ${
      active
        ? "bg-ink-900 text-brass shadow-[inset_0_2px_0_var(--color-brass)]"
        : "text-muted hover:text-paper-dim hover:bg-ink-900/50"
    }`;

  return (
    <div className="flex items-stretch h-9 border-b border-line-soft bg-ink-950 overflow-x-auto shrink-0">
      <div ref={stripRef} role="tablist" aria-label="Open tabs" className="flex items-stretch">
      {visible.map((t, idx) => {
        const active = t.id === activeTabId;
        const running = t.kind === "query" && t.running;
        const dirty = t.kind === "query" && t.dirty;
        return (
          <div
            key={t.id}
            data-tab-id={t.id}
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onKeyDown={(e) => onTabKey(e, idx)}
            draggable
            className={`group relative flex items-center gap-2 px-3 border-r border-line-soft cursor-pointer max-w-56 select-none focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--color-brass)] ${
              active ? "bg-ink-900 text-paper shadow-[inset_0_2px_0_var(--color-brass)]" : "text-muted hover:text-paper-dim hover:bg-ink-900/50"
            } ${draggedId === t.id ? "opacity-40" : ""}`}
            onClick={() => {
              activateTab(t.id);
              requestEditorFocus(t.id);
            }}
            onAuxClick={(e) => {
              if (e.button === 1) closeTab(t.id);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ tabId: t.id, x: e.clientX, y: e.clientY });
            }}
            onDragStart={(e) => {
              setDraggedId(t.id);
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragEnd={() => {
              setDraggedId(null);
              setDropTarget(null);
            }}
            onDragOver={(e) => {
              if (!draggedId || draggedId === t.id) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              const rect = e.currentTarget.getBoundingClientRect();
              const side = e.clientX - rect.left < rect.width / 2 ? "before" : "after";
              setDropTarget((prev) => (prev?.id === t.id && prev.side === side ? prev : { id: t.id, side }));
            }}
            onDragLeave={(e) => {
              if (e.currentTarget.contains(e.relatedTarget as Node)) return;
              setDropTarget((prev) => (prev?.id === t.id ? null : prev));
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (draggedId && dropTarget && dropTarget.id === t.id) {
                reorderTab(draggedId, t.id, dropTarget.side);
              }
              setDraggedId(null);
              setDropTarget(null);
            }}
            title={t.kind === "query" && t.filePath ? t.filePath : t.title}
          >
            {dropTarget?.id === t.id && (
              <span
                className={`absolute inset-y-0.5 w-0.5 bg-brass ${dropTarget.side === "before" ? "left-0" : "right-0"}`}
              />
            )}
            {t.kind === "table" && <span className="text-faint text-[length:var(--fs-sm)]">{t.objectType === "view" ? "◫" : "▦"}</span>}
            {t.kind === "routine" && <span className="text-faint text-[length:var(--fs-sm)]">{t.routineType === "function" ? "λ" : "≡"}</span>}
            {t.kind === "diagram" && <span className="text-faint text-[length:var(--fs-sm)]">⧉</span>}
            {t.kind === "docs" && <span className="text-faint text-[length:var(--fs-sm)]">?</span>}
            {(t.kind === "query" || t.kind === "table") && t.openedBy === "capi" && (
              <span className="text-brass shrink-0" title="Opened by Capi" aria-label="Opened by Capi">
                <CapiMark />
              </span>
            )}
            {running && <span className="size-1.5 rounded-full bg-brass pulse-soft shrink-0" />}
            <span className="truncate text-[length:var(--fs-base)]">
              {t.title}
              {dirty ? " •" : ""}
            </span>
            <IconButton
              size="sm"
              title={`Close tab (${accel("W")})`}
              aria-label="Close tab"
              tabIndex={-1}
              className="-mr-1 text-faint hover:text-err opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 focus-visible:opacity-100"
              onClick={(e) => {
                e.stopPropagation();
                closeTab(t.id);
              }}
            >
              ✕
            </IconButton>
          </div>
        );
      })}
      </div>
      {sqlEditor && (
        <IconButton
          title={`New query tab (${accel("T")})`}
          aria-label="New query tab"
          className="self-center mx-1 text-muted hover:text-brass text-base"
          onClick={() => newQueryTab()}
        >
          +
        </IconButton>
      )}

      <div className="flex-1" />

      {connected && (
        <>
          <button
            className={toggleBtn(capturePlan)}
            title="Capture actual execution plan on next run"
            aria-label="Capture execution plan"
            aria-pressed={capturePlan}
            onClick={() => toggleCapturePlan()}
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2">
              <circle cx="8" cy="3" r="1.6" />
              <circle cx="4" cy="12" r="1.6" />
              <circle cx="12" cy="12" r="1.6" />
              <path d="M8 4.6V8M8 8L4 10.6M8 8l4 2.6" strokeLinecap="round" />
            </svg>
          </button>
          <button
            className={toggleBtn(captureStats)}
            title="Capture client statistics (STATISTICS TIME, IO) on next run"
            aria-label="Capture client statistics"
            aria-pressed={captureStats}
            onClick={() => toggleCaptureStats()}
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2">
              <circle cx="8" cy="9" r="5.2" />
              <path d="M8 9V5.5M6 2h4" strokeLinecap="round" />
            </svg>
          </button>
        </>
      )}
      {menu && <TabContextMenu tabId={menu.tabId} x={menu.x} y={menu.y} onClose={() => setMenu(null)} />}
    </div>
  );
}
