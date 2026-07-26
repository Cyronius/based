// Hand-rolled single-instance lock: electrobun has no requestSingleInstanceLock
// equivalent. A second OS-level launch of the shell detects the already-running
// primary via this lock, asks it (over a tiny localhost control server) to open
// a new window, and exits — so only one process ever has app.db/agent.db open.
import { app } from "electrobun/bun";
import { dataDir } from "@based/core";
import { openSync, ftruncateSync, writeSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

interface LockInfo {
  pid: number;
  controlPort: number;
  controlToken: string;
}

const lockPath = join(dataDir(), "shell.lock");

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLock(): LockInfo | null {
  try {
    return JSON.parse(readFileSync(lockPath, "utf8")) as LockInfo;
  } catch {
    return null;
  }
}

async function requestNewWindow(lock: LockInfo): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${lock.controlPort}/new-window`, {
      method: "POST",
      headers: { authorization: `Bearer ${lock.controlToken}` },
      signal: AbortSignal.timeout(1000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// BASED-OPEN-SQL-ARGV: ask the primary to open a window for a file this (secondary) launch was
// asked to open.
async function requestOpenFile(lock: LockInfo, path: string): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${lock.controlPort}/open-file`, {
      method: "POST",
      headers: { authorization: `Bearer ${lock.controlToken}`, "content-type": "application/json" },
      body: JSON.stringify({ path }),
      signal: AbortSignal.timeout(1000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export interface SingleInstanceHandlers {
  onNewWindow: () => void;
  onOpenFile: (path: string) => void;
  /** File paths this OS-level launch was asked to open (argv / pending-opens file). */
  openRequests: string[];
}

function becomePrimary(lockFd: number, handlers: SingleInstanceHandlers): void {
  const controlToken = crypto.randomUUID();
  const control = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.headers.get("authorization") !== `Bearer ${controlToken}`) return new Response("Unauthorized", { status: 401 });
      if (url.pathname === "/new-window" && req.method === "POST") {
        handlers.onNewWindow();
        return new Response("ok");
      }
      if (url.pathname === "/open-file" && req.method === "POST") {
        const body = (await req.json().catch(() => null)) as { path?: string } | null;
        if (!body?.path) return new Response("Bad request", { status: 400 });
        handlers.onOpenFile(body.path);
        return new Response("ok");
      }
      return new Response("Not found", { status: 404 });
    },
  });

  const info: LockInfo = { pid: process.pid, controlPort: control.port!, controlToken };
  ftruncateSync(lockFd, 0);
  writeSync(lockFd, JSON.stringify(info), 0);

  // Courtesy cleanup; not load-bearing — the OS releases lockFd on any process exit,
  // so a later launch's exclusive-create just succeeds again even after a crash.
  app.on("before-quit", () => {
    try {
      rmSync(lockPath, { force: true });
    } catch {
      // best-effort
    }
  });
}

/** Acquires the single-instance lock. Resolves once this process is primary.
 *  If another instance is already running, hands it this launch's file-open
 *  requests (or asks for a new window when there are none) and exits this
 *  process — in that case the returned promise never resolves. */
export async function initSingleInstance(handlers: SingleInstanceHandlers): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const lockFd = openSync(lockPath, "wx");
      becomePrimary(lockFd, handlers);
      return;
    } catch (err) {
      if ((err as { code?: string }).code !== "EEXIST") throw err;
      const lock = readLock();
      if (lock && handlers.openRequests.length > 0) {
        let forwarded = 0;
        for (const p of handlers.openRequests) if (await requestOpenFile(lock, p)) forwarded++;
        if (forwarded > 0) process.exit(0);
      } else if (lock && process.env.BASED_STUB_OPEN === "1" && pidAlive(lock.pid)) {
        // Launched by based-open.exe but another live instance already consumed the pending-opens
        // file (rapid multi-double-click): nothing left to do — exit without spawning a blank
        // window per stub launch. A dead lock holder falls through to the stale-lock reclaim.
        process.exit(0);
      } else if (lock && (await requestNewWindow(lock))) {
        process.exit(0);
      }
      // Stale lock left by a process that died abnormally (or unreadable JSON) — reclaim it.
      try {
        rmSync(lockPath, { force: true });
      } catch {
        // ignore; the next attempt's openSync will surface a real error if this keeps failing
      }
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
  throw new Error("based shell: could not acquire single-instance lock after retries");
}
