// Traces: BASED-HISTORY-UI (manual)
// Left-rail History panel: the connection's query history (BASED-HISTORY) and agent audit log
// (BASED-AGENT-AUDIT), most-recent-first, with client-side search + status filtering and inline
// expand. The Agent sub-tab is read-only — never a re-run affordance (that would bypass the
// mutation gate).
import { useCallback, useEffect, useState } from "react";
import { useStore } from "../store";
import { fetchHistory, fetchAgentAudit } from "../api/client";
import type { AuditEntry, HistoryEntry } from "../api/types";
import { IconButton } from "./IconButton";

type SubTab = "queries" | "agent";
type StatusFilter = "all" | "ok" | "error" | "cancelled";

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function firstLine(sql: string): string {
  for (const line of sql.split("\n")) {
    const t = line.trim();
    if (t) return t;
  }
  return sql.trim();
}

function statusDot(status: string): string {
  return status === "ok" ? "bg-ok" : status === "error" ? "bg-err" : "bg-faint";
}

const chipCls = (active: boolean) =>
  `rounded-full border px-2 py-px text-[length:var(--fs-xs)] ${
    active ? "border-brass text-brass" : "border-line text-faint hover:text-muted"
  }`;

export function HistoryPanel() {
  const activeConnectionId = useStore((s) => s.activeConnectionId);
  const status = useStore((s) => s.status);
  const insertSqlIntoEditor = useStore((s) => s.insertSqlIntoEditor);
  const newQueryTabWithContent = useStore((s) => s.newQueryTabWithContent);
  const capabilities = useStore((s) => s.capabilities);

  const [sub, setSub] = useState<SubTab>("queries");
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!activeConnectionId) {
      setEntries([]);
      setAuditEntries([]);
      return;
    }
    setError(null);
    void Promise.all([fetchHistory(activeConnectionId), fetchAgentAudit(activeConnectionId)])
      .then(([h, a]) => {
        setEntries(h);
        setAuditEntries(a);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [activeConnectionId]);

  useEffect(() => {
    setExpandedId(null);
    load();
  }, [load]);

  if (!activeConnectionId) {
    return <div className="p-4 text-faint text-[length:var(--fs-base)] italic">No connection.</div>;
  }

  const needle = search.trim().toLowerCase();
  const rows: Array<HistoryEntry | AuditEntry> = (sub === "queries" ? entries : auditEntries).filter((e) => {
    if (needle && !e.sql.toLowerCase().includes(needle)) return false;
    if (sub === "queries" && statusFilter !== "all" && e.status !== statusFilter) return false;
    return true;
  });

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-1 px-3 pt-2">
        {(["queries", "agent"] as const).map((t) => (
          <button
            key={t}
            className={`px-2 py-1 text-[length:var(--fs-sm)] border-b-2 ${
              sub === t ? "border-brass text-brass font-semibold" : "border-transparent text-faint hover:text-muted"
            }`}
            onClick={() => {
              setSub(t);
              setExpandedId(null);
            }}
          >
            {t === "queries" ? "Queries" : "Agent"}
          </button>
        ))}
        <div className="flex-1" />
        <IconButton title="Refresh" aria-label="Refresh history" className="text-faint hover:text-brass" onClick={load}>
          ↻
        </IconButton>
      </div>
      <div className="px-3 py-1.5 space-y-1.5">
        <input
          className="w-full px-2 py-1 rounded border border-line bg-ink-900 text-paper text-[length:var(--fs-sm)] focus:outline-none focus:border-brass-soft"
          placeholder="Search SQL…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {sub === "queries" && (
          <div className="flex items-center gap-1">
            {(["all", "ok", "error", "cancelled"] as const).map((f) => (
              <button key={f} className={chipCls(statusFilter === f)} onClick={() => setStatusFilter(f)}>
                {f}
              </button>
            ))}
          </div>
        )}
      </div>
      {error && <div className="px-3 py-1 text-err text-[length:var(--fs-sm)]">{error}</div>}
      <div className="flex-1 min-h-0 overflow-y-auto border-t border-line-soft">
        {rows.length === 0 && (
          <div className="p-4 text-faint italic text-[length:var(--fs-base)]">
            {status !== "connected" ? "Not connected." : "Nothing here yet."}
          </div>
        )}
        {rows.map((e) => {
          const expanded = expandedId === e.id;
          const audit = sub === "agent" ? (e as AuditEntry) : null;
          return (
            <div key={e.id} className="border-b border-line-soft">
              <button
                className="w-full text-left px-3 py-1.5 hover:bg-ink-900 group"
                onClick={() => setExpandedId(expanded ? null : e.id)}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`size-1.5 rounded-full shrink-0 ${statusDot(e.status)}`} />
                  <span className="truncate font-mono text-[length:var(--fs-sm)] text-paper-dim group-hover:text-paper">
                    {firstLine(e.sql)}
                  </span>
                </div>
                <div className="pl-3.5 text-[length:var(--fs-xs)] text-faint truncate">
                  {relativeTime(e.startedAt)}
                  {e.durationMs != null && ` · ${e.durationMs} ms`}
                  {e.database && ` · ${e.database}`}
                  {audit && ` · ${audit.kind}${audit.kind === "mutation" && audit.approved ? " (approved)" : ""}`}
                </div>
              </button>
              {expanded && (
                <div className="px-3 pb-2">
                  <pre className="max-h-48 overflow-auto rounded border border-line bg-ink-950 p-2 font-mono text-[length:var(--fs-xs)] text-paper-dim whitespace-pre-wrap">
                    {e.sql}
                  </pre>
                  {e.error && <div className="mt-1 text-err text-[length:var(--fs-xs)] whitespace-pre-wrap">{e.error}</div>}
                  <div className="mt-1.5 flex items-center gap-2 text-[length:var(--fs-sm)]">
                    {!audit && capabilities?.sql !== false && (
                      <>
                        <button className="text-brass hover:underline" onClick={() => insertSqlIntoEditor(e.sql)}>
                          Insert
                        </button>
                        <button
                          className="text-brass hover:underline"
                          onClick={() => newQueryTabWithContent(null, e.sql)}
                        >
                          Open in new tab
                        </button>
                      </>
                    )}
                    <button className="text-brass hover:underline" onClick={() => void navigator.clipboard.writeText(e.sql)}>
                      Copy
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
