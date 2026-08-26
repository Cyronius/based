import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle, type ImperativePanelGroupHandle, type ImperativePanelHandle } from "react-resizable-panels";
import type { QueryTabState } from "../store";
import { useStore } from "../store";
import { EditorPane } from "./EditorPane";
import { ResultsPane } from "./ResultsPane";
import { OutputPane } from "./OutputPane";
import { BottomTabPanel, type BottomTab } from "./BottomTabPanel";
import { CellView } from "./CellView";
import { ChevronUpIcon } from "./icons";

type BottomTabId = "output" | "cell";

export function QueryTabView({ tab }: { tab: QueryTabState }) {
  const runQuery = useStore((s) => s.runQuery);
  const cancelQuery = useStore((s) => s.cancelQuery);
  const saveTab = useStore((s) => s.saveTab);
  const openSqlFile = useStore((s) => s.openSqlFile);
  const status = useStore((s) => s.status);
  const outputRef = useRef<ImperativePanelHandle>(null);
  const resultsRef = useRef<ImperativePanelHandle>(null);
  const groupRef = useRef<ImperativePanelGroupHandle>(null);
  const [resultsMin, setResultsMin] = useState(false);
  const [bottomMin, setBottomMin] = useState(false);

  const [openTabs, setOpenTabs] = useState<Set<BottomTabId>>(() => new Set(["output"]));
  const [activeBottomTab, setActiveBottomTab] = useState<BottomTabId>("output");
  const [cellText, setCellText] = useState<string | null>(null);

  // autoSaveId can restore a collapsed (0-size) layout on remount without firing onCollapse — sync
  // the restore-bar state from the real panel state once.
  useLayoutEffect(() => {
    setResultsMin(resultsRef.current?.isCollapsed() ?? false);
    setBottomMin(outputRef.current?.isCollapsed() ?? false);
  }, []);

  // Panel.collapse()/expand() redistribute the freed space among siblings, which can silently
  // re-expand the other collapsed panel — set the whole layout explicitly instead.
  const setSizes = (results: number | null, bottom: number | null) => {
    const layout = groupRef.current?.getLayout();
    if (!layout || layout.length !== 3) return;
    const r = results ?? layout[1]!;
    const b = bottom ?? layout[2]!;
    groupRef.current!.setLayout([100 - r - b, r, b]);
  };
  const collapseResults = () => setSizes(0, null);
  const expandResults = () => setSizes(30, null);
  const collapseBottom = () => setSizes(null, 0);
  const expandBottom = () => setSizes(null, 15);

  // Running a query with results minimized is almost never intended — restore them.
  useEffect(() => {
    if (tab.running) expandResults();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.running]);

  const toggleOutput = () => {
    if (openTabs.has("output")) {
      closeBottomTab("output");
      return;
    }
    setOpenTabs(new Set(openTabs).add("output"));
    setActiveBottomTab("output");
    expandBottom();
  };

  const openCellTab = (text: string) => {
    setCellText(text);
    if (!openTabs.has("cell")) setOpenTabs(new Set(openTabs).add("cell"));
    setActiveBottomTab("cell");
    expandBottom();
  };

  const closeBottomTab = (id: BottomTabId) => {
    const next = new Set(openTabs);
    next.delete(id);
    setOpenTabs(next);
    if (next.size === 0) {
      collapseBottom();
    } else if (activeBottomTab === id) {
      setActiveBottomTab([...next][0]!);
    }
  };

  const bottomTabs: BottomTab[] = [];
  if (openTabs.has("output")) bottomTabs.push({ id: "output", label: "Output", content: <OutputPane tab={tab} /> });
  if (openTabs.has("cell")) bottomTabs.push({ id: "cell", label: "Cell", content: <CellView text={cellText} /> });

  const canRun = status === "connected" && !tab.running && tab.content.trim().length > 0;

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex items-center gap-1.5 px-2 py-1 border-b border-line-soft shrink-0">
        {tab.running ? (
          <button
            className="px-2.5 py-1 text-[length:var(--fs-base)] rounded border border-err/50 text-err hover:bg-err/10"
            title="Cancel (Ctrl+Break)"
            onClick={() => void cancelQuery(tab.id)}
          >
            ■ Cancel
          </button>
        ) : (
          <button
            className="px-2.5 py-1 text-[length:var(--fs-base)] rounded border border-ok/40 text-ok hover:bg-ok/10 disabled:opacity-35 disabled:hover:bg-transparent"
            title="Run (F5 / Ctrl+Enter)"
            disabled={!canRun}
            onClick={() => void runQuery(tab.id)}
          >
            ▶ Run
          </button>
        )}
        <button
          className="px-2.5 py-1 text-[length:var(--fs-base)] rounded border border-line text-muted hover:text-paper hover:border-brass-soft/60"
          title="Open a .sql file (Ctrl+O)"
          onClick={() => void openSqlFile()}
        >
          Open…
        </button>
        <button
          className="px-2.5 py-1 text-[length:var(--fs-base)] rounded border border-line text-muted hover:text-paper hover:border-brass-soft/60"
          title="Save to .sql (Ctrl+S)"
          onClick={() => void saveTab(tab.id)}
        >
          Save{tab.dirty ? " •" : ""}
        </button>
        <button
          className="px-2.5 py-1 text-[length:var(--fs-base)] rounded border border-line text-muted hover:text-paper hover:border-brass-soft/60"
          title="Save to a new .sql file (Ctrl+Shift+S)"
          onClick={() => void saveTab(tab.id, { as: true })}
        >
          Save As…
        </button>
        {tab.filePath && <span className="text-[length:var(--fs-sm)] text-faint font-mono truncate">{tab.filePath}</span>}
        <div className="flex-1" />
        <label className="flex items-center gap-1.5 text-[length:var(--fs-sm)] text-faint hover:text-paper cursor-pointer">
          <input type="checkbox" checked={openTabs.has("output")} onChange={toggleOutput} />
          Output
        </label>
      </div>

      <PanelGroup ref={groupRef} direction="vertical" className="flex-1 min-h-0" autoSaveId={`panes:${tab.id}`}>
        <Panel defaultSize={45} minSize={12}>
          <EditorPane tabId={tab.id} initialContent={tab.content} />
        </Panel>
        <PanelResizeHandle className="pane-handle" />
        <Panel
          ref={resultsRef}
          defaultSize={40}
          minSize={10}
          collapsible
          collapsedSize={0}
          onCollapse={() => setResultsMin(true)}
          onExpand={() => setResultsMin(false)}
        >
          <ResultsPane tab={tab} onCellTextChange={setCellText} onCellActivate={openCellTab} onMinimize={collapseResults} />
        </Panel>
        <PanelResizeHandle className="pane-handle" />
        <Panel
          ref={outputRef}
          defaultSize={15}
          minSize={6}
          collapsible
          collapsedSize={0}
          onCollapse={() => setBottomMin(true)}
          onExpand={() => setBottomMin(false)}
        >
          <BottomTabPanel
            tabs={bottomTabs}
            activeId={activeBottomTab}
            onActivate={(id) => setActiveBottomTab(id as BottomTabId)}
            onClose={(id) => closeBottomTab(id as BottomTabId)}
            onMinimize={collapseBottom}
          />
        </Panel>
      </PanelGroup>

      {(resultsMin || (bottomMin && bottomTabs.length > 0)) && (
        <div className="h-6 shrink-0 flex items-stretch border-t border-line-soft bg-ink-950">
          {resultsMin && (
            <button
              className="flex items-center gap-1.5 px-2.5 border-r border-line-soft text-[length:var(--fs-sm)] text-muted hover:text-paper hover:bg-ink-900/50"
              title="Restore results"
              onClick={expandResults}
            >
              Results <ChevronUpIcon />
            </button>
          )}
          {bottomMin && bottomTabs.length > 0 && (
            <button
              className="flex items-center gap-1.5 px-2.5 border-r border-line-soft text-[length:var(--fs-sm)] text-muted hover:text-paper hover:bg-ink-900/50"
              title="Restore output panel"
              onClick={expandBottom}
            >
              {bottomTabs.map((t) => t.label).join(" · ")} <ChevronUpIcon />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
