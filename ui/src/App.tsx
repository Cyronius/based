import { useEffect } from "react";
import { openEvents } from "./api/client";
import { activeQueryTab, useStore } from "./store";
import monaco from "./monacoSetup";
import { syncMonacoTheme } from "./theme";
import { LeftRail } from "./components/LeftRail";
import { TabStrip } from "./components/TabStrip";
import { QueryTabView } from "./components/QueryTabView";
import { TableDetailsView } from "./components/TableDetailsView";
import { RoutineDetailsView } from "./components/RoutineDetailsView";
import { RightRail } from "./components/RightRail";
import { StatusBar } from "./components/StatusBar";
import { ConnectionDialog } from "./components/ConnectionDialog";

function EmptyState() {
  const connections = useStore((s) => s.connections);
  const setDialog = useStore((s) => s.setDialog);
  return (
    <div className="flex-1 grid place-items-center">
      <div className="text-center fade-up">
        <div className="font-display italic text-6xl text-paper-dim tracking-tight">based</div>
        <div className="mt-3 text-muted text-sm">
          {connections.length === 0 ? (
            <>
              No connections yet —{" "}
              <button className="text-brass hover:underline" onClick={() => setDialog({ mode: "new" })}>
                create one
              </button>{" "}
              to begin.
            </>
          ) : (
            "Pick a connection to begin."
          )}
        </div>
      </div>
    </div>
  );
}

export function App() {
  const loadConnections = useStore((s) => s.loadConnections);
  const loadSettings = useStore((s) => s.loadSettings);
  const restoreWindow = useStore((s) => s.restoreWindow);
  const theme = useStore((s) => s.theme);
  const setStatus = useStore((s) => s.setStatus);
  const resumeSession = useStore((s) => s.resumeSession);
  const tabs = useStore((s) => s.tabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const activeConnectionId = useStore((s) => s.activeConnectionId);
  const dialog = useStore((s) => s.dialog);
  const banner = useStore((s) => s.banner);
  const setBanner = useStore((s) => s.setBanner);

  useEffect(() => {
    void loadSettings();
    // BASED-WINDOW-RESTORE: reconnect to whatever this window last showed, once connections are loaded.
    void loadConnections().then(() => void restoreWindow());
    const es = openEvents((event) => {
      if (event.type === "connection-status") {
        const { activeConnectionId: current, status } = useStore.getState();
        // Only mirror push-status for the live session; connect() manages its own transitions.
        if (current && event.connectionId === current && status !== "connecting") {
          setStatus(event.status as never, (event.detail as string) ?? null);
        } else if (current && event.connectionId !== current && status === "connected") {
          // BASED-UI-SESSION-RESUME: a snapshot for a different (or blank) session while we still
          // think we're connected means the based server restarted and lost this window's session —
          // resume automatically instead of leaving the UI stuck on a stale "connected" state.
          resumeSession();
        }
      }
    });
    return () => es.close();
  }, [loadConnections, loadSettings, restoreWindow, setStatus, resumeSession]);

  // Keep Monaco's global "based" theme in sync even when no editor is mounted.
  useEffect(() => {
    syncMonacoTheme(monaco);
  }, [theme]);

  // Global keybindings (Monaco registers its own when focused)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const state = useStore.getState();
      const tab = activeQueryTab(state);
      if (e.key === "F5" || (e.key === "Enter" && e.ctrlKey)) {
        e.preventDefault();
        if (tab) void state.runQuery(tab.id);
      } else if (e.key.toLowerCase() === "s" && e.ctrlKey) {
        e.preventDefault();
        if (tab) void state.saveTab(tab.id);
      } else if (e.key === "Pause" && e.ctrlKey) {
        e.preventDefault();
        if (tab?.running) void state.cancelQuery(tab.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const activeTab = tabs.find((t) => t.id === activeTabId);

  return (
    <div className="h-full flex flex-col bg-ink-950">
      <div className="flex flex-1 min-h-0">
        <LeftRail />
        <main className="flex-1 min-w-0 flex flex-col border-l border-line-soft">
          {banner && (
            <div className="flex items-center gap-3 px-4 py-2 text-[length:var(--fs-base)] bg-err/10 text-err border-b border-err/30">
              <span className="flex-1 font-mono">{banner}</span>
              <button className="text-muted hover:text-paper" onClick={() => setBanner(null)}>
                ✕
              </button>
            </div>
          )}
          {activeConnectionId ? (
            <>
              <TabStrip />
              {activeTab?.kind === "query" && <QueryTabView key={activeTab.id} tab={activeTab} />}
              {activeTab?.kind === "table" && <TableDetailsView tab={activeTab} />}
              {activeTab?.kind === "routine" && <RoutineDetailsView tab={activeTab} />}
              {!activeTab && <div className="flex-1" />}
            </>
          ) : (
            <EmptyState />
          )}
        </main>
        <RightRail />
      </div>
      <StatusBar />
      {dialog.mode !== "closed" && <ConnectionDialog />}
    </div>
  );
}
