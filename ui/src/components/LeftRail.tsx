import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { ObjectExplorer } from "./ObjectExplorer";
import type { AuthType } from "../api/types";

const AUTH_LABEL: Record<AuthType, string> = {
  "entra-interactive": "Entra ID",
  "azure-cli": "Azure CLI",
  "sql-login": "SQL login",
  "service-principal": "Service principal",
};

function ConnectionSelector() {
  const connections = useStore((s) => s.connections);
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
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
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
            <div className="text-[11px] text-muted truncate">{AUTH_LABEL[active.authType]}</div>
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
                <div className="text-[11px] text-muted truncate">
                  {c.server} · {AUTH_LABEL[c.authType]}
                </div>
              </button>
              <button
                title="Edit connection"
                className="px-2 py-2 text-faint opacity-0 group-hover:opacity-100 hover:text-brass transition-opacity"
                onClick={() => {
                  setOpen(false);
                  setDialog({ mode: "edit", connection: c });
                }}
              >
                ✎
              </button>
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

  const selectCls =
    "w-full px-2 py-1.5 rounded border border-line bg-ink-900 text-paper text-[12px] focus:outline-none focus:border-brass-soft disabled:opacity-40";

  return (
    <aside className="w-72 shrink-0 flex flex-col bg-ink-950">
      <div className="px-4 pt-3 pb-2 flex items-baseline justify-between">
        <span className="font-display italic font-semibold text-xl tracking-tight text-paper">based</span>
        <span className="ledger-label">the ledger</span>
      </div>

      <div className="px-3 space-y-2">
        <ConnectionSelector />
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
      </div>

      <div className="mt-3 flex-1 min-h-0 border-t border-line-soft">
        <ObjectExplorer />
      </div>
    </aside>
  );
}
