// One-command dev loop: core (watch) + Vite (HMR) + the native shell window pointed at Vite.
// Run with `bun run dev`. Ctrl-C tears all three down.
//
// Ordering matters: the shell window loads the Vite URL, whose /api calls proxy to dev:core. If we
// launched the shell before Vite/core were listening, the first paint would error until a manual
// reload. So we spawn core + Vite, poll both until healthy, THEN spawn the shell.
import { spawn, spawnSync, type Subprocess } from "bun";

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

/** Each tracked child is itself a multi-level wrapper (bun run -> bun --watch -> the real core
 *  worker; bun run -> vite.exe -> the real node vite process; bun run -> cargo -> the real shell
 *  exe), and Windows doesn't cascade a kill (or even a clean exit) from a process to whatever it
 *  spawned. A plain Subprocess.kill() on just the tracked pid reliably orphans the actual listening
 *  process behind it — that's BASED-DEV-CLEAN-SHUTDOWN's bug: stray core/vite processes surviving
 *  every `bun run dev` session, still holding their ports next time. `taskkill /T` kills the whole
 *  tree instead. Safe to call even on an already-exited pid (harmless no-op), so we always run it
 *  rather than only for stragglers — a child that exited cleanly may still have left descendants. */
function killTree(pid: number): void {
  try {
    spawnSync(["taskkill", "/PID", String(pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" });
  } catch {
    // already gone
  }
}

/** Backstop for the shell child. shutdown() usually runs *because* the shell exited (window closed),
 *  and taskkill /T can only discover a live pid's descendants — so a shell process that outlived its
 *  cargo parent would survive the tree-kill. Sweep by command-line path instead of by process
 *  ancestry — safe because this path is unique to this project's own build output, not a generic
 *  term that could match an unrelated app. Excludes $PID since the sweep script's own invoking
 *  powershell.exe command line echoes the same path fragment back at itself. */
function killOrphanedShellProcesses(): void {
  const patterns = ["*shell-tauri\\target\\debug\\based-shell*"];
  const filter = patterns.map((p) => `$_.CommandLine -like '${p}'`).join(" -or ");
  const script = `Get-CimInstance Win32_Process | Where-Object { ($_.ProcessId -ne $PID) -and (${filter}) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
  try {
    spawnSync(["powershell.exe", "-NoProfile", "-Command", script], { stdout: "ignore", stderr: "ignore" });
  } catch {
    // best-effort
  }
}

/** A previous session that died without running shutdown() (terminal closed, crash, sleep) leaves
 *  its core/vite children as orphans still bound to these fixed dev ports — the next `bun run dev`
 *  then fails core's EADDRINUSE while vite silently keeps a stray process alive too, and either way
 *  the stray keeps quietly serving old code underneath the new session. Free the ports before
 *  spawning fresh children, mirroring killOrphanedShellProcesses' shutdown-time cleanup above. */
function freeDevPorts(): void {
  for (const port of [7042, 5183]) {
    const query = `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue).OwningProcess | Select-Object -Unique`;
    let pids: number[] = [];
    try {
      const result = spawnSync(["powershell.exe", "-NoProfile", "-Command", query], { stdout: "pipe", stderr: "ignore" });
      pids = result.stdout
        .toString()
        .split(/\s+/)
        .map(Number)
        .filter((n: number) => Number.isInteger(n) && n > 0);
    } catch {
      continue;
    }
    for (const pid of pids) {
      console.log(`[dev] port ${port} was held by stale pid ${pid} (leftover from a previous session) — freeing it`);
      spawnSync(["powershell.exe", "-NoProfile", "-Command", `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`], {
        stdout: "ignore",
        stderr: "ignore",
      });
    }
  }
}

/** The shell is Rust now that dev and release run the same Tauri binary, so a missing toolchain is
 *  a hard stop. Check before spawning anything: otherwise the failure is a lone
 *  `bun: command not found: cargo` buried under core/vite's startup logs, followed by a teardown
 *  that looks clean because the shell child "exited" the same way a closed window does. */
function requireCargo(): void {
  let ok = false;
  try {
    ok = spawnSync(["cargo", "--version"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
  } catch {
    ok = false; // not on PATH — Bun throws rather than returning a code
  }
  if (ok) return;
  console.error(
    "[dev] cargo not found on PATH. The shell is Tauri (Rust), so `bun run dev` needs the Rust\n" +
      "      toolchain: https://rustup.rs — then reopen the terminal.\n" +
      "      To work on core/ui only, skip the window: `bun run dev:core` + `bun run dev:ui`.",
  );
  process.exit(1);
}

async function shutdown(code = 0): Promise<never> {
  // On Windows, Ctrl-C is a console-wide broadcast: core/vite/shell get it at the same
  // instant we do and start their own graceful exit (Vite in particular restores the raw
  // terminal mode it sets for its interactive shortcuts). Force-killing immediately races
  // that cleanup and can leave the console stuck in raw mode. Give them a moment to exit
  // themselves first; only tree-kill stragglers after the grace period.
  const alive = children.filter((c) => c.exitCode === null && c.signalCode === null);
  if (alive.length > 0) {
    await Promise.race([Promise.all(alive.map((c) => c.exited)), Bun.sleep(2000)]);
  }
  for (const c of children) killTree(c.pid);
  killOrphanedShellProcesses();
  process.exit(code);
}

process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));

requireCargo();
freeDevPorts();

run("core (watch)", ["bun", "run", "dev:core"]);
run("vite (HMR)", ["bun", "run", "dev:ui"]);

try {
  await Promise.all([waitFor("core", CORE_HEALTH), waitFor("vite", VITE_URL)]);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  shutdown(1);
}

// `cargo run`, not `tauri dev`: with BASED_DEV_URL set the shell skips spawning core entirely and
// just points a window at Vite, so there is no frontend build for the Tauri CLI to orchestrate.
// The first run compiles the Rust shell (minutes); after that it is near-instant.
const shell = run("shell (tauri)", ["bun", "run", "--cwd", "shell-tauri", "dev"], { BASED_DEV_URL: VITE_URL });

// When the shell window closes, tear down core + Vite too.
await shell.exited;
shutdown(0);
