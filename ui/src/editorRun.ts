// Traces: BASED-RUN-SCOPE
// Decides what text a run sends: the selection when there is one, else the whole buffer (F5 /
// toolbar Run) or the statement at the cursor (Ctrl+Enter). Editors register here so the global
// key handler and the toolbar can read the selection of an editor that does not have focus.
import type * as monaco from "monaco-editor";
import { useStore } from "./store";
import { statementAt } from "./lib/sqlText";

const editors = new Map<string, monaco.editor.IStandaloneCodeEditor>();

export function registerEditor(tabId: string, editor: monaco.editor.IStandaloneCodeEditor): () => void {
  editors.set(tabId, editor);
  return () => {
    if (editors.get(tabId) === editor) editors.delete(tabId);
  };
}

const FLASH_MS = 700;

function flash(editor: monaco.editor.IStandaloneCodeEditor, range: monaco.IRange): void {
  const deco = editor.createDecorationsCollection([{ range, options: { className: "run-flash", isWholeLine: false } }]);
  setTimeout(() => deco.clear(), FLASH_MS);
}

export function runFromEditor(tabId: string, scope: "all" | "statement"): void {
  const store = useStore.getState();
  const editor = editors.get(tabId);
  const model = editor?.getModel();
  if (!editor || !model) {
    void store.runQuery(tabId);
    return;
  }
  const selection = editor.getSelection();
  if (selection && !selection.isEmpty()) {
    const sql = model.getValueInRange(selection);
    if (!sql.trim()) return;
    flash(editor, selection);
    void store.runQuery(tabId, { sql, startLine: selection.startLineNumber });
    return;
  }
  if (scope === "statement") {
    const text = model.getValue();
    const position = editor.getPosition();
    const span = position ? statementAt(text, model.getOffsetAt(position)) : null;
    if (span && text.slice(span.start, span.end).trim() !== text.trim()) {
      const start = model.getPositionAt(span.start);
      const end = model.getPositionAt(span.end);
      flash(editor, { startLineNumber: start.lineNumber, startColumn: start.column, endLineNumber: end.lineNumber, endColumn: end.column });
      void store.runQuery(tabId, { sql: text.slice(span.start, span.end), startLine: start.lineNumber });
      return;
    }
  }
  void store.runQuery(tabId);
}
