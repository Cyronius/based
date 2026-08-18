// One-command dev loop: core (watch) + Vite (HMR) + the native shell window pointed at Vite.
// Run with `bun run dev`. Ctrl-C tears all three down.
//
// Ordering matters: the shell window loads the Vite URL, whose /api calls proxy to dev:core. If we
// launched the shell before Vite/core were listening, the first paint would error until a manual
// reload. So we spawn core + Vite, poll both until healthy, THEN spawn the shell.
import { spawn, spawnSync, type Subprocess } from "bun";
import { join } from "node:path";

const VITE_URL = "http://localhost:5183";
const CORE_HEALTH = "http://127.0.0.1:7042/api/health";
const IS_WIN = process.platform === "win32";

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

function parsePids(out: string): number[] {
  return out
    .split(/\s+/)
    .map(Number)
    .filter((n: number) => Number.isInteger(n) && n > 0);
}

/** Force-kill one pid. Bun's process.kill throws ESRCH on an already-exited pid; that is the normal
 *  case here, not an error. */
function killPid(pid: number): void {
  try {
    if (IS_WIN) {
      spawnSync(["powershell.exe", "-NoProfile", "-Command", `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`], {
        stdout: "ignore",
        stderr: "ignore",
      });
    } else {
      process.kill(pid, "SIGKILL");
    }
  } catch {
    // already gone
  }
}

/** Each tracked child is itself a multi-level wrapper (bun run -> bun --watch -> the real core
 *  worker; bun run -> vite -> the real node vite process; bun run -> cargo -> the real shell
 *  exe), and neither platform cascades a kill (or even a clean exit) from a process to whatever it
 *  spawned. A plain Subprocess.kill() on just the tracked pid reliably orphans the actual listening
 *  process behind it — that's BASED-DEV-CLEAN-SHUTDOWN's bug: stray core/vite processes surviving
 *  every `bun run dev` session, still holding their ports next time. Safe to call even on an
 *  already-exited pid (harmless no-op), so we always run it rather than only for stragglers — a
 *  child that exited cleanly may still have left descendants.
 *
 *  Windows has `taskkill /T` for this. POSIX has nothing equivalent, so walk the tree with
 *  `pgrep -P` and kill depth-first: killing a parent first would reparent its children to launchd,
 *  where no ancestry query can still find them. */
function killTree(pid: number): void {
  if (IS_WIN) {
    try {
      spawnSync(["taskkill", "/PID", String(pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" });
    } catch {
      // already gone
    }
    return;
  }
  for (const child of childPids(pid)) killTree(child);
  killPid(pid);
}

function childPids(pid: number): number[] {
  try {
    // pgrep exits 1 with empty stdout when there are no matches — parsePids handles that.
    const result = spawnSync(["pgrep", "-P", String(pid)], { stdout: "pipe", stderr: "ignore" });
    return parsePids(result.stdout.toString());
  } catch {
    return [];
  }
}

/** Backstop for the shell child. shutdown() usually runs *because* the shell exited (window closed),
 *  and a tree-kill can only discover a live pid's descendants — so a shell process that outlived its
 *  cargo parent would survive it. Sweep by command-line path instead of by process ancestry — safe
 *  because this path is unique to this project's own build output, not a generic term that could
 *  match an unrelated app. `join` builds the fragment with the host's separator, which is what each
 *  platform's command lines actually contain. */
function killOrphanedShellProcesses(): void {
  const marker = join("shell-tauri", "target", "debug", "based-shell");
  try {
    if (IS_WIN) {
      // Excludes $PID: the sweep script's own invoking powershell.exe command line echoes the same
      // path fragment back at itself.
      const filter = `$_.CommandLine -like '*${marker}*'`;
      const script = `Get-CimInstance Win32_Process | Where-Object { ($_.ProcessId -ne $PID) -and (${filter}) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
      spawnSync(["powershell.exe", "-NoProfile", "-Command", script], { stdout: "ignore", stderr: "ignore" });
    } else {
      // pkill never matches its own process, so the self-exclusion above has no counterpart here.
      spawnSync(["pkill", "-9", "-f", marker], { stdout: "ignore", stderr: "ignore" });
    }
  } catch {
    // best-effort
  }
}

/** Pull pids out of `ss -p` output, which embeds them in
 *  `users:(("bun",pid=1234,fd=20),("bun",pid=1235,fd=21))` rather than printing them bare.
 *  Deduplicated because one process listening on both IPv4 and IPv6 appears once per socket, and
 *  the caller logs a line per pid — the Windows query says `Select-Object -Unique` for the same
 *  reason. */
function parseSsPids(out: string): number[] {
  const pids = [...out.matchAll(/pid=(\d+)/g)]
    .map((m) => Number(m[1]))
    .filter((n: number) => Number.isInteger(n) && n > 0);
  return [...new Set(pids)];
}

/** Pids holding a listening socket on `port`, or [] if none/unknowable.
 *
 *  Linux tries `ss` before `lsof`. `ss` ships in iproute, which every distro installs, whereas
 *  **Fedora Workstation does not install lsof by default** — and a missing tool here fails silently
 *  to [], which leaves a stale core holding 7042 and makes the next `bun run dev` die on EADDRINUSE
 *  with nothing pointing at the cause. macOS has no `ss`, so it stays on lsof. */
function listenerPids(port: number): number[] {
  try {
    if (IS_WIN) {
      const query = `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue).OwningProcess | Select-Object -Unique`;
      const result = spawnSync(["powershell.exe", "-NoProfile", "-Command", query], { stdout: "pipe", stderr: "ignore" });
      return parsePids(result.stdout.toString());
    }
    if (process.platform === "linux") {
      try {
        // -H no header, -l listening, -t tcp, -n numeric, -p owning process. Exits 0 with empty
        // output when nothing matches, so a clean exit is an answer — only a missing binary
        // (which throws) should fall through to lsof.
        const ss = spawnSync(["ss", "-Hltnp", `sport = :${port}`], { stdout: "pipe", stderr: "ignore" });
        if (ss.success) return parseSsPids(ss.stdout.toString());
      } catch {
        // ss not installed — fall through to lsof
      }
    }
    // lsof exits 1 with empty stdout when nothing is listening.
    const result = spawnSync(["lsof", "-ti", `tcp:${port}`, "-sTCP:LISTEN"], { stdout: "pipe", stderr: "ignore" });
    return parsePids(result.stdout.toString());
  } catch {
    return [];
  }
}

/** A previous session that died without running shutdown() (terminal closed, crash, sleep) leaves
 *  its core/vite children as orphans still bound to these fixed dev ports — the next `bun run dev`
 *  then fails core's EADDRINUSE while vite silently keeps a stray process alive too, and either way
 *  the stray keeps quietly serving old code underneath the new session. Free the ports before
 *  spawning fresh children, mirroring killOrphanedShellProcesses' shutdown-time cleanup above. */
function freeDevPorts(): void {
  for (const port of [7042, 5183]) {
    for (const pid of listenerPids(port)) {
      console.log(`[dev] port ${port} was held by stale pid ${pid} (leftover from a previous session) — freeing it`);
      killPid(pid);
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
