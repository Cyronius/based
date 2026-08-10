// Child-process entry for the shell. Core runs as a separate process, so both the ready info and
// the UI's "new window" requests (POST /api/window/new -> onRequestNewWindow) cross the process
// boundary as single stdout lines the Rust shell parses (see shell-tauri/src/main.rs).
import { existsSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { startServer } from "@based/core";

/** Packaged layout: this bundle runs as <resources>/core/index.js with the UI beside it at
 *  <resources>/ui/dist. Dev fallback: walk up from cwd (the Rust shell sets cwd to the repo root). */
function findUiDist(): string | undefined {
  if (process.env.BASED_UI_DIST && existsSync(process.env.BASED_UI_DIST)) return process.env.BASED_UI_DIST;
  const entryDir = dirname(Bun.main);
  const bundled = resolve(entryDir, "..", "ui", "dist");
  if (existsSync(join(bundled, "index.html"))) return bundled;
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

const server = startServer({
  // Debug/test override; normally unset, letting core mint a random per-launch token.
  token: process.env.BASED_TOKEN,
  staticDir,
  onRequestNewWindow: () => {
    console.log(`BASED_EVENT ${JSON.stringify({ type: "new-window" })}`);
  },
});

console.log(`BASED_CORE_READY ${JSON.stringify({ url: server.url, token: server.token })}`);

// The shell holds our stdin pipe open for life; EOF means it died without killing us (crash /
// task-manager kill of the shell). Normal shutdown is the shell's child.kill() on exit.
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
process.stdin.on("error", () => process.exit(0));
