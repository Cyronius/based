import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import { createFontRemeasurer } from "./fontMetrics";

self.MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

// Monaco cancels in-flight work (hover, tokenization) when an editor is disposed and leaves the
// rejection unhandled; it is expected teardown, not an error.
window.addEventListener("unhandledrejection", (e) => {
  const reason = e.reason as { name?: string; message?: string } | undefined;
  if (reason?.name === "Canceled" || reason?.message === "Canceled") e.preventDefault();
});

// The "based" editor theme is defined from live CSS variables by syncMonacoTheme() (see theme.ts),
// called at startup in main.tsx and re-applied whenever the app theme changes.

// Traces: BASED-EDITOR-CARET-METRICS — one window-wide remeasurer, because remeasureFonts() is
// itself global (it refreshes every live editor). Never disposed: it lives as long as the window.
const remeasurer = createFontRemeasurer({
  fonts: document.fonts,
  remeasure: () => monaco.editor.remeasureFonts(),
});

/** Point the caret metrics at a font stack: waits for that webfont to actually load, then makes
 *  Monaco re-measure. Call it wherever an editor's fontFamily/fontSize is set. */
export function ensureEditorFont(stack: string, sizePx: number): void {
  void remeasurer.ensure(stack, sizePx);
}

export default monaco;
