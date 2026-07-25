import { useRef, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle, type ImperativePanelHandle } from "react-resizable-panels";
import type { QueryTabState } from "../store";
import { useStore } from "../store";
import { EditorPane } from "./EditorPane";
import { ResultsPane } from "./ResultsPane";
import { OutputPane } from "./OutputPane";
import { BottomTabPanel, type BottomTab } from "./BottomTabPanel";
import { CellView } from "./CellView";

type BottomTabId = "output" | "cell";

export function QueryTabView({ tab }: { tab: QueryTabState }) {
  const runQuery = useStore((s) => s.runQuery);
  const cancelQuery = useStore((s) => s.cancelQuery);
  const saveTab = useStore((s) => s.saveTab);
  const status = useStore((s) => s.status);
  const outputRef = useRef<ImperativePanelHandle>(null);

  const [openTabs, setOpenTabs] = useState<Set<BottomTabId>>(() => new Set(["output"]));
  const [activeBottomTab, setActiveBottomTab] = useState<BottomTabId>("output");
  const [cellText, setCellText] = useState<string | null>(null);

  const toggleOutput = () => {
    if (openTabs.has("output")) {
      closeBottomTab("output");
      return;
    }
    setOpenTabs(new Set(openTabs).add("output"));
    setActiveBottomTab("output");
    outputRef.current?.expand();
  };

  const openCellTab = (text: string) => {
    setCellText(text);
    if (!openTabs.has("cell")) setOpenTabs(new Set(openTabs).add("cell"));
    setActiveBottomTab("cell");
    outputRef.current?.expand();
  };

  const closeBottomTab = (id: BottomTabId) => {
    const next = new Set(openTabs);
    next.delete(id);
    setOpenTabs(next);
    if (next.size === 0) {
      outputRef.current?.collapse();
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
          title="Save to .sql (Ctrl+S)"
          onClick={() => void saveTab(tab.id)}
        >
          Save{tab.dirty ? " •" : ""}
        </button>
        {tab.filePath && <span className="text-[length:var(--fs-sm)] text-faint font-mono truncate">{tab.filePath}</span>}
        <div className="flex-1" />
        <label className="flex items-center gap-1.5 text-[length:var(--fs-sm)] text-faint hover:text-paper cursor-pointer">
          <input type="checkbox" checked={openTabs.has("output")} onChange={toggleOutput} />
          Output
        </label>
      </div>

      <PanelGroup direction="vertical" className="flex-1 min-h-0" autoSaveId={`panes:${tab.id}`}>
        <Panel defaultSize={45} minSize={12}>
          <EditorPane tabId={tab.id} initialContent={tab.content} />
        </Panel>
        <PanelResizeHandle className="pane-handle" />
        <Panel defaultSize={40} minSize={10}>
          <ResultsPane tab={tab} onCellTextChange={setCellText} onCellActivate={openCellTab} />
        </Panel>
        <PanelResizeHandle className="pane-handle" />
        <Panel ref={outputRef} defaultSize={15} minSize={6} collapsible collapsedSize={0}>
          <BottomTabPanel tabs={bottomTabs} activeId={activeBottomTab} onActivate={(id) => setActiveBottomTab(id as BottomTabId)} onClose={(id) => closeBottomTab(id as BottomTabId)} />
        </Panel>
      </PanelGroup>
    </div>
  );
}
