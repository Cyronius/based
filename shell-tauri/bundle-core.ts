// Builds the self-contained core bundle the packaged Tauri shell spawns:
//   dist-core/core/index.js  (+ copied .node natives + duckdb.dll)
//   dist-core/ui/dist        (built frontend)
//   dist-core/bun/bun.exe    (runtime for the core bundle)
// tauri.conf.json maps these into <resources>/{core,ui,bun}; spawn_core() in src/main.rs runs
// <resources>/bun/bun.exe <resources>/core/index.js.
//
// The three plugins are ported unchanged from shell/electrobun.config.ts — each one is a real
// packaged-only failure (see the comments there before touching them): keyring's createRequire
// reassignment clobbers the bundle-global require; libsql's template-string require can't be
// followed by the bundler; duckdb's per-platform require switch resolves every branch.
import { readFile } from "node:fs/promises";
import { existsSync, readdirSync, mkdirSync, cpSync, copyFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const outRoot = join(import.meta.dir, "dist-core");

const fixNapiKeyringCreateRequire: import("bun").BunPlugin = {
  name: "fix-napi-keyring-create-require",
  setup(build) {
    build.onLoad({ filter: /@napi-rs[\\/]keyring[\\/]index\.js$/ }, async (args) => {
      const source = await readFile(args.path, "utf8");
      const contents = source.replace(
        /^\s*require\s*=\s*createRequire\(__filename\).*$/m,
        "// [tauri bundle fix] createRequire reassignment removed — see shell/electrobun.config.ts",
      );
      return { contents, loader: "js" };
    });
  },
};

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

/** duckdb.node is a thin shim linked against a companion duckdb.dll shipped beside it in the
 *  platform package; the bundler copies the .node but not its dependent DLL (BASED-PACKAGE-WIN). */
function duckdbCompanionLibPath(): string {
  const lib = { win32: "duckdb.dll", darwin: "libduckdb.dylib", linux: "libduckdb.so" }[process.platform as string] ?? "duckdb.dll";
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

copyFileSync(duckdbCompanionLibPath(), join(outRoot, "core", { win32: "duckdb.dll", darwin: "libduckdb.dylib", linux: "libduckdb.so" }[process.platform as string] ?? "duckdb.dll"));

const uiDist = join(root, "ui", "dist");
if (!existsSync(join(uiDist, "index.html"))) {
  throw new Error("ui/dist missing — run `bun run build:ui` first");
}
cpSync(uiDist, join(outRoot, "ui", "dist"), { recursive: true });

mkdirSync(join(outRoot, "bun"), { recursive: true });
copyFileSync(process.execPath, join(outRoot, "bun", "bun.exe"));

console.log(`bundled core -> ${outRoot}`);
for (const f of readdirSync(join(outRoot, "core"))) console.log(`  core/${f}`);
