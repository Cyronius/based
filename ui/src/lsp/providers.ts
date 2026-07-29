// Traces: BASED-LSP-UI
// Monaco language providers for "sql", forwarding to whatever LSP backend the manager currently
// holds (the server picked it by engine). Registered ONCE at app boot. With no live client the
// providers return empty results, leaving Monaco's built-in word-based suggestions — exactly the
// pre-LSP behavior.
import * as monaco from "monaco-editor";
import { flushDocument, getLspClient, uriForTab } from "./manager";
import { allModels } from "../editorModels";

interface LspRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
}
interface LspCompletionItem {
  label: string;
  kind?: number;
  detail?: string;
  documentation?: string | { value: string };
  insertText?: string;
  sortText?: string;
  textEdit?: { range: LspRange; newText: string };
}

/** LSP CompletionItemKind → Monaco. Anything unmapped falls back to Text. */
function toMonacoKind(kind: number | undefined): monaco.languages.CompletionItemKind {
  const K = monaco.languages.CompletionItemKind;
  switch (kind) {
    case 2:
      return K.Method;
    case 3:
      return K.Function;
    case 5:
      return K.Field;
    case 6:
      return K.Variable;
    case 7:
      return K.Class;
    case 9:
      return K.Module;
    case 10:
      return K.Property;
    case 14:
      return K.Keyword;
    case 15:
      return K.Snippet;
    default:
      return K.Text;
  }
}

function toMonacoRange(r: LspRange): monaco.IRange {
  return {
    startLineNumber: r.start.line + 1,
    startColumn: r.start.character + 1,
    endLineNumber: r.end.line + 1,
    endColumn: r.end.character + 1,
  };
}

/** The LSP document uri for a Monaco model, or null if this model isn't a synced query tab. */
function uriOf(model: monaco.editor.ITextModel): string | null {
  for (const [tabId, m] of allModels()) {
    if (m === model) return uriForTab(tabId);
  }
  return null;
}

export function registerLspProviders(): void {
  monaco.languages.registerCompletionItemProvider("sql", {
    triggerCharacters: [".", '"', " "],
    async provideCompletionItems(model, position) {
      const client = getLspClient();
      const uri = uriOf(model);
      if (!client || !uri) return { suggestions: [] };
      try {
        await client.ready;
        // The manager debounces didChange 250ms; completion fires immediately on trigger chars.
        // Without a flush the server classifies against the pre-keystroke document (e.g. sees
        // `FROM alm` when the user typed `FROM alm.`) and returns schema-qualified inserts.
        flushDocument(uri);
        const result = (await client.request("textDocument/completion", {
          textDocument: { uri },
          position: { line: position.lineNumber - 1, character: position.column - 1 },
        })) as { items?: LspCompletionItem[] } | LspCompletionItem[] | null;
        const items = Array.isArray(result) ? result : (result?.items ?? []);
        const word = model.getWordUntilPosition(position);
        const defaultRange: monaco.IRange = {
          startLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endLineNumber: position.lineNumber,
          endColumn: position.column,
        };
        return {
          suggestions: items.map((item) => ({
            label: item.label,
            kind: toMonacoKind(item.kind),
            detail: item.detail,
            documentation: typeof item.documentation === "string" ? item.documentation : item.documentation,
            insertText: item.textEdit?.newText ?? item.insertText ?? item.label,
            sortText: item.sortText,
            range: item.textEdit ? toMonacoRange(item.textEdit.range) : defaultRange,
          })),
        };
      } catch {
        return { suggestions: [] };
      }
    },
  });

  monaco.languages.registerHoverProvider("sql", {
    async provideHover(model, position) {
      const client = getLspClient();
      const uri = uriOf(model);
      if (!client || !uri) return null;
      try {
        await client.ready;
        flushDocument(uri);
        const hover = (await client.request("textDocument/hover", {
          textDocument: { uri },
          position: { line: position.lineNumber - 1, character: position.column - 1 },
        })) as { contents: string | { value: string } | Array<string | { value: string }>; range?: LspRange } | null;
        if (!hover) return null;
        const parts = Array.isArray(hover.contents) ? hover.contents : [hover.contents];
        const contents = parts.map((p) => ({ value: typeof p === "string" ? p : p.value }));
        return { contents, range: hover.range ? toMonacoRange(hover.range) : undefined };
      } catch {
        return null;
      }
    },
  });
}
