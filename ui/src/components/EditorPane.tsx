import { useEffect, useRef } from "react";
import monaco from "../monacoSetup";
import { getModel } from "../editorModels";
import { useStore } from "../store";

export function EditorPane({ tabId, initialContent }: { tabId: string; initialContent: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);

  useEffect(() => {
    const model = getModel(tabId, initialContent);
    const editor = monaco.editor.create(hostRef.current!, {
      model,
      theme: "ledger",
      fontFamily: "IBM Plex Mono",
      fontSize: 13,
      lineHeight: 21,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      automaticLayout: true,
      renderLineHighlight: "gutter",
      padding: { top: 10 },
      stickyScroll: { enabled: false },
      overviewRulerLanes: 0,
      wordWrap: "off",
      tabSize: 4,
    });
    editorRef.current = editor;

    const sub = model.onDidChangeContent(() => {
      useStore.getState().setContent(tabId, model.getValue());
    });

    editor.addCommand(monaco.KeyCode.F5, () => void useStore.getState().runQuery(tabId));
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => void useStore.getState().runQuery(tabId));
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void useStore.getState().saveTab(tabId));

    editor.focus();
    return () => {
      sub.dispose();
      editor.dispose(); // model survives in the cache
      editorRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId]);

  return <div ref={hostRef} className="h-full w-full" />;
}
