// tauri.conf.json declares dist-core/{core,ui,bun} as bundle.resources, and tauri-build fails the
// compile outright if any of them is missing — so a clean checkout cannot `cargo run` until
// bundle-core.ts has produced them. That gate is right for a release build and wrong for the dev
// loop: with BASED_DEV_URL set the shell never spawns core, so the resources are never read, and
// requiring a production UI build plus a ~100MB bun.exe copy just to open a window is absurd.
//
// So create the three directories empty and let the compile proceed. Two reasons this cannot
// contaminate a real package: bundle-core.ts opens with rmSync(outRoot) and rebuilds all three from
// scratch, and the release path (package-win.ps1, and this package's own `build` script) always runs
// it first. Note this deliberately does NOT run from build.rs — leaving the missing-resource error
// live for `tauri build` keeps it as the safety net against packaging an unbundled shell.
import { mkdirSync } from "node:fs";
import { join } from "node:path";

for (const dir of ["core", "ui", "bun"]) {
  mkdirSync(join(import.meta.dir, "dist-core", dir), { recursive: true });
}
