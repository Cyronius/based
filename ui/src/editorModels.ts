// Monaco model cache keyed by tab id — survives tab switches so undo stacks and view state persist.
// The LSP manager hooks the lifecycle listeners to mirror every query model into the language
// server as an LSP document (BASED-LSP-UI); editorModels itself stays store- and LSP-agnostic.
import * as monaco from "monaco-editor";

const models = new Map<string, monaco.editor.ITextModel>();

type ModelListener = (tabId: string, model: monaco.editor.ITextModel) => void;
const createdListeners = new Set<ModelListener>();
const disposedListeners = new Set<(tabId: string) => void>();

export function onModelCreated(cb: ModelListener): void {
  createdListeners.add(cb);
}

export function onModelDisposed(cb: (tabId: string) => void): void {
  disposedListeners.add(cb);
}

export function allModels(): Array<[string, monaco.editor.ITextModel]> {
  return [...models.entries()].filter(([, m]) => !m.isDisposed());
}

export function getModel(tabId: string, initialContent: string): monaco.editor.ITextModel {
  let model = models.get(tabId);
  if (!model || model.isDisposed()) {
    model = monaco.editor.createModel(initialContent, "sql");
    models.set(tabId, model);
    for (const cb of createdListeners) cb(tabId, model);
  }
  return model;
}

/** Traces: BASED-UI-QUERY-ERROR — error squiggles from the last run; an empty list clears them. */
export function setRunMarkers(tabId: string, errors: Array<{ line: number; message: string }>): void {
  const model = models.get(tabId);
  if (!model || model.isDisposed()) return;
  monaco.editor.setModelMarkers(
    model,
    "based-run",
    errors
      .filter((e) => e.line >= 1 && e.line <= model.getLineCount())
      .map((e) => ({
        severity: monaco.MarkerSeverity.Error,
        message: e.message,
        startLineNumber: e.line,
        startColumn: model.getLineFirstNonWhitespaceColumn(e.line) || 1,
        endLineNumber: e.line,
        endColumn: model.getLineMaxColumn(e.line),
      })),
  );
}

export function disposeModel(tabId: string): void {
  const model = models.get(tabId);
  models.delete(tabId);
  if (model && !model.isDisposed()) model.dispose();
  for (const cb of disposedListeners) cb(tabId);
}

/** Puts the cursor on a reported error line in whichever editor shows this tab. */
export function revealLine(tabId: string, line: number): void {
  const model = models.get(tabId);
  const editor = model && monaco.editor.getEditors().find((e) => e.getModel() === model);
  if (!editor || !model || line < 1 || line > model.getLineCount()) return;
  editor.setPosition({ lineNumber: line, column: model.getLineFirstNonWhitespaceColumn(line) || 1 });
  editor.revealLineInCenterIfOutsideViewport(line);
  editor.focus();
}
