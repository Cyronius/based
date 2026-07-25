// Traces: BASED-LSP-UI
// Thin LSP JSON-RPC client over the core server's /api/lsp WebSocket — one message per text frame.
// Deliberately not monaco-languageclient: that stack requires replacing plain monaco-editor with
// the @codingame fork. We speak the handful of LSP methods the editor uses and map them onto
// Monaco's provider APIs in providers.ts. Everything here fails soft: a dead socket or a timed-out
// request yields empty results, never a broken editor.
import { apiUrl } from "../api/client";

const REQUEST_TIMEOUT_MS = 10_000;

type NotificationHandler = (params: unknown) => void;

export class LspClient {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (r: unknown) => void; reject: (e: Error) => void; timer: number }>();
  private notificationHandlers = new Map<string, NotificationHandler>();
  private disposed = false;
  /** Resolves after the initialize/initialized handshake; rejects if the socket dies first. */
  readonly ready: Promise<void>;
  /** Fires once when the socket closes for any reason (never for dispose()-initiated closes). */
  onClosed: (() => void) | null = null;

  constructor() {
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    this.ws = new WebSocket(`${scheme}://${location.host}${apiUrl("/api/lsp")}`);
    this.ready = new Promise<void>((resolve, reject) => {
      this.ws.addEventListener("open", () => {
        this.request("initialize", {
          processId: null,
          rootUri: null,
          capabilities: { general: { positionEncodings: ["utf-16"] } },
        })
          .then(() => {
            this.notify("initialized", {});
            resolve();
          })
          .catch(reject);
      });
      this.ws.addEventListener("error", () => reject(new Error("LSP socket failed")));
    });
    // Swallow unhandled-rejection noise when nobody awaits ready (e.g. instant dispose).
    this.ready.catch(() => {});
    this.ws.addEventListener("message", (e) => this.onMessage(String(e.data)));
    this.ws.addEventListener("close", () => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error("LSP socket closed"));
      }
      this.pending.clear();
      if (!this.disposed) this.onClosed?.();
    });
  }

  private onMessage(text: string): void {
    let msg: { id?: number; method?: string; result?: unknown; error?: { message: string }; params?: unknown };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.id != null && msg.method == null) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method != null && msg.id == null) {
      this.notificationHandlers.get(msg.method)?.(msg.params);
    }
    // Server→client requests are not part of our contract (config requests are answered in core).
  }

  request(method: string, params?: unknown): Promise<unknown> {
    if (this.disposed || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("LSP socket not open"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP request timed out: ${method}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.disposed || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  onNotification(method: string, handler: NotificationHandler): void {
    this.notificationHandlers.set(method, handler);
  }

  dispose(): void {
    this.disposed = true;
    try {
      this.ws.close();
    } catch {
      // already closed
    }
  }
}
