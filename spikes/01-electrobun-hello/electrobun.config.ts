import type { ElectrobunConfig } from "electrobun";

export default {
  app: {
    name: "based-spike",
    identifier: "spike.based.dev",
    version: "0.0.1",
  },
  build: {
    bun: {
      entrypoint: "src/bun/index.ts",
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
