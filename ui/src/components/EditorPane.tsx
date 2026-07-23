import { useEffect, useRef } from "react";
import monaco from "../monacoSetup";
import { getModel } from "../editorModels";
import { useStore } from "../store";
import { monoFont, syncMonacoTheme } from "../theme";

export function EditorPane({ tabId, initialContent }: { tabId: string; initialContent: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const themeId = useStore((s) => s.theme);
  const fontScale = useStore((s) => s.fontScale);

  useEffect(() => {
    const model = getModel(tabId, initialContent);
    const editor = monaco.editor.create(hostRef.current!, {
      model,
      theme: "based",
      fontFamily: monoFont(),
      fontSize: 13 * useStore.getState().fontScale,
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

    // Monaco measures a fixed character width for fontFamily at creation time; if the mono
    // webfont (loaded via <link display=swap>) hasn't finished loading yet, that measurement
    // is taken against the fallback font and never corrected, so the caret drifts from the
    // text once the real font swaps in. Force a remeasure once fonts are actually ready.
    document.fonts.ready.then(() => {
      monaco.editor.remeasureFonts();
    });

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

  // Re-theme the editor (colors + mono font) when the app theme changes. Monaco themes are global,
  // so one setTheme covers every editor; the font is per-instance and updated here.
  useEffect(() => {
    syncMonacoTheme(monaco);
    editorRef.current?.updateOptions({ fontFamily: monoFont() });
  }, [themeId]);

  // Font size scales with the app-wide General-tab slider.
  useEffect(() => {
    editorRef.current?.updateOptions({ fontSize: 13 * fontScale });
  }, [fontScale]);

  return <div ref={hostRef} className="h-full w-full" />;
}
