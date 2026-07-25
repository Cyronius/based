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

export function disposeModel(tabId: string): void {
  const model = models.get(tabId);
  models.delete(tabId);
  if (model && !model.isDisposed()) model.dispose();
  for (const cb of disposedListeners) cb(tabId);
}
