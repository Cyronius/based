import { useEffect } from "react";
import { openEvents } from "./api/client";
import { activeQueryTab, useStore, visibleTabs } from "./store";
import { isAccel, isCancelChord } from "./platform";
import monaco from "./monacoSetup";
import { syncMonacoTheme, DEFAULT_FONT_SCALE, FONT_SCALE_STEP } from "./theme";
import { LeftRail } from "./components/LeftRail";
import { TabStrip } from "./components/TabStrip";
import { QueryTabView } from "./components/QueryTabView";
import { TableDetailsView } from "./components/TableDetailsView";
import { RoutineDetailsView } from "./components/RoutineDetailsView";
import { DiagramView } from "./components/DiagramView";
import { DocsView } from "./components/DocsView";
import { RightRail } from "./components/RightRail";
import { StatusBar } from "./components/StatusBar";
import { ConnectionDialog } from "./components/ConnectionDialog";
import { NewTableDialog } from "./components/NewTableDialog";
import { IconButton } from "./components/IconButton";

// BASED-OPEN-SQL-ARGV: a window created for an OS file-open carries one `open=<path>` hash param
// per file. Captured (and stripped) once at module load — surviving in the hash would re-open the
// files on every reload, and StrictMode's double-mounted effects couldn't tell first run from
// second.
const bootOpenPaths = (() => {
  const params = new URLSearchParams(window.location.hash.slice(1));
  const paths = params.getAll("open");
  if (paths.length > 0) {
    params.delete("open");
    window.location.hash = params.toString();
  }
  return paths;
})();
let bootOpenConsumed = false;

// BASED-SQL-OPEN-TARGET: file-open paths queued until this window has a connected session (query
// tabs live under a connection). Fed by the boot hash and by `open-files` SSE events; openSqlFile
// dedupes per window by filePath, so re-deliveries are harmless.
const pendingFileOpens: string[] = [];
let drainingFileOpens = false;

async function drainFileOpens(): Promise<void> {
  if (drainingFileOpens) return;
  drainingFileOpens = true;
  try {
    while (pendingFileOpens.length > 0) {
      const s = useStore.getState();
      if (!s.activeConnectionId || s.status !== "connected") return; // re-armed by the App subscription
      const path = pendingFileOpens.shift()!;
      try {
        await s.openSqlFile(path);
      } catch (err) {
        useStore.getState().setBanner(err instanceof Error ? err.message : String(err));
      }
    }
  } finally {
    drainingFileOpens = false;
  }
}

function queueFileOpens(paths: string[]): void {
  for (const p of paths) if (p && !pendingFileOpens.includes(p)) pendingFileOpens.push(p);
  void drainFileOpens();
}

