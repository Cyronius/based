import { useEffect, useState } from "react";
import { fetchHealth } from "../api/client";
import { activeQueryTab, useStore } from "../store";

export function StatusBar() {
  // The running build's version, so a bug report can name it. Fetched once; a failure just leaves
  // the slot empty rather than nagging -- the status bar is not the place to surface a dead core,
  // the connection indicator to its left already does that.
  const [version, setVersion] = useState("");
  useEffect(() => {
    fetchHealth()
      .then((h) => setVersion(h.version))
      .catch(() => {});
  }, []);

  const status = useStore((s) => s.status);
  const statusDetail = useStore((s) => s.statusDetail);
  const database = useStore((s) => s.database);
  const connections = useStore((s) => s.connections);
  const activeConnectionId = useStore((s) => s.activeConnectionId);
  const resumeSession = useStore((s) => s.resumeSession);
  const tab = useStore(activeQueryTab);

  const conn = connections.find((c) => c.id === activeConnectionId);
  const statusColor =
    status === "connected" ? "text-ok" : status === "disconnected" ? "text-faint" : "text-brass";
  // BASED-UI-SESSION-RESUME: only offer a manual retry once auto-resume has given up on a
  // connection we actually had — never on a fresh boot where nothing's been picked yet.
  const showReconnect = status === "disconnected" && activeConnectionId != null;

  return (
    <footer className="h-7 shrink-0 flex items-center gap-4 px-3 border-t border-line bg-ink-900 text-[length:var(--fs-sm)] font-mono">
      <span className={`flex items-center gap-1.5 ${statusColor}`}>
        <span className={`size-1.5 rounded-full bg-current ${status === "reconnecting" || status === "connecting" ? "pulse-soft" : ""}`} />
        {status === "reconnecting" ? "reconnecting…" : status}
        {statusDetail ? ` — ${statusDetail}` : ""}
      </span>
      {showReconnect && (
        <button className="text-brass hover:underline" onClick={() => resumeSession()}>
          Reconnect
        </button>
      )}
      {conn && (
        <span className="text-muted truncate">
          {conn.server}
          {database ? ` · ${database}` : ""}
        </span>
      )}
      <div className="flex-1" />
      {tab?.running && <span className="text-brass pulse-soft">executing…</span>}
      {tab?.stats && !tab.running && (
        <span className={tab.stats.status === "ok" ? "text-muted" : tab.stats.status === "cancelled" ? "text-brass" : "text-err"}>
          last run: {tab.stats.status} in {tab.stats.durationMs.toLocaleString()} ms
        </span>
      )}
      {version && <span className="text-faint" title={`based ${version}`}>v{version}</span>}
    </footer>
  );
}
