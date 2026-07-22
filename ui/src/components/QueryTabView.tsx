import { useRef } from "react";
import { Panel, PanelGroup, PanelResizeHandle, type ImperativePanelHandle } from "react-resizable-panels";
import type { QueryTabState } from "../store";
import { useStore } from "../store";
import { EditorPane } from "./EditorPane";
import { ResultsPane } from "./ResultsPane";
import { OutputPane } from "./OutputPane";

export function QueryTabView({ tab }: { tab: QueryTabState }) {
  const runQuery = useStore((s) => s.runQuery);
  const cancelQuery = useStore((s) => s.cancelQuery);
  const saveTab = useStore((s) => s.saveTab);
  const status = useStore((s) => s.status);
  const outputRef = useRef<ImperativePanelHandle>(null);

  const canRun = status === "connected" && !tab.running && tab.content.trim().length > 0;

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex items-center gap-1.5 px-2 py-1 border-b border-line-soft shrink-0">
        {tab.running ? (
          <button
            className="px-2.5 py-1 text-[12px] rounded border border-err/50 text-err hover:bg-err/10"
            title="Cancel (Ctrl+Break)"
            onClick={() => void cancelQuery(tab.id)}
          >
            ■ Cancel
          </button>
        ) : (
          <button
            className="px-2.5 py-1 text-[12px] rounded border border-ok/40 text-ok hover:bg-ok/10 disabled:opacity-35 disabled:hover:bg-transparent"
            title="Run (F5 / Ctrl+Enter)"
            disabled={!canRun}
            onClick={() => void runQuery(tab.id)}
          >
            ▶ Run
          </button>
        )}
        <button
          className="px-2.5 py-1 text-[12px] rounded border border-line text-muted hover:text-paper hover:border-brass-soft/60"
          title="Save to .sql (Ctrl+S)"
          onClick={() => void saveTab(tab.id)}
        >
          Save{tab.dirty ? " •" : ""}
        </button>
        {tab.filePath && <span className="text-[11px] text-faint font-mono truncate">{tab.filePath}</span>}
        <div className="flex-1" />
        <button
          className="px-2 py-1 text-[11px] text-faint hover:text-paper"
          title="Toggle output pane"
          onClick={() => {
            const p = outputRef.current;
            if (p) p.isCollapsed() ? p.expand() : p.collapse();
          }}
        >
          Output ⇕
        </button>
      </div>

      <PanelGroup direction="vertical" className="flex-1 min-h-0" autoSaveId={`panes:${tab.id}`}>
        <Panel defaultSize={45} minSize={12}>
          <EditorPane tabId={tab.id} initialContent={tab.content} />
        </Panel>
        <PanelResizeHandle className="pane-handle" />
        <Panel defaultSize={40} minSize={10}>
          <ResultsPane tab={tab} />
        </Panel>
        <PanelResizeHandle className="pane-handle" />
        <Panel ref={outputRef} defaultSize={15} minSize={6} collapsible collapsedSize={0}>
          <OutputPane tab={tab} />
        </Panel>
      </PanelGroup>
    </div>
  );
}
