// Monaco model cache keyed by tab id — survives tab switches so undo stacks and view state persist.
import * as monaco from "monaco-editor";

const models = new Map<string, monaco.editor.ITextModel>();

export function getModel(tabId: string, initialContent: string): monaco.editor.ITextModel {
  let model = models.get(tabId);
  if (!model || model.isDisposed()) {
    model = monaco.editor.createModel(initialContent, "sql");
    models.set(tabId, model);
  }
  return model;
}

export function disposeModel(tabId: string): void {
  const model = models.get(tabId);
  models.delete(tabId);
  if (model && !model.isDisposed()) model.dispose();
}
