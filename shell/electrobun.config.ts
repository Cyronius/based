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

export default {
  app: {
    name: "based",
    identifier: "dev.based.app",
    version: "0.1.0",
  },
  build: {
    bun: {
      entrypoint: "src/bun/index.ts",
      plugins: [fixNapiKeyringCreateRequire],
    },
    views: {
      mainview: {
        entrypoint: "src/mainview/index.ts",
      },
    },
    copy: {
      "src/mainview/index.html": "views/mainview/index.html",
    },
    win: { bundleCEF: false },
  },
} satisfies ElectrobunConfig;
