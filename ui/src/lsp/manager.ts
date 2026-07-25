// Traces: BASED-LSP-UI
// Owns the window's single LSP connection: opens it when the session is connected to an engine
// with SQL capability, replaces it when the connection changes, and mirrors every query-tab Monaco
// model into the server as an LSP document (didOpen/didChange/didClose, full-text sync, debounced).
// All tabs are synced, not just the active one — tabs are small, and it means completions are warm
// the moment the user switches tabs. Reconnects with backoff while the store still says the session
// should have LSP; goes quiet otherwise. The editor never depends on any of this working.
import * as monaco from "monaco-editor";
import { useStore } from "../store";
import { allModels, onModelCreated, onModelDisposed } from "../editorModels";
import { LspClient } from "./client";

const DEBOUNCE_MS = 250;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 16_000;

interface DocState {
  uri: string;
  version: number;
  debounce: number | null;
}

let client: LspClient | null = null;
let clientForConnection: string | null = null;
let backoffMs = BACKOFF_BASE_MS;
let reconnectTimer: number | null = null;
const docs = new Map<string, DocState>(); // tabId → doc state
const modelByUri = new Map<string, monaco.editor.ITextModel>();

export function getLspClient(): LspClient | null {
  return client;
}

export function uriForTab(tabId: string): string {
  return `based:///${encodeURIComponent(tabId)}.sql`;
}

function wantLsp(): { want: boolean; connectionId: string | null } {
  const s = useStore.getState();
  return {
    want: s.status === "connected" && (s.capabilities?.sql ?? false),
    connectionId: s.activeConnectionId,
  };
}

function openDocument(tabId: string, model: monaco.editor.ITextModel): void {
  if (!client) return;
  let doc = docs.get(tabId);
  if (!doc) {
    doc = { uri: uriForTab(tabId), version: 1, debounce: null };
    docs.set(tabId, doc);
  }
  modelByUri.set(doc.uri, model);
  client.notify("textDocument/didOpen", {
    textDocument: { uri: doc.uri, languageId: "sql", version: doc.version, text: model.getValue() },
  });
}

function changeDocument(tabId: string, model: monaco.editor.ITextModel): void {
  const doc = docs.get(tabId);
  if (!doc || !client) return;
  if (doc.debounce != null) clearTimeout(doc.debounce);
  doc.debounce = window.setTimeout(() => {
    doc.debounce = null;
    if (!client || model.isDisposed()) return;
    doc.version++;
    client.notify("textDocument/didChange", {
      textDocument: { uri: doc.uri, version: doc.version },
      contentChanges: [{ text: model.getValue() }],
    });
  }, DEBOUNCE_MS);
}

function closeDocument(tabId: string): void {
  const doc = docs.get(tabId);
  if (!doc) return;
  if (doc.debounce != null) clearTimeout(doc.debounce);
  docs.delete(tabId);
  modelByUri.delete(doc.uri);
  client?.notify("textDocument/didClose", { textDocument: { uri: doc.uri } });
}

function clearAllMarkers(): void {
  for (const model of modelByUri.values()) {
    if (!model.isDisposed()) monaco.editor.setModelMarkers(model, "lsp", []);
  }
}

function disposeClient(): void {
  if (reconnectTimer != null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (!client) return;
  client.dispose();
  client = null;
  clientForConnection = null;
  docs.clear();
  clearAllMarkers();
  modelByUri.clear();
}

function connectClient(connectionId: string | null): void {
  disposeClient();
  const c = new LspClient();
  client = c;
  clientForConnection = connectionId;
  c.onNotification("textDocument/publishDiagnostics", (params) => {
    const p = params as { uri: string; diagnostics: LspDiagnostic[] };
    const model = modelByUri.get(p.uri);
    if (!model || model.isDisposed()) return;
    monaco.editor.setModelMarkers(model, "lsp", p.diagnostics.map(toMarker));
  });
  c.onClosed = () => {
    if (client !== c) return;
    client = null;
    docs.clear();
    modelByUri.clear();
    scheduleReconnect();
  };
  c.ready
    .then(() => {
      if (client !== c) return;
      backoffMs = BACKOFF_BASE_MS;
      for (const [tabId, model] of allModels()) {
        openDocument(tabId, model);
        hookModel(tabId, model);
      }
    })
    .catch(() => {
      // onClosed handles the retry.
    });
}

function scheduleReconnect(): void {
  if (reconnectTimer != null) return;
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    const { want, connectionId } = wantLsp();
    if (want && !client) connectClient(connectionId);
  }, backoffMs);
  backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
}

const hookedModels = new WeakSet<monaco.editor.ITextModel>();
function hookModel(tabId: string, model: monaco.editor.ITextModel): void {
  if (hookedModels.has(model)) return;
  hookedModels.add(model);
  model.onDidChangeContent(() => changeDocument(tabId, model));
}

/** Call once at app boot (main.tsx). */
export function initLsp(): void {
  onModelCreated((tabId, model) => {
    hookModel(tabId, model);
    if (client) openDocument(tabId, model);
  });
  onModelDisposed((tabId) => closeDocument(tabId));

  let prev = { want: false, connectionId: null as string | null };
  useStore.subscribe((state) => {
    const next = {
      want: state.status === "connected" && (state.capabilities?.sql ?? false),
      connectionId: state.activeConnectionId,
    };
    if (next.want === prev.want && next.connectionId === prev.connectionId) return;
    prev = next;
    if (!next.want) {
      disposeClient();
      backoffMs = BACKOFF_BASE_MS;
    } else if (!client || clientForConnection !== next.connectionId) {
      backoffMs = BACKOFF_BASE_MS;
      connectClient(next.connectionId);
    }
  });
}

interface LspDiagnostic {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  severity?: number;
  message: string;
  source?: string;
}

function toMarker(d: LspDiagnostic): monaco.editor.IMarkerData {
  const severity =
    d.severity === 1
      ? monaco.MarkerSeverity.Error
      : d.severity === 2
        ? monaco.MarkerSeverity.Warning
        : d.severity === 3
          ? monaco.MarkerSeverity.Info
          : monaco.MarkerSeverity.Hint;
  return {
    severity,
    message: d.message,
    source: d.source,
    startLineNumber: d.range.start.line + 1,
    startColumn: d.range.start.character + 1,
    endLineNumber: d.range.end.line + 1,
    endColumn: d.range.end.character + 1,
  };
}
