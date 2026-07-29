import { useState } from "react";
import { useStore } from "../store";
import { TabContextMenu } from "./TabContextMenu";
import { IconButton } from "./IconButton";

const MAX_FETCH_SIZE = 50_000;

export function TabStrip() {
  const tabs = useStore((s) => s.tabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const activateTab = useStore((s) => s.activateTab);
  const closeTab = useStore((s) => s.closeTab);
  const reorderTab = useStore((s) => s.reorderTab);
  const newQueryTab = useStore((s) => s.newQueryTab);
  const capabilities = useStore((s) => s.capabilities);
  const rowPageSize = useStore((s) => s.rowPageSize);
  const setRowPageSize = useStore((s) => s.setRowPageSize);
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

  const [fetchSizeText, setFetchSizeText] = useState(String(rowPageSize));
  const [menu, setMenu] = useState<{ tabId: string; x: number; y: number } | null>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; side: "before" | "after" } | null>(null);

  const visible = tabs.filter((t) => !(t.kind === "query" && t.parentTabId));

  function commitFetchSize(): void {
    const n = Math.min(MAX_FETCH_SIZE, Math.max(1, Math.floor(Number(fetchSizeText)) || rowPageSize));
    setFetchSizeText(String(n));
    if (n !== rowPageSize) setRowPageSize(n);
  }

  const toggleBtn = (active: boolean) =>
    `grid place-items-center h-full w-8 border-l border-line-soft text-[length:var(--fs-md)] shrink-0 ${
      active
        ? "bg-ink-900 text-brass shadow-[inset_0_2px_0_var(--color-brass)]"
        : "text-muted hover:text-paper-dim hover:bg-ink-900/50"
    }`;

  return (
    <div className="flex items-stretch h-9 border-b border-line-soft bg-ink-950 overflow-x-auto shrink-0">
      {visible.map((t) => {
        const active = t.id === activeTabId;
        const running = t.kind === "query" && t.running;
        const dirty = t.kind === "query" && t.dirty;
        return (
          <div
            key={t.id}
            draggable
            className={`group relative flex items-center gap-2 px-3 border-r border-line-soft cursor-pointer max-w-56 select-none ${
              active ? "bg-ink-900 text-paper shadow-[inset_0_2px_0_var(--color-brass)]" : "text-muted hover:text-paper-dim hover:bg-ink-900/50"
            } ${draggedId === t.id ? "opacity-40" : ""}`}
            onClick={() => activateTab(t.id)}
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
            {running && <span className="size-1.5 rounded-full bg-brass pulse-soft shrink-0" />}
            <span className="truncate text-[length:var(--fs-base)]">
              {t.title}
              {dirty ? " •" : ""}
            </span>
            <IconButton
              size="sm"
              title="Close tab (Ctrl+W)"
              aria-label="Close tab"
              className="-mr-1 text-faint hover:text-err opacity-0 group-hover:opacity-100"
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
      {sqlEditor && (
        <IconButton
          title="New query tab (Ctrl+T)"
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
          <label className="self-center flex items-baseline gap-1.5 pl-2 pr-2 border-l border-line-soft select-none">
            <span className="text-[length:var(--fs-sm)] leading-none text-faint">Rows</span>
            <input
              type="text"
              inputMode="numeric"
              className="field-sizing-content min-w-8 px-1.5 py-1 border border-line-soft rounded-sm bg-transparent text-[length:var(--fs-sm)] leading-none text-muted font-mono focus:text-paper focus:border-brass focus:outline-none"
              value={fetchSizeText}
              title="Max rows to fetch per query run"
              aria-label="Fetch size"
              onChange={(e) => setFetchSizeText(e.target.value)}
              onBlur={commitFetchSize}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              }}
            />
          </label>
          <button
            className={toggleBtn(capturePlan)}
            title="Capture actual execution plan on next run"
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
