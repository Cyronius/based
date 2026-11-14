// The official current Servo binary speaks a different protocol from Versoview.
// This is a separate preview of the real based UI/core in Servo's demo shell.
import { mkdir, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Subprocess } from "bun";
import release from "../shell-servo/servo-release.json";

const root = resolve(import.meta.dir, "..");
const installation = join(root, "shell-servo", "target", `servo-${release.version}`);
const executable = join(installation, "servo", "servoshell");

async function ensureEngine(): Promise<void> {
  if (`${process.platform}-${process.arch}` !== release.platform) {
    throw new Error(`This Servo preview currently supports ${release.platform}.`);
  }
  await mkdir(installation, { recursive: true });
  const archive = join(installation, release.archive);
  if (!(await Bun.file(archive).exists())) {
    console.log(`Downloading official Servo ${release.version}…`);
    const response = await fetch(release.url);
    if (!response.ok) throw new Error(`Servo download failed: HTTP ${response.status}`);
    const partial = `${archive}.part`;
    try {
      await Bun.write(partial, response);
      const actual = createHash("sha256").update(new Uint8Array(await Bun.file(partial).arrayBuffer())).digest("hex");
      if (actual !== release.sha256) throw new Error("Servo download checksum does not match the pinned release.");
      await rename(partial, archive);
    } finally {
      await rm(partial, { force: true });
    }
  }
  const actual = createHash("sha256").update(new Uint8Array(await Bun.file(archive).arrayBuffer())).digest("hex");
  if (actual !== release.sha256) throw new Error(`Checksum mismatch: delete ${archive} and retry.`);
  if (!(await Bun.file(executable).exists())) {
    const extract = Bun.spawn(["tar", "-xzf", archive, "-C", installation], { stdout: "inherit", stderr: "inherit" });
    if (await extract.exited !== 0) throw new Error("Could not extract the Servo release.");
  }
  const version = Bun.spawn([executable, "--version"], { stdout: "pipe", stderr: "inherit" });
  const output = (await new Response(version.stdout).text()).trim();
  if (await version.exited !== 0 || !output.includes(`Servo ${release.version}`)) {
    throw new Error(`Unexpected Servo binary version: ${output}`);
  }
  console.log(output);
}

await ensureEngine();
if (process.argv.includes("--prepare")) process.exit(0);

// Set this before importing core: storage initializes lazily from the environment.
const data = process.env.BASED_DATA_DIR ?? join(root, "shell-servo", "target", "latest-data");
process.env.BASED_DATA_DIR = data;
process.env.XDG_CACHE_HOME ??= join(data, "cache");
process.env.XDG_CONFIG_HOME ??= join(data, "config");
await mkdir(data, { recursive: true });
const staticDir = process.env.BASED_UI_DIST ?? join(root, "ui", "dist-servo-latest");
if (!(await Bun.file(join(staticDir, "index.html")).exists())) {
  throw new Error("Frontend not built. Run bash scripts/dev-servo-latest.sh first.");
}

const { startServer } = await import("../core/src/server");
const windows = new Map<Subprocess, string>();
let shuttingDown = false;
const server = startServer({
  staticDir,
  onRequestNewWindow: () => void openWindow().catch((error: unknown) => console.error("Could not open Servo window", error)),
});

async function shutdown(code = 0): Promise<never> {
  if (shuttingDown) return new Promise(() => {});
  shuttingDown = true;
  const children = [...windows.keys()];
  for (const child of children) child.kill();
  await Promise.race([Promise.all(children.map((child) => child.exited)), Bun.sleep(2000)]);
  for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
  await server.stop();
  process.exit(code);
}
process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));

async function openWindow(): Promise<void> {
  if (shuttingDown) return;
  const sid = randomUUID();
  const profile = join(data, "profiles", sid);
  await mkdir(profile, { recursive: true });
  const url = new URL(server.url);
  url.hash = new URLSearchParams({ token: server.token, sid }).toString();
  const args = [executable, "--config-dir", profile, "--window-size", "1680x1000"];
  if (process.env.BASED_DEVTOOLS === "1") {
    const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const port = probe.port;
    probe.stop(true);
    args.push("--devtools", `127.0.0.1:${port}`);
    console.log(`based Servo ${release.version} devtools: localhost:${port}`);
  }
  args.push(url.toString());
  const child = Bun.spawn(args, { cwd: root, stdio: ["ignore", "inherit", "inherit"] });
  windows.set(child, sid);
  const code = await child.exited;
  windows.delete(child);
  try {
    await fetch(`${server.url}/api/session/close?${new URLSearchParams({ token: server.token, sid })}`, { method: "POST" });
  } catch {
    // Core may already be shutting down after a signal.
  }
  if (!shuttingDown && windows.size === 0) await shutdown(code ?? 1);
}

console.log(`based preview: official Servo ${release.version}; isolated data at ${data}`);
console.log("This preview uses Servo's demo shell. The Tauri/Verso experiment is available separately.");
try {
  await openWindow();
} catch (error) {
  console.error(error);
  await shutdown(1);
}
