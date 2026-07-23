// One-command dev loop: core (watch) + Vite (HMR) + the native shell window pointed at Vite.
// Run with `bun run dev`. Ctrl-C tears all three down.
//
// Ordering matters: the shell window loads the Vite URL, whose /api calls proxy to dev:core. If we
// launched the shell before Vite/core were listening, the first paint would error until a manual
// reload. So we spawn core + Vite, poll both until healthy, THEN spawn the shell.
import { spawn, type Subprocess } from "bun";

const VITE_URL = "http://localhost:5183";
const CORE_HEALTH = "http://127.0.0.1:7042/api/health";

const children: Subprocess[] = [];

/** Spawn a workspace script, inheriting stdio so its logs interleave in this terminal. */
function run(label: string, args: string[], env?: Record<string, string>): Subprocess {
  console.log(`[dev] starting ${label}`);
  // On Windows, uv_spawn won't resolve a bare "bun" against PATH/PATHEXT — use the running binary's path.
  const resolved = args[0] === "bun" ? [process.execPath, ...args.slice(1)] : args;
  const proc = spawn(resolved, { stdio: ["inherit", "inherit", "inherit"], env: { ...process.env, ...env } });
  children.push(proc);
  return proc;
}

/** Poll a URL until it responds (any status) or we give up. */
async function waitFor(label: string, url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(url);
      console.log(`[dev] ${label} ready`);
      return;
    } catch {
      await Bun.sleep(300);
    }
  }
  throw new Error(`[dev] ${label} did not come up within ${timeoutMs}ms (${url})`);
}

async function shutdown(code = 0): Promise<never> {
  // On Windows, Ctrl-C is a console-wide broadcast: core/vite/shell get it at the same
  // instant we do and start their own graceful exit (Vite in particular restores the raw
  // terminal mode it sets for its interactive shortcuts). Force-killing immediately races
  // that cleanup and can leave the console stuck in raw mode. Give them a moment to exit
  // themselves first; only hard-kill stragglers after the grace period.
  const alive = children.filter((c) => c.exitCode === null && c.signalCode === null);
  if (alive.length > 0) {
    await Promise.race([Promise.all(alive.map((c) => c.exited)), Bun.sleep(2000)]);
  }
  for (const c of children) {
    if (c.exitCode === null && c.signalCode === null) {
      try {
        c.kill();
      } catch {
        // already gone
      }
    }
  }
  process.exit(code);
}

process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));

run("core (watch)", ["bun", "run", "dev:core"]);
run("vite (HMR)", ["bun", "run", "dev:ui"]);

try {
  await Promise.all([waitFor("core", CORE_HEALTH), waitFor("vite", VITE_URL)]);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  shutdown(1);
}

const shell = run("shell", ["bun", "run", "shell"], { BASED_DEV_URL: VITE_URL });

// When the shell window closes, tear down core + Vite too.
await shell.exited;
shutdown(0);
