import type { ElectrobunConfig } from "electrobun";
import { readFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

// @napi-rs/keyring's loader reassigns `require = createRequire(__filename)`
// (index.js:7) so that, when run unbundled, it resolves its native binding
// relative to its own package. Bun's bundler inlines __filename as the source
// path in the bun store and lets that reassignment clobber the bundle-global
// `require` (import.meta.require). The bundler copies the platform .node beside
// the output index.js and rewrites the load to a bundle-relative `./…node`, but
// the clobbered require now resolves that path against the store dir instead of
// the bundle — so the (present) binary is never found: "Cannot find native
// binding". Stripping the reassignment leaves `require` = import.meta.require,
// which resolves the copied binary next to index.js. Only affects the shell
// bundle; core's direct-Bun path and specs tests never hit this plugin.
const fixNapiKeyringCreateRequire = {
  name: "fix-napi-keyring-create-require",
  setup(build: import("bun").PluginBuilder) {
    build.onLoad(
      { filter: /@napi-rs[\\/]keyring[\\/]index\.js$/ },
      async (args: { path: string }) => {
        const source = await readFile(args.path, "utf8");
        const contents = source.replace(
          /^\s*require\s*=\s*createRequire\(__filename\).*$/m,
          "// [electrobun bundle fix] createRequire reassignment removed — see electrobun.config.ts",
        );
        return { contents, loader: "js" as const };
      },
    );
  },
};

// libsql (via @mastra/libsql) loads its native binding with a runtime-computed
// `require(`@libsql/${target}`)` (index.js:26) that Bun's bundler can't follow,
// so the platform .node is never copied beside the bundle → "Cannot find module
// '@libsql/win32-x64-msvc'" at startup. Rewrite it to a static literal require
// for the build host's target so Bun resolves & copies index.node, the same way
// keyring/lancedb already work.
const LIBSQL_NEON_TARGETS: Record<string, string> = {
  "win32-x64": "win32-x64-msvc",
  "darwin-arm64": "darwin-arm64",
  "darwin-x64": "darwin-x64",
  "linux-x64": "linux-x64-gnu",
  "linux-arm64": "linux-arm64-gnu",
};
const fixLibsqlNativeRequire = {
  name: "fix-libsql-native-require",
  setup(build: import("bun").PluginBuilder) {
    const target =
      LIBSQL_NEON_TARGETS[`${process.platform}-${process.arch}`] ??
      "win32-x64-msvc";
    build.onLoad(
      { filter: /[\\/]libsql[\\/]index\.js$/ },
      async (args: { path: string }) => {
        const source = await readFile(args.path, "utf8");
        const contents = source.replace(
          /return require\(`@libsql\/\$\{target\}`\);/,
          `return require("@libsql/${target}");`,
        );
        return { contents, loader: "js" as const };
      },
    );
  },
};

// @duckdb/node-bindings loads its native binding via a switch of per-platform *static* require()
// literals (duckdb.js) — unlike libsql's template-string require, each branch is individually
// resolvable, so Bun's bundler dutifully tries to resolve EVERY branch (not just the one
// `getRuntimePlatformArch()` would pick at runtime), including the platform-specific optional
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
const duckdbTarget =
  DUCKDB_BINDING_TARGETS[`${process.platform}-${process.arch}`] ?? "win32-x64";
const fixDuckdbNativeRequire = {
  name: "fix-duckdb-native-require",
  setup(build: import("bun").PluginBuilder) {
    const target = duckdbTarget;
    build.onLoad(
      { filter: /@duckdb[\\/]node-bindings[\\/]duckdb\.js$/ },
      async () => {
        const contents = `module.exports = require("@duckdb/node-bindings-${target}/duckdb.node");\n`;
        return { contents, loader: "js" as const };
      },
    );
  },
};

// BASED-PACKAGE-WIN: duckdb.node is only a thin N-API shim dynamically linked against a large
// companion library (duckdb.dll / libduckdb.dylib / libduckdb.so) shipped beside it in the
// platform package. Bun's bundler copies the required .node next to the bundle output but not
// its dependent library, so the packaged app fails the first LanceDB/DuckDB query with
// "LoadLibrary failed: The specified module could not be found." Copy the companion next to the
// bundled .node — the OS loader searches the addon's own directory first for its dependents.
// Located by scanning the workspace .bun store directly (version-agnostic prefix match) rather
// than Bun.resolveSync: electrobun's compiled CLI evaluates this config inside a standalone
// binary whose baked-in resolver can't resolve workspace deps from arbitrary parent paths
// ("Cannot find module '@duckdb/node-api'"), and the platform package is a transitive dep of
// core, not of shell, so it has no top-level node_modules entry either.
const DUCKDB_COMPANION_LIBS: Record<string, string> = {
  win32: "duckdb.dll",
  darwin: "libduckdb.dylib",
  linux: "libduckdb.so",
};
function duckdbCompanionLibCopyEntry(): Record<string, string> {
  const lib = DUCKDB_COMPANION_LIBS[process.platform] ?? "duckdb.dll";
  const store = join(import.meta.dir, "../node_modules/.bun");
  const prefix = `@duckdb+node-bindings-${duckdbTarget}@`;
  const entry = readdirSync(store).find((d) => d.startsWith(prefix));
  const libPath = entry
    ? join(store, entry, "node_modules", "@duckdb", `node-bindings-${duckdbTarget}`, lib)
    : null;
  if (!libPath || !existsSync(libPath)) {
    throw new Error(`duckdb companion library not found: ${prefix}*/…/${lib} under ${store}`);
  }
  // electrobun joins copy keys onto the project root, so the key must be relative to shell/.
  return { [relative(import.meta.dir, libPath)]: `bun/${lib}` };
}

export default {
  app: {
    name: "based",
    identifier: "dev.based.app",
    version: "0.1.3",
  },
  build: {
    bun: {
      entrypoint: "src/bun/index.ts",
      plugins: [fixNapiKeyringCreateRequire, fixLibsqlNativeRequire, fixDuckdbNativeRequire],
    },
    views: {
      mainview: {
        entrypoint: "src/mainview/index.ts",
      },
    },
    copy: {
      "src/mainview/index.html": "views/mainview/index.html",
      // BASED-PACKAGE-WIN: ship the built UI inside the bundle (Resources/app/ui/dist) so an
      // installed app serves the real frontend without a repo checkout. findUiDist() in
      // src/bun/index.ts looks here first, relative to bun.exe.
      "../ui/dist": "ui/dist",
      ...duckdbCompanionLibCopyEntry(),
    },
    // On Windows, electrobun 1.18.1's compiled CLI (bin/electrobun.exe) embeds
    // this icon via `require.resolve("rcedit/package.json")` — but since that
    // CLI is itself a Bun-compiled standalone binary, the call resolves against
    // an absolute path baked in at the upstream CI build (`D:\a\electrobun\...`)
    // instead of this project's node_modules. Confirmed still broken on the
    // 1.18.4-beta.6 prerelease too; running the CLI from its own TS source to
    // bypass the compiled binary doesn't work either, since the published npm
    // package omits the `src/shared/*` modules that source imports. See
    // shell/README.md for the (machine-local, session-scoped) workaround.
    win: { bundleCEF: false, icon: "assets/icon.png" },
  },
} satisfies ElectrobunConfig;
