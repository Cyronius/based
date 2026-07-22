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

function becomePrimary(lockFd: number, onNewWindowRequested: () => void): void {
  const controlToken = crypto.randomUUID();
  const control = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== "/new-window" || req.method !== "POST") return new Response("Not found", { status: 404 });
      if (req.headers.get("authorization") !== `Bearer ${controlToken}`) return new Response("Unauthorized", { status: 401 });
      onNewWindowRequested();
      return new Response("ok");
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
 *  If another instance is already running, asks it to open a new window on our
 *  behalf and exits this process — in that case the returned promise never
 *  resolves. */
export async function initSingleInstance(onNewWindowRequested: () => void): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const lockFd = openSync(lockPath, "wx");
      becomePrimary(lockFd, onNewWindowRequested);
      return;
    } catch (err) {
      if ((err as { code?: string }).code !== "EEXIST") throw err;
      const lock = readLock();
      if (lock && (await requestNewWindow(lock))) {
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
