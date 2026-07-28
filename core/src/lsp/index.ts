// Traces: BASED-LSP-TRANSPORT
// One WebSocket per window session carries LSP JSON-RPC (one message per text frame). The backend
// comes from the session engine's descriptor at upgrade time (BASED-ENGINE-REGISTRY), which is also
// where the dynamic import lives, so the LSP layer adds nothing to cold start (BASED-LAZY-ENGINES
// posture). Everything degrades: refusing the upgrade, an engine with no language server, or a dead
// backend all leave the editor fully functional with Monaco's built-ins.
import type { ServerWebSocket } from "bun";
import type { ConnectionConfig, DatabaseAdapter } from "../db/types";
import { descriptorForConfig } from "../engines/registry";
import type { LspBackend } from "../engines/descriptor";
import type { JsonRpcMessage } from "./protocol";

interface WsData {
  sid: string;
}

export interface LspSubsystemDeps {
  getSession(sid: string): { adapter: DatabaseAdapter | null; connectionId: string | null; database: string | null };
  getConnection(id: string): ConnectionConfig | undefined;
}

/** The only bit of Bun's Server we need — avoids coupling to its generic signature. */
interface Upgrader {
  upgrade(req: Request, opts: { data: WsData }): boolean;
}

export interface LspSubsystem {
  /** Try to upgrade the request. Returns null on success (Bun sends the 101 itself) or an error
   *  Response describing why the session can't have an LSP backend. */
  handleUpgrade(req: Request, server: Upgrader, sid: string): Response | null;
  websocket: {
    open(ws: ServerWebSocket<WsData>): void;
    message(ws: ServerWebSocket<WsData>, message: string | Uint8Array): void;
    close(ws: ServerWebSocket<WsData>): void;
  };
  closeForSession(sid: string): void;
  /** Dispose every backend and, if any socket was ever upgraded, wait for Bun's websocket teardown
   *  to settle — calling Bun's server.stop(force) while a ws close is still in flight hangs it
   *  (observed on Windows, Bun 1.3.14). Await this before server.stop(). */
  stopAll(): Promise<void>;
}

export function createLspSubsystem(deps: LspSubsystemDeps): LspSubsystem {
  // One live LSP connection per sid — a new socket for the same sid replaces the old backend.
  const active = new Map<string, { ws: ServerWebSocket<WsData>; backend: LazyBackend }>();
  let everUpgraded = false;

  /** Wraps the async backend construction so messages arriving before it resolves are queued. */
  class LazyBackend implements LspBackend {
    private backend: LspBackend | null = null;
    private queue: string[] = [];
    private disposed = false;

    constructor(factory: () => Promise<LspBackend>) {
      factory()
        .then((b) => {
          if (this.disposed) {
            b.dispose();
            return;
          }
          this.backend = b;
          for (const text of this.queue.splice(0)) b.onClientMessage(text);
        })
        .catch(() => {
          this.queue = [];
        });
    }

    onClientMessage(text: string): void {
      if (this.disposed) return;
      if (this.backend) this.backend.onClientMessage(text);
      else this.queue.push(text);
    }

    dispose(): void {
      this.disposed = true;
      this.backend?.dispose();
      this.backend = null;
      this.queue = [];
    }
  }

  function backendFactory(sid: string, ws: ServerWebSocket<WsData>): (() => Promise<LspBackend>) | { error: string } {
    const session = deps.getSession(sid);
    const adapter = session.adapter;
    if (!adapter || !session.connectionId) return { error: "Session is not connected" };
    if (!adapter.capabilities.sql) return { error: "This engine has no SQL surface" };
    const cfg = deps.getConnection(session.connectionId);
    if (!cfg) return { error: "Unknown connection" };
    const send = (message: JsonRpcMessage) => {
      try {
        ws.send(JSON.stringify(message));
      } catch {
        // socket already closed
      }
    };

    // The engine descriptor owns which server to build and the structural cast it needs to reach
    // its adapter's catalog methods. The previous shape here was `lancedb ? DuckDB : MSSQL`, so a
    // third SQL engine would silently have been handed T-SQL completion.
    const loadLsp = descriptorForConfig(cfg).loadLsp;
    if (!loadLsp) return { error: "This engine has no language server" };
    return () => loadLsp(adapter, send as (message: unknown) => void) as Promise<LspBackend>;
  }

  return {
    handleUpgrade(req, server, sid) {
      const session = deps.getSession(sid);
      if (!session.adapter || !session.connectionId) {
        return new Response(JSON.stringify({ error: "Session is not connected" }), { status: 409 });
      }
      if (!session.adapter.capabilities.sql) {
        return new Response(JSON.stringify({ error: "This engine has no SQL surface" }), { status: 409 });
      }
      const ok = server.upgrade(req, { data: { sid } satisfies WsData });
      if (ok) everUpgraded = true;
      return ok ? null : new Response(JSON.stringify({ error: "WebSocket upgrade failed" }), { status: 400 });
    },

    websocket: {
      open(ws) {
        const sid = ws.data.sid;
        active.get(sid)?.backend.dispose();
        const factory = backendFactory(sid, ws);
        if ("error" in factory) {
          ws.close(1011, factory.error);
          return;
        }
        active.set(sid, { ws, backend: new LazyBackend(factory) });
      },
      message(ws, message) {
        if (typeof message !== "string") return; // text frames only, per the transport contract
        active.get(ws.data.sid)?.backend.onClientMessage(message);
      },
      close(ws) {
        const entry = active.get(ws.data.sid);
        if (entry && entry.ws === ws) {
          entry.backend.dispose();
          active.delete(ws.data.sid);
        }
      },
    },

    closeForSession(sid) {
      const entry = active.get(sid);
      if (!entry) return;
      entry.backend.dispose();
      try {
        // terminate(), not close(): a server-initiated graceful close leaves the socket in a state
        // that wedges Bun's server.stop(force) forever (observed on Windows, Bun 1.3.14). The
        // client treats any close as "reconnect when capabilities allow", so abrupt is fine.
        entry.ws.terminate();
      } catch {
        // already closed
      }
      active.delete(sid);
    },

    async stopAll() {
      for (const sid of [...active.keys()]) this.closeForSession(sid);
      if (everUpgraded) await new Promise((resolve) => setTimeout(resolve, 250));
    },
  };
}
