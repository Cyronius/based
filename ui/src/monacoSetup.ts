import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";

self.MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

// The "based" editor theme is defined from live CSS variables by syncMonacoTheme() (see theme.ts),
// called at startup in main.tsx and re-applied whenever the app theme changes.

export default monaco;
