// Thin, disposable shell (see plan): start the core server in-process, point windows at it.
// No Electrobun RPC for app logic — everything rides localhost HTTP.
import { BrowserWindow } from "electrobun/bun";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { startServer } from "@based/core";
import { initSingleInstance } from "./singleInstance";

/** electrobun dev runs from build/dev-win-x64; walk up until we find the repo's ui/dist. */
function findUiDist(): string | undefined {
  if (process.env.BASED_UI_DIST && existsSync(process.env.BASED_UI_DIST)) return process.env.BASED_UI_DIST;
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, "ui", "dist");
    if (existsSync(join(candidate, "index.html"))) return candidate;
    dir = resolve(dir, "..");
  }
  return undefined;
}

// Dev loop: point native windows at the Vite dev server (HMR) instead of serving the static
// ui/dist bundle. Vite proxies /api to the standalone `dev:core` (:7042, token "dev"), and the client
// falls back to that token when there's no URL hash — so we skip the in-process core here.
// Usage: `bun run dev:core` + `bun run dev:ui`, then `BASED_DEV_URL=http://localhost:5183 bun run shell`.
const devUrl = process.env.BASED_DEV_URL;

let baseUrl: string;
let apiToken: string;
if (devUrl) {
  baseUrl = devUrl;
  apiToken = process.env.BASED_TOKEN ?? "dev";
  console.log(`based shell: dev mode → ${devUrl} (HMR via Vite; core from dev:core)`);
} else {
  const staticDir = findUiDist();
  if (!staticDir) {
    console.error("based: ui/dist not found — run `bun run build:ui` first; window will show the bare core page");
  }
  const server = startServer({ staticDir });
  console.log(`based core listening on ${server.url}`);
  baseUrl = server.url;
  apiToken = server.token;
}

// Each window gets its own sid, so the backend treats it as an independent workspace
// (own DB connection, own SSE stream) — see core/src/server.ts's per-sid session map. A sid is
// also the durable key BASED-WINDOW-RESTORE persists window state under, so relaunching the app
// reuses the sid of a window that was still open last time instead of minting a fresh one.
let windowsCreated = 0;

function createWindow(existingSid?: string): void {
  const sid = existingSid ?? crypto.randomUUID();
  const offset = windowsCreated * 40;
  windowsCreated++;

  const win = new BrowserWindow({
    title: "based",
    url: `${baseUrl}/#token=${apiToken}&sid=${sid}`,
    frame: { x: 120 + offset, y: 80 + offset, width: 1680, height: 1000 },
  });

  win.on("close", () => {
    fetch(`${baseUrl}/api/session/close?sid=${sid}&token=${apiToken}`, { method: "POST" }).catch(() => {});
  });

  if (process.env.BASED_DEVTOOLS === "1") {
    setTimeout(() => win.webview.openDevTools(), 1500);
  }
}

// Second OS-level launch attaches a new window to this (the already-running) instance
// instead of starting a second backend against the same app.db/agent.db files.
await initSingleInstance(() => createWindow());

// BASED-WINDOW-RESTORE: reopen one window per sid that was still open when the app last exited
// (cleanly or via kill) — window_state rows for cleanly-closed windows are deleted on close, so
// only windows that were genuinely left open come back. Falls back to a single fresh window when
// there's nothing to restore (first launch, or everything was closed before quitting).
type PersistedWindow = { sid: string };
const persisted = await fetch(`${baseUrl}/api/windows?token=${apiToken}`)
  .then((r) => r.json() as Promise<PersistedWindow[]>)
  .catch(() => [] as PersistedWindow[]);
const restorable = persisted.filter((w) => w.sid !== "default");
if (restorable.length > 0) {
  for (const w of restorable) createWindow(w.sid);
} else {
  createWindow();
}
