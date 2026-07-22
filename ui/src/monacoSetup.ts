import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";

self.MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

monaco.editor.defineTheme("ledger", {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "keyword.sql", foreground: "d2a24c" },
    { token: "keyword", foreground: "d2a24c" },
    { token: "string.sql", foreground: "9dbb8a" },
    { token: "string", foreground: "9dbb8a" },
    { token: "number", foreground: "c9a3d0" },
    { token: "comment", foreground: "5a606a", fontStyle: "italic" },
    { token: "operator.sql", foreground: "c9c6bd" },
    { token: "predefined.sql", foreground: "7fa8c9" },
  ],
  colors: {
    "editor.background": "#15181d",
    "editor.foreground": "#e9e6de",
    "editor.lineHighlightBackground": "#1a1e24",
    "editorLineNumber.foreground": "#454b55",
    "editorLineNumber.activeForeground": "#8d929c",
    "editorCursor.foreground": "#d2a24c",
    "editor.selectionBackground": "#2c3a4d",
    "editorIndentGuide.background1": "#20252c",
    "editorWidget.background": "#1a1e24",
    "editorWidget.border": "#272d36",
    "input.background": "#101216",
    "scrollbarSlider.background": "#2c333d80",
    "scrollbarSlider.hoverBackground": "#3a424e",
  },
});

export default monaco;
