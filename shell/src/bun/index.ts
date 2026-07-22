// Thin, disposable shell (see plan): start the core server in-process, point a window at it.
// No Electrobun RPC for app logic — everything rides localhost HTTP.
import { BrowserWindow } from "electrobun/bun";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { startServer } from "@based/core";

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

const staticDir = findUiDist();
if (!staticDir) {
  console.error("based: ui/dist not found — run `bun run build:ui` first; window will show the bare core page");
}

const server = startServer({ staticDir });
console.log(`based core listening on ${server.url}`);

const win = new BrowserWindow({
  title: "based",
  url: `${server.url}/#token=${server.token}`,
  frame: { x: 120, y: 80, width: 1680, height: 1000 },
});

if (process.env.BASED_DEVTOOLS === "1") {
  setTimeout(() => win.webview.openDevTools(), 1500);
}
