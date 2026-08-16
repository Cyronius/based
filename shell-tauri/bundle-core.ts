// Builds the self-contained core bundle the packaged Tauri shell spawns:
//   dist-core/core/index.js       (+ copied .node natives + the duckdb companion library)
//   dist-core/ui/dist             (built frontend)
//   dist-core/bun/bun[.exe]       (runtime for the core bundle)
// tauri.conf.json maps these into <resources>/{core,ui,bun}; spawn_core() in src/main.rs runs
// <resources>/bun/bun[.exe] <resources>/core/index.js.
//
// BASED-PLATFORM-PATHS: this script builds for the *host* platform and architecture — every native
// binding below is picked by `${process.platform}-${process.arch}`. That is correct because we build
// each target on its own machine (Windows locally, macOS on a CI runner); it is also why there is no
// cross-compilation path. Producing a bundle for another platform means running this there.
//
// The three bundler plugins below each fix a real packaged-only failure — none of them reproduces
// under `bun run`, so the only way to catch a regression is to build and launch the installed app.
// Read the comment above a plugin before touching it.
import { readFile } from "node:fs/promises";
import { existsSync, readdirSync, mkdirSync, cpSync, copyFileSync, chmodSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const outRoot = join(import.meta.dir, "dist-core");

// @napi-rs/keyring's loader reassigns `require = createRequire(__filename)` (index.js:7) so that,
// when run unbundled, it resolves its native binding relative to its own package. Bun's bundler
// inlines __filename as the source path in the bun store and lets that reassignment clobber the
// bundle-global `require` (import.meta.require). The bundler copies the platform .node beside the
// output index.js and rewrites the load to a bundle-relative `./…node`, but the clobbered require
// now resolves that path against the store dir instead of the bundle — so the (present) binary is
// never found: "Cannot find native binding". Stripping the reassignment leaves
// `require` = import.meta.require, which resolves the copied binary next to index.js. Only affects
// this bundle; core's direct-Bun path and the specs tests never hit this plugin.
const fixNapiKeyringCreateRequire: import("bun").BunPlugin = {
  name: "fix-napi-keyring-create-require",
  setup(build) {
    build.onLoad({ filter: /@napi-rs[\\/]keyring[\\/]index\.js$/ }, async (args) => {
      const source = await readFile(args.path, "utf8");
      const contents = source.replace(
        /^\s*require\s*=\s*createRequire\(__filename\).*$/m,
        "// [tauri bundle fix] createRequire reassignment removed — see bundle-core.ts",
      );
      return { contents, loader: "js" };
    });
  },
};

// libsql (via @mastra/libsql) loads its native binding with a runtime-computed
// `require(`@libsql/${target}`)` (index.js:26) that Bun's bundler can't follow, so the platform
// .node is never copied beside the bundle -> "Cannot find module '@libsql/win32-x64-msvc'" at
// startup. Rewrite it to a static literal require for the build host's target so Bun resolves and
// copies index.node, the same way keyring/lancedb already work.
const LIBSQL_NEON_TARGETS: Record<string, string> = {
  "win32-x64": "win32-x64-msvc",
  "darwin-arm64": "darwin-arm64",
  "darwin-x64": "darwin-x64",
  "linux-x64": "linux-x64-gnu",
  "linux-arm64": "linux-arm64-gnu",
};
const fixLibsqlNativeRequire: import("bun").BunPlugin = {
  name: "fix-libsql-native-require",
  setup(build) {
    const target = LIBSQL_NEON_TARGETS[`${process.platform}-${process.arch}`] ?? "win32-x64-msvc";
    build.onLoad({ filter: /[\\/]libsql[\\/]index\.js$/ }, async (args) => {
      const source = await readFile(args.path, "utf8");
      const contents = source.replace(
        /return require\(`@libsql\/\$\{target\}`\);/,
        `return require("@libsql/${target}");`,
      );
      return { contents, loader: "js" };
    });
  },
};

// @duckdb/node-bindings loads its native binding via a switch of per-platform *static* require()
// literals (duckdb.js) — unlike libsql's template-string require, each branch is individually
// resolvable, so Bun's bundler dutifully tries to resolve EVERY branch (not just the one
// getRuntimePlatformArch() would pick at runtime), including the platform-specific optional
// dependency packages that were never installed for platforms other than the build host's:
// "Could not resolve: @duckdb/node-bindings-<other-platform>/duckdb.node". Replace the whole file
// with a single static require for the build host's target, so only that (installed) package is
// ever referenced — same fix shape as fixLibsqlNativeRequire above.
const DUCKDB_BINDING_TARGETS: Record<string, string> = {
  "win32-x64": "win32-x64",
  "win32-arm64": "win32-arm64",
  "darwin-arm64": "darwin-arm64",
  "darwin-x64": "darwin-x64",
  "linux-x64": "linux-x64",
  "linux-arm64": "linux-arm64",
};
const duckdbTarget = DUCKDB_BINDING_TARGETS[`${process.platform}-${process.arch}`] ?? "win32-x64";
const fixDuckdbNativeRequire: import("bun").BunPlugin = {
  name: "fix-duckdb-native-require",
  setup(build) {
    build.onLoad({ filter: /@duckdb[\\/]node-bindings[\\/]duckdb\.js$/ }, async () => ({
      contents: `module.exports = require("@duckdb/node-bindings-${duckdbTarget}/duckdb.node");\n`,
      loader: "js",
    }));
  },
};

/** BASED-PACKAGE-WIN / BASED-PACKAGE-MAC: duckdb.node is only a thin N-API shim dynamically linked
 *  against a large companion library shipped beside it in the platform package. Bun's bundler copies
 *  the required .node next to the bundle output but not its dependent library, so the packaged app
 *  fails the first LanceDB/DuckDB query with "LoadLibrary failed: The specified module could not be
 *  found." (Windows) or an equivalent dyld load error (macOS). Copy the companion next to the
 *  bundled .node — the OS loader searches the addon's own directory first for its dependents.
 *
 *  Located by scanning the workspace .bun store directly (version-agnostic prefix match) rather than
 *  Bun.resolveSync, because the platform package is a transitive dep of core, not a dep of
 *  shell-tauri, so it has no top-level node_modules entry to resolve against. */
const DUCKDB_COMPANION_LIBS: Record<string, string> = {
  win32: "duckdb.dll",
  darwin: "libduckdb.dylib",
  linux: "libduckdb.so",
};
const duckdbCompanionLib = DUCKDB_COMPANION_LIBS[process.platform] ?? "duckdb.dll";

function duckdbCompanionLibPath(): string {
  const lib = duckdbCompanionLib;
  const store = join(root, "node_modules", ".bun");
  const prefix = `@duckdb+node-bindings-${duckdbTarget}@`;
  const entry = readdirSync(store).find((d) => d.startsWith(prefix));
  const libPath = entry ? join(store, entry, "node_modules", "@duckdb", `node-bindings-${duckdbTarget}`, lib) : null;
  if (!libPath || !existsSync(libPath)) {
    throw new Error(`duckdb companion library not found: ${prefix}*/…/${lib} under ${store}`);
  }
  return libPath;
}

rmSync(outRoot, { recursive: true, force: true });
mkdirSync(join(outRoot, "core"), { recursive: true });

const result = await Bun.build({
  entrypoints: [join(import.meta.dir, "core-child.ts")],
  outdir: join(outRoot, "core"),
  target: "bun",
  naming: "index.[ext]",
  sourcemap: "none",
  plugins: [fixNapiKeyringCreateRequire, fixLibsqlNativeRequire, fixDuckdbNativeRequire],
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

copyFileSync(duckdbCompanionLibPath(), join(outRoot, "core", duckdbCompanionLib));

const uiDist = join(root, "ui", "dist");
if (!existsSync(join(uiDist, "index.html"))) {
  throw new Error("ui/dist missing — run `bun run build:ui` first");
}
cpSync(uiDist, join(outRoot, "ui", "dist"), { recursive: true });

// The runtime is whichever bun is running this script — so it is already the host's platform and
// arch, matching the natives resolved above. main.rs looks for this exact filename (BUN_EXE).
mkdirSync(join(outRoot, "bun"), { recursive: true });
const bunExeName = process.platform === "win32" ? "bun.exe" : "bun";
const bunExePath = join(outRoot, "bun", bunExeName);
copyFileSync(process.execPath, bunExePath);
// copyFileSync carries the source mode over, but the bundle is worthless if the bit is ever lost in
// transit (DMG round-trip, artifact zip), and the failure mode is an opaque "permission denied" at
// launch rather than anything pointing here.
if (process.platform !== "win32") chmodSync(bunExePath, 0o755);

console.log(`bundled core -> ${outRoot}`);
for (const f of readdirSync(join(outRoot, "core"))) console.log(`  core/${f}`);