// BASED-UI-FONT-ZOOM: accumulated wheel distance for one font-size step. One mouse notch is
// ~100–120px, so a notch is a step; a trackpad's finer deltas add up to the same thing.
const WHEEL_PX_PER_STEP = 100;

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
  const loadEngines = useStore((s) => s.loadEngines);
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
    // BASED-ENGINE-PROFILE-WIRE: the engine catalog drives the connection dialog, the object tree
    // shape and identifier quoting, so it loads with the rest of the app-level config.
    void loadEngines();
    void loadEmbeddingProfiles();
    void loadRerankerProfiles();
    void loadAiProfiles();
    // BASED-WINDOW-RESTORE: reconnect to whatever this window last showed, once connections are loaded.
    void loadConnections().then(() => void restoreWindow());
    const es = openEvents((event) => {
      if (event.type === "open-files") {
        // BASED-SQL-OPEN-TARGET: the shell routed a file-open batch to this window via core.
        queueFileOpens(Array.isArray(event.paths) ? (event.paths as string[]) : []);
      } else if (event.type === "connection-status") {
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
  }, [loadConnections, loadEngines, loadSettings, loadEmbeddingProfiles, loadRerankerProfiles, loadAiProfiles, restoreWindow, setStatus, resumeSession]);

  // BASED-OPEN-SQL-ARGV / BASED-SQL-OPEN-TARGET: queue the OS-requested files, and drain the queue
  // whenever the window (re)gains a connected session. Fresh windows have no restored connection,
  // so the opens wait for the user's first connect; restored windows fire right after restore.
  useEffect(() => {
    if (!bootOpenConsumed) {
      bootOpenConsumed = true;
      if (bootOpenPaths.length > 0) queueFileOpens(bootOpenPaths);
    }
    return useStore.subscribe((s) => {
      if (pendingFileOpens.length > 0 && s.activeConnectionId && s.status === "connected") void drainFileOpens();
    });
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
      if (e.key === "F5" || (e.key === "Enter" && isAccel(e))) {
        e.preventDefault();
        if (tab) void state.runQuery(tab.id);
      } else if (e.key.toLowerCase() === "s" && isAccel(e)) {
        e.preventDefault();
        if (tab) void state.saveTab(tab.id, { as: e.shiftKey });
      } else if (e.key.toLowerCase() === "o" && isAccel(e)) {
        e.preventDefault();
        if (state.activeConnectionId) void state.openSqlFile();
      } else if (isCancelChord(e)) {
        e.preventDefault();
        if (tab?.running) void state.cancelQuery(tab.id);
      } else if (e.key.toLowerCase() === "j" && isAccel(e)) {
        e.preventDefault();
        state.toggleRightRail();
      } else if (e.key.toLowerCase() === "t" && isAccel(e)) {
        e.preventDefault();
        if (state.activeConnectionId) state.newQueryTab();
      } else if (e.key.toLowerCase() === "n" && isAccel(e)) {
        e.preventDefault();
        void state.newWindow();
      } else if (e.key.toLowerCase() === "w" && isAccel(e)) {
        // On macOS this shadows the OS "close window" meaning on purpose — tabs here behave like
        // browser tabs, and browsers bind ⌘W to close-tab (the menu's Close Window is ⇧⌘W).
        e.preventDefault();
        if (state.activeTabId) state.closeTab(state.activeTabId);
      } else if (isAccel(e) && (e.key === "=" || e.key === "+" || e.key === "-" || e.key === "_")) {
        // Traces: BASED-UI-FONT-ZOOM — "=" and "-" are the unshifted keys; "+"/"_" cover Shift and
        // the numpad. Monaco's own zoom commands are not registered, so nothing shadows these.
        e.preventDefault();
        const grow = e.key === "=" || e.key === "+";
        state.setFontScale(state.fontScale + (grow ? FONT_SCALE_STEP : -FONT_SCALE_STEP));
      } else if (isAccel(e) && e.key === "0") {
        e.preventDefault();
        state.setFontScale(DEFAULT_FONT_SCALE);
      } else if ((e.key === "PageUp" || e.key === "PageDown") && e.ctrlKey) {
        // Ctrl (not ⌘) on every platform — the browser-tab-switching convention macOS also uses.
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
    // Traces: BASED-UI-FONT-ZOOM — Ctrl+wheel drives the same setting as the settings slider.
    // `passive: false` is required: without it preventDefault is ignored and the webview runs its
    // own page zoom underneath ours. `capture: true` puts us ahead of Monaco, the Glide grids and
    // every scroll container, so the gesture zooms instead of scrolling whatever is under the
    // cursor.
    let wheelAccum = 0;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      // A view that owns the wheel itself (the embeddings atlas — deck.gl zooms on wheel, and a
      // trackpad pinch arrives as Ctrl+wheel) opts out, so pinching the plot doesn't resize the app.
      if (e.target instanceof Element && e.target.closest('[data-wheel-zoom="own"]')) return;
      e.preventDefault();
      // Line-mode wheels (Firefox, some mice) report ~3 lines where pixel-mode reports ~100px.
      // Accumulate rather than reacting per event: a trackpad gesture fires ~10 tiny deltas, so
      // stepping on each one's sign would slam the scale to a rail in a single swipe.
      wheelAccum += e.deltaMode === 0 ? e.deltaY : e.deltaY * 16;
      const steps = Math.trunc(wheelAccum / WHEEL_PX_PER_STEP);
      if (steps === 0) return;
      wheelAccum -= steps * WHEEL_PX_PER_STEP;
      const state = useStore.getState();
      // Scrolling up is a negative deltaY and means bigger text.
      state.setFontScale(state.fontScale - steps * FONT_SCALE_STEP);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("wheel", onWheel, { passive: false, capture: true });
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("wheel", onWheel, { capture: true });
    };
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
          {/* Traces: BASED-HELP-DOCS — the help tab is the one tab that renders without a
              connection, since help matters most before you've set one up. Everything else here
              needs a session, so a plain disconnected window still gets the EmptyState. */}
          {activeConnectionId || activeTab?.kind === "docs" ? (
            <>
              <TabStrip />
              {activeTab?.kind === "query" && <QueryTabView key={activeTab.id} tab={activeTab} />}
              {activeTab?.kind === "table" && <TableDetailsView tab={activeTab} />}
              {activeTab?.kind === "routine" && <RoutineDetailsView tab={activeTab} />}
              {activeTab?.kind === "diagram" && <DiagramView tab={activeTab} />}
              {activeTab?.kind === "docs" && <DocsView />}
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
      <NewTableDialog />
    </div>
  );
}
