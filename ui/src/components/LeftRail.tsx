import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { ObjectExplorer } from "./ObjectExplorer";
import { HistoryPanel } from "./HistoryPanel";
import { ThemePicker } from "./ThemePicker";
import { IconButton } from "./IconButton";
import { authLabel, connSubtitle, profileFor } from "../lib/engineProfile";

const WIDTH_KEY = "based:leftRailWidth";
// Traces: BASED-HISTORY-UI — which lower-pane view the rail shows, persisted across restarts.
const RAIL_VIEW_KEY = "based:leftRailView";
const MIN_WIDTH = 220;
const MAX_WIDTH = 560;
const DEFAULT_WIDTH = 288;

function loadWidth(): number {
  const stored = Number(localStorage.getItem(WIDTH_KEY));
  return Number.isFinite(stored) && stored >= MIN_WIDTH && stored <= MAX_WIDTH ? stored : DEFAULT_WIDTH;
}

function ConnectionSelector() {
  const connections = useStore((s) => s.connections);
  const engines = useStore((s) => s.engines);
  const activeConnectionId = useStore((s) => s.activeConnectionId);
  const status = useStore((s) => s.status);
  const connect = useStore((s) => s.connect);
  const setDialog = useStore((s) => s.setDialog);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const active = connections.find((c) => c.id === activeConnectionId);

  return (
    <div className="relative" ref={ref}>
      <button
        className="w-full text-left px-3 py-2 rounded border border-line bg-ink-900 hover:border-brass-soft/60 transition-colors group"
        onClick={() => setOpen(!open)}
      >
        {active ? (
          <>
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-medium truncate">{active.name}</span>
              <span
                className={`size-1.5 rounded-full shrink-0 ${
                  status === "connected" ? "bg-ok" : status === "disconnected" ? "bg-faint" : "bg-brass pulse-soft"
                }`}
              />
            </div>
            <div className="text-[length:var(--fs-sm)] text-muted truncate">{authLabel(active, engines)}</div>
          </>
        ) : (
          <div className="text-muted py-0.5">Select a connection…</div>
        )}
      </button>

      {open && (
        <div className="absolute z-30 mt-1 w-full rounded border border-line bg-ink-850 shadow-xl shadow-black/40 fade-up">
          {connections.map((c) => (
            <div key={c.id} className="flex items-center group border-b border-line-soft last:border-b-0">
              <button
                className={`flex-1 text-left px-3 py-2 hover:bg-ink-800 min-w-0 ${c.id === activeConnectionId ? "text-brass" : ""}`}
                onClick={() => {
                  setOpen(false);
                  void connect(c.id);
                }}
              >
                <div className="truncate">{c.name}</div>
                <div className="text-[length:var(--fs-sm)] text-muted truncate">{connSubtitle(c, engines)}</div>
              </button>
              <IconButton
                title="Edit connection"
                aria-label="Edit connection"
                className="mr-1 text-faint opacity-0 group-hover:opacity-100 hover:text-brass"
                onClick={() => {
                  setOpen(false);
                  setDialog({ mode: "edit", connection: c });
                }}
              >
                ✎
              </IconButton>
            </div>
          ))}
          <button
            className="w-full text-left px-3 py-2 text-brass hover:bg-ink-800"
            onClick={() => {
              setOpen(false);
              setDialog({ mode: "new" });
            }}
          >
            + New connection
          </button>
        </div>
      )}
    </div>
  );
}

