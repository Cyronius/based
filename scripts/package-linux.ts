// Traces: BASED-PACKAGE-LINUX. Build on the oldest Fedora release we support; native addons
// and the bundled Bun runtime target the build host, so cross-compiling is not supported.
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

if (process.platform !== "linux") throw new Error("Build the Linux package on Linux.");
const root = resolve(import.meta.dir, "..");
const shell = join(root, "shell-tauri");
const { version } = await Bun.file(join(shell, "tauri.conf.json")).json();

async function run(args: string[], cwd = root): Promise<void> {
  const child = Bun.spawn(args, { cwd, stdio: ["inherit", "inherit", "inherit"] });
  if (await child.exited !== 0) throw new Error(`Build failed: ${args.join(" ")}`);
}

await run([process.execPath, "run", "build:ui"]);
await run([process.execPath, "bundle-core.ts"], shell);
for (const file of ["core/index.js", "core/libduckdb.so", "ui/dist/index.html", "bun/bun"]) {
  if (!existsSync(join(shell, "dist-core", file))) throw new Error(`Missing bundled resource: ${file}`);
}
await run([process.execPath, "x", "--no-install", "tauri", "build", "--bundles", "rpm"], shell);

const bundleDir = join(shell, "target", "release", "bundle", "rpm");
const arch = process.arch === "x64" ? "x86_64" : process.arch === "arm64" ? "aarch64" : process.arch;
const packages = readdirSync(bundleDir).filter((file) => file.endsWith(`.${arch}.rpm`) && file.includes(`-${version}-`));
if (packages.length !== 1) throw new Error(`Expected one RPM for ${version}/${arch}, found: ${packages.join(", ")}`);
const dist = join(root, "dist");
mkdirSync(dist, { recursive: true });
const name = `based-${version}-fedora-${arch}.rpm`;
copyFileSync(join(bundleDir, packages[0]!), join(dist, name));
const sha256 = new Bun.CryptoHasher("sha256").update(await Bun.file(join(dist, name)).arrayBuffer()).digest("hex");
await Bun.write(join(dist, `${name}.sha256`), `${sha256}  ${name}\n`);
console.log(`Fedora package: dist/${name}\nSHA-256: ${sha256}`);
