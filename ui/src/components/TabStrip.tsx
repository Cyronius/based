import { useState } from "react";
import { useStore } from "../store";
import { engineOf } from "../api/types";

const MAX_FETCH_SIZE = 50_000;

export function TabStrip() {
  const tabs = useStore((s) => s.tabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const activateTab = useStore((s) => s.activateTab);
  const closeTab = useStore((s) => s.closeTab);
  const newQueryTab = useStore((s) => s.newQueryTab);
  const activeConnectionId = useStore((s) => s.activeConnectionId);
  const connections = useStore((s) => s.connections);
  const rowPageSize = useStore((s) => s.rowPageSize);
  const setRowPageSize = useStore((s) => s.setRowPageSize);
  const capturePlan = useStore((s) => s.capturePlan);
  const captureStats = useStore((s) => s.captureStats);
  const toggleCapturePlan = useStore((s) => s.toggleCapturePlan);
  const toggleCaptureStats = useStore((s) => s.toggleCaptureStats);
  const activeConn = connections.find((c) => c.id === activeConnectionId);
  const sqlEditor = !activeConn || engineOf(activeConn) === "mssql";

  const [fetchSizeText, setFetchSizeText] = useState(String(rowPageSize));

  const visibleTabs = tabs.filter((t) => !(t.kind === "query" && t.parentTabId));

  function commitFetchSize(): void {
    const n = Math.min(MAX_FETCH_SIZE, Math.max(1, Math.floor(Number(fetchSizeText)) || rowPageSize));
    setFetchSizeText(String(n));
    if (n !== rowPageSize) setRowPageSize(n);
  }

  const toggleBtn = (active: boolean) =>
    `grid place-items-center h-full w-8 border-l border-line-soft text-[13px] shrink-0 ${
      active
        ? "bg-ink-900 text-brass shadow-[inset_0_2px_0_var(--color-brass)]"
        : "text-muted hover:text-paper-dim hover:bg-ink-900/50"
    }`;

  return (
    <div className="flex items-stretch h-9 border-b border-line-soft bg-ink-950 overflow-x-auto shrink-0">
      {visibleTabs.map((t) => {
        const active = t.id === activeTabId;
        const running = t.kind === "query" && t.running;
        const dirty = t.kind === "query" && t.dirty;
        return (
          <div
            key={t.id}
            className={`group flex items-center gap-2 px-3 border-r border-line-soft cursor-pointer max-w-56 select-none ${
              active ? "bg-ink-900 text-paper shadow-[inset_0_2px_0_var(--color-brass)]" : "text-muted hover:text-paper-dim hover:bg-ink-900/50"
            }`}
            onClick={() => activateTab(t.id)}
            onAuxClick={(e) => {
              if (e.button === 1) closeTab(t.id);
            }}
            title={t.kind === "query" && t.filePath ? t.filePath : t.title}
          >
            {t.kind === "table" && <span className="text-faint text-[11px]">{t.objectType === "view" ? "◫" : "▦"}</span>}
            {t.kind === "routine" && <span className="text-faint text-[11px]">{t.routineType === "function" ? "λ" : "≡"}</span>}
            {running && <span className="size-1.5 rounded-full bg-brass pulse-soft shrink-0" />}
            <span className="truncate text-[12px]">
              {t.title}
              {dirty ? " •" : ""}
            </span>
            <button
              className="text-faint hover:text-err opacity-0 group-hover:opacity-100 transition-opacity text-[11px]"
              onClick={(e) => {
                e.stopPropagation();
                closeTab(t.id);
              }}
            >
              ✕
            </button>
          </div>
        );
      })}
      {sqlEditor && (
        <button
          className="px-3 text-muted hover:text-brass text-base leading-none"
          title="New query tab"
          onClick={() => newQueryTab()}
        >
          +
        </button>
      )}

      <div className="flex-1" />

      <input
        type="number"
        className="w-16 h-full px-2 border-l border-line-soft bg-transparent text-[11px] text-muted text-right font-mono focus:text-paper focus:outline-none"
        min={1}
        max={MAX_FETCH_SIZE}
        value={fetchSizeText}
        title="Max rows to fetch per query run"
        aria-label="Fetch size"
        onChange={(e) => setFetchSizeText(e.target.value)}
        onBlur={commitFetchSize}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />
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
    </div>
  );
}