export function LeftRail() {
  const databases = useStore((s) => s.databases);
  const database = useStore((s) => s.database);
  const schemas = useStore((s) => s.schemas);
  const schemaFilter = useStore((s) => s.schemaFilter);
  const setSchemaFilter = useStore((s) => s.setSchemaFilter);
  const setDatabase = useStore((s) => s.setDatabase);
  const activeConnectionId = useStore((s) => s.activeConnectionId);
  const status = useStore((s) => s.status);
  const connections = useStore((s) => s.connections);
  const engines = useStore((s) => s.engines);
  const capabilities = useStore((s) => s.capabilities);
  const openDiagramTab = useStore((s) => s.openDiagramTab);
  const openDocsTab = useStore((s) => s.openDocsTab);
  const activeConn = connections.find((c) => c.id === activeConnectionId);
  // Both affordances are engine-shaped, so both come from the engine profile rather than from an
  // id comparison. The database selector exists when the engine declares a `database` field at all
  // (LanceDB has a single implicit one); the schema filter also serves base-folder LanceDB, whose
  // subfolders populate `schemas` (BASED-LANCE-SQL-GATING).
  const activeProfile = activeConn ? profileFor(activeConn, engines) : undefined;
  const sqlEngine = !activeConn || (activeProfile?.fields.some((f) => f.key === "database") ?? true);
  const showSchemaFilter = !activeProfile || activeProfile.namespace.key != null || schemas.length > 0;

  const selectCls =
    "w-full px-2 py-1.5 rounded border border-line bg-ink-900 text-paper text-[length:var(--fs-base)] focus:outline-none focus:border-brass-soft disabled:opacity-40";

  const [width, setWidth] = useState(loadWidth);
  const [dragging, setDragging] = useState(false);
  const [railView, setRailView] = useState<"objects" | "history">(() =>
    localStorage.getItem(RAIL_VIEW_KEY) === "history" ? "history" : "objects",
  );

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, e.clientX));
      setWidth(next);
      localStorage.setItem(WIDTH_KEY, String(next));
    };
    const onUp = () => setDragging(false);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragging]);

  return (
    <aside className="relative shrink-0 flex flex-col bg-ink-950" style={{ width }}>
      <div
        className="absolute right-0 top-0 z-10 h-full w-1 translate-x-1/2 cursor-ew-resize hover:bg-brass/40 active:bg-brass/50"
        title="Drag to resize"
        onMouseDown={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
      />
      <div className="px-4 pt-3 pb-2 flex items-center justify-between">
        <span className="font-display italic font-semibold text-xl tracking-tight text-paper">based</span>
        <div className="flex items-center gap-1">
          {/* Traces: BASED-HELP-DOCS — opens the help tab; works with no connection active. */}
          <IconButton
            className="text-faint hover:text-brass"
            title="Help & keyboard shortcuts"
            aria-label="Help & keyboard shortcuts"
            onClick={() => openDocsTab()}
          >
            ?
          </IconButton>
          <ThemePicker />
        </div>
      </div>

      <div className="px-3 space-y-2">
        <ConnectionSelector />
        {sqlEngine && (
          <select
            className={selectCls}
            value={database ?? ""}
            disabled={!activeConnectionId || status !== "connected"}
            onChange={(e) => void setDatabase(e.target.value)}
            title="Database"
          >
            {database == null && <option value="">— database —</option>}
            {databases.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        )}
        {showSchemaFilter && (
          <div className="flex items-center gap-1.5">
            <select
              className={selectCls}
              value={schemaFilter}
              disabled={!activeConnectionId || status !== "connected"}
              onChange={(e) => setSchemaFilter(e.target.value)}
              title="Schema filter"
            >
              <option value="">All schemas</option>
              {schemas.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            {/* Traces: BASED-DIAGRAM-UI — opens the ER diagram scoped to the current schema filter. */}
            {capabilities?.relations && (
              <IconButton
                title="View ER diagram"
                aria-label="View ER diagram"
                className="shrink-0 text-faint hover:text-brass"
                disabled={status !== "connected"}
                onClick={() => openDiagramTab(schemaFilter)}
              >
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2">
                  <rect x="1.5" y="2" width="5" height="4" rx="0.5" />
                  <rect x="9.5" y="2" width="5" height="4" rx="0.5" />
                  <rect x="5.5" y="10" width="5" height="4" rx="0.5" />
                  <path d="M4 6v2.5h4M12 6v2.5H8" strokeLinecap="round" />
                </svg>
              </IconButton>
            )}
          </div>
        )}
      </div>

      <div className="mt-3 px-3 flex items-center gap-1">
        {(["objects", "history"] as const).map((v) => (
          <button
            key={v}
            className={`px-2 py-1 text-[length:var(--fs-sm)] border-b-2 ${
              railView === v ? "border-brass text-brass font-semibold" : "border-transparent text-faint hover:text-muted"
            }`}
            onClick={() => {
              setRailView(v);
              localStorage.setItem(RAIL_VIEW_KEY, v);
            }}
          >
            {v === "objects" ? "Objects" : "History"}
          </button>
        ))}
      </div>
      <div className="flex-1 min-h-0 border-t border-line-soft">
        {railView === "objects" ? <ObjectExplorer /> : <HistoryPanel />}
      </div>
    </aside>
  );
}
