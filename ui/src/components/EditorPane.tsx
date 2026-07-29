import { useEffect, useRef } from "react";
import monaco, { ensureEditorFont } from "../monacoSetup";
import { getModel } from "../editorModels";
import { useStore } from "../store";
import { monoFont, syncMonacoTheme } from "../theme";
import { attachVim, VIM_STATUS_NODE_ID, type VimAttachment } from "../vimMode";

export function EditorPane({ tabId, initialContent }: { tabId: string; initialContent: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const themeId = useStore((s) => s.theme);
  const fontScale = useStore((s) => s.fontScale);
  const editorKeymap = useStore((s) => s.editorKeymap);

  useEffect(() => {
    const model = getModel(tabId, initialContent);
    const fontSize = 13 * useStore.getState().fontScale;
    const editor = monaco.editor.create(hostRef.current!, {
      model,
      theme: "based",
      fontFamily: monoFont(),
      fontSize,
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

    // Traces: BASED-EDITOR-CARET-METRICS — Monaco measures a fixed character width for fontFamily
    // at creation time; if the mono webfont (loaded via <link display=swap>) hasn't finished
    // downloading yet, that measurement is taken against the fallback and is never corrected once
    // the real font swaps in, so the caret drifts from the text. ensureEditorFont awaits this exact
    // font, then forces a remeasure. See monacoSetup.ts.
    ensureEditorFont(monoFont(), fontSize);

    const sub = model.onDidChangeContent(() => {
      useStore.getState().setContent(tabId, model.getValue());
    });

    editor.addCommand(monaco.KeyCode.F5, () => void useStore.getState().runQuery(tabId));
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => void useStore.getState().runQuery(tabId));
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void useStore.getState().saveTab(tabId));
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyS, () => void useStore.getState().saveTab(tabId, { as: true }));
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyO, () => void useStore.getState().openSqlFile());

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
  // Each theme carries its own mono font, and a font the page has never rendered starts
  // downloading only now — so this is the other half of BASED-EDITOR-CARET-METRICS: without the
  // ensureEditorFont call, Monaco measures the fallback and the caret drifts for the rest of the
  // session (End/Home won't fix it — the model position is fine, the painting isn't).
  useEffect(() => {
    syncMonacoTheme(monaco);
    editorRef.current?.updateOptions({ fontFamily: monoFont() });
    ensureEditorFont(monoFont(), 13 * useStore.getState().fontScale);
  }, [themeId]);

  // Font size scales with the app-wide General-tab slider.
  useEffect(() => {
    editorRef.current?.updateOptions({ fontSize: 13 * fontScale });
    ensureEditorFont(monoFont(), 13 * fontScale);
  }, [fontScale]);

  // Traces: BASED-EDITOR-VIM — deliberately separate from the creation effect: folding it in would
  // rebuild the editor on every keymap toggle and throw away the undo stack. Keyed on tabId too, so
  // the adapter re-attaches to the editor the creation effect just rebuilt. The status node belongs
  // to StatusBar (only one EditorPane is mounted at a time, so nothing else is competing for it);
  // it exists by the time effects run because both components render in the same commit.
  useEffect(() => {
    if (editorKeymap !== "vim") return;
    const editor = editorRef.current;
    const statusNode = document.getElementById(VIM_STATUS_NODE_ID);
    if (!editor || !statusNode) return;
    let attachment: VimAttachment | null = null;
    let cancelled = false;
    void attachVim(editor, statusNode).then((a) => {
      // StrictMode double-invokes this effect; without the guard two adapters end up on one editor
      // and every keystroke lands twice.
      if (cancelled) a.dispose();
      else attachment = a;
    });
    return () => {
      cancelled = true;
      attachment?.dispose();
    };
  }, [editorKeymap, tabId]);

  return <div ref={hostRef} className="h-full w-full" />;
}
