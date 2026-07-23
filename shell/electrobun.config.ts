import type { ElectrobunConfig } from "electrobun";
import { readFile } from "node:fs/promises";

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

export default {
  app: {
    name: "based",
    identifier: "dev.based.app",
    version: "0.1.0",
  },
  build: {
    bun: {
      entrypoint: "src/bun/index.ts",
      plugins: [fixNapiKeyringCreateRequire, fixLibsqlNativeRequire],
    },
    views: {
      mainview: {
        entrypoint: "src/mainview/index.ts",
      },
    },
    copy: {
      "src/mainview/index.html": "views/mainview/index.html",
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
