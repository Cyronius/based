import { useEffect } from "react";
import { openEvents } from "./api/client";
import { activeQueryTab, useStore, visibleTabs } from "./store";
import monaco from "./monacoSetup";
import { syncMonacoTheme } from "./theme";
import { LeftRail } from "./components/LeftRail";
import { TabStrip } from "./components/TabStrip";
import { QueryTabView } from "./components/QueryTabView";
import { TableDetailsView } from "./components/TableDetailsView";
import { RoutineDetailsView } from "./components/RoutineDetailsView";
import { DiagramView } from "./components/DiagramView";
import { RightRail } from "./components/RightRail";
import { StatusBar } from "./components/StatusBar";
import { ConnectionDialog } from "./components/ConnectionDialog";
import { IconButton } from "./components/IconButton";

// BASED-OPEN-SQL-ARGV: a window created for an OS file-open carries `open=<path>` in the hash.
// Captured (and stripped) once at module load — surviving in the hash would re-open the file on
// every reload, and StrictMode's double-mounted effects couldn't tell first run from second.
const bootOpenPath = (() => {
  const params = new URLSearchParams(window.location.hash.slice(1));
  const p = params.get("open");
  if (p) {
    params.delete("open");
    window.location.hash = params.toString();
  }
  return p;
})();
let bootOpenConsumed = false;

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
  const loadEmbeddingProfiles = useStore((s) => s.loadEmbeddingProfiles);
  const loadRerankerProfiles = useStore((s) => s.loadRerankerProfiles);
  const loadAiProfiles = useStore((s) => s.loadAiProfiles);
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
    void loadEmbeddingProfiles();
    void loadRerankerProfiles();
    void loadAiProfiles();
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
  }, [loadConnections, loadSettings, loadEmbeddingProfiles, loadRerankerProfiles, loadAiProfiles, restoreWindow, setStatus, resumeSession]);

  // BASED-OPEN-SQL-ARGV: open the OS-requested file once this window has a connection to attach
  // the tab to (query tabs live under a connection). Fresh windows have no restored connection,
  // so the open waits for the user's first connect; restored windows fire right after restore.
  useEffect(() => {
    if (!bootOpenPath || bootOpenConsumed) return;
    const openIfConnected = (s: ReturnType<typeof useStore.getState>): boolean => {
      if (bootOpenConsumed || !s.activeConnectionId || s.status !== "connected") return false;
      bootOpenConsumed = true;
      void s.openSqlFile(bootOpenPath).catch((err) => {
        useStore.getState().setBanner(err instanceof Error ? err.message : String(err));
      });
      return true;
    };
    if (openIfConnected(useStore.getState())) return;
    const unsub = useStore.subscribe((s) => {
      if (openIfConnected(s)) unsub();
    });
    return unsub;
  }, []);

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
        if (tab) void state.saveTab(tab.id, { as: e.shiftKey });
      } else if (e.key.toLowerCase() === "o" && e.ctrlKey) {
        e.preventDefault();
        if (state.activeConnectionId) void state.openSqlFile();
      } else if (e.key === "Pause" && e.ctrlKey) {
        e.preventDefault();
        if (tab?.running) void state.cancelQuery(tab.id);
      } else if (e.key.toLowerCase() === "j" && e.ctrlKey) {
        e.preventDefault();
        state.toggleRightRail();
      } else if (e.key.toLowerCase() === "t" && e.ctrlKey) {
        e.preventDefault();
        if (state.activeConnectionId) state.newQueryTab();
      } else if (e.key.toLowerCase() === "n" && e.ctrlKey) {
        e.preventDefault();
        void state.newWindow();
      } else if (e.key.toLowerCase() === "w" && e.ctrlKey) {
        e.preventDefault();
        if (state.activeTabId) state.closeTab(state.activeTabId);
      } else if ((e.key === "PageUp" || e.key === "PageDown") && e.ctrlKey) {
        e.preventDefault();
        const visible = visibleTabs(state);
        if (visible.length > 1) {
          const idx = visible.findIndex((t) => t.id === state.activeTabId);
          const delta = e.key === "PageDown" ? 1 : -1;
          const nextIdx = idx === -1 ? 0 : (idx + delta + visible.length) % visible.length;
          state.activateTab(visible[nextIdx].id);
        }
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
              <IconButton size="sm" title="Dismiss" aria-label="Dismiss" className="text-muted hover:text-paper" onClick={() => setBanner(null)}>
                ✕
              </IconButton>
            </div>
          )}
          {activeConnectionId ? (
            <>
              <TabStrip />
              {activeTab?.kind === "query" && <QueryTabView key={activeTab.id} tab={activeTab} />}
              {activeTab?.kind === "table" && <TableDetailsView tab={activeTab} />}
              {activeTab?.kind === "routine" && <RoutineDetailsView tab={activeTab} />}
              {activeTab?.kind === "diagram" && <DiagramView tab={activeTab} />}
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
