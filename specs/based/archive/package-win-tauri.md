# Point Windows packaging at the Tauri shell

## Problem

`scripts/package-win.ps1` still builds the **electrobun** bundle (`electrobun build --env=stable`, rcedit shim, `based-open.exe` stub) and hands that to Inno Setup — so a release build today ships the old shell. Meanwhile the merged Tauri port's own NSIS installer registers separately (different install dir `%LOCALAPPDATA%\based`, different Apps & Features entry) — which is exactly how a machine ends up with two "based" installs, the newer one being electrobun.

## Design

**Keep Inno Setup as the one installer, feed it the Tauri app tree.** The Inno `AppId` (`7E1B62D3-…`) stays unchanged, so installing a new version *upgrades the existing electrobun install in place* — users who have the old app get healed automatically instead of accumulating a second entry. The Tauri NSIS bundler is no longer used for release (`--no-bundle`); the spike's NSIS install on dev machines is a one-time manual uninstall (it was never released).

Verified groundwork (from `shell-tauri/` + the spike memory):

- `tauri-build` copies `bundle.resources` beside the built exe, so after `bundle-core.ts` + a release build, `shell-tauri/target/release/` already holds the installed layout: `based-shell.exe` + `core/` + `ui/` + `bun/` (resource_dir for an installed Tauri app = the exe dir — same shape).
- `main.rs` takes `.sql` paths from argv directly and the single-instance plugin forwards a second launch's argv — the `csc`-compiled `based-open.exe` stub (an electrobun-launcher-drops-argv workaround) is obsolete. `pending-open.txt` consumption is kept in main.rs, so an old stub-registered association keeps working mid-upgrade.
- WebView2Loader is statically linked (the spike NSIS installer shipped only exe + resources and launches fine), so the staging tree needs no extra DLLs.

## Changes

### 1. `scripts/package-win.ps1` — rewrite the build pipeline

1. `bun run build:ui` → `ui/dist` (unchanged)
2. `bun shell-tauri/bundle-core.ts` → `dist-core/{core,ui,bun}` (must run before the cargo build — tauri-build validates `bundle.resources` at compile time)
3. `bun x @tauri-apps/cli build --no-bundle` (cwd `shell-tauri`) → `target/release/based-shell.exe` + resource dirs beside it
4. Stage `installer-staging/`: `based-shell.exe`, `core/`, `ui/`, `bun/`, plus `icon.ico` (from `shell-tauri/icons/icon.ico`); sanity-check `ui/dist/index.html` and `core/index.js` exist
5. `ISCC scripts/installer.iss` → `dist/based-<version>-Setup.exe` (unchanged)

Deleted: the entire rcedit shim (`Ensure-RceditShim`, subst D:), the electrobun build + tar.zst extraction, the `csc` stub compile. Version is read from `shell-tauri/tauri.conf.json` (see §3).

### 2. `scripts/installer.iss` — Tauri paths, no stub

- Launch target `{app}\bin\launcher.exe` → `{app}\based-shell.exe` ([Icons], [Run], WorkingDir `{app}`)
- `.sql` open verb `"{app}\bin\based-open.exe" "%1"` → `"{app}\based-shell.exe" "%1"`
- Everything else (AppId, per-user, non-destructive OpenWithProgids + Default Programs registration, UninstallDelete sweep) stays as is — that's the upgrade-in-place continuity.

### 3. Version source of truth → `shell-tauri/tauri.conf.json`

`scripts/bump-version.ps1` currently rewrites `shell/electrobun.config.ts`. Change it to rewrite the `"version": "x.y.z"` line in `tauri.conf.json` **and** `shell-tauri/Cargo.toml`'s `version` (both carry it today; drifting them breaks the exe's file-version metadata), still emitting `core/src/version.ts`. `package-win.ps1` and `release.ps1`'s dry-run revert hint follow.

### 4. `shell-tauri/tauri.conf.json` — identifier

`"identifier": "dev.based.spike"` is spike-era and feeds the single-instance identity; rename to `"dev.based.app"` **now**, before the first Tauri-based release, so it never has to change again.

### 5. Delete the stub

`scripts/win/based-open.cs` is removed. `main.rs` keeps consuming `pending-open.txt`, so nothing breaks during the one upgrade where an old registration might still fire the (already-uninstalled) stub path.

## Spec impact (all `manual` category)

- **BASED-INSTALLER-WIN** — rewrite build-steps text (Tauri build, no rcedit shim, no csc); version source `shell-tauri/tauri.conf.json`; verification procedure unchanged in substance.
- **BASED-PACKAGE-WIN** — bundle description becomes the Tauri resource layout (`bundle-core.ts`, resources beside exe, duckdb.dll companion copy — the bundler plugins are already ported); the `findUiDist`/electrobun wording goes.
- **BASED-SQL-ASSOC-WIN** — open verb is the app exe directly; the stub rationale paragraph is replaced with "Tauri's exe receives argv" and a note that `pending-open.txt` remains supported for stale registrations.
- **BASED-OPEN-SQL-ARGV** — same argv/pending-open behavior, now native to the shell; stub references removed.

New PASS lines require a human verification pass post-change (install, .sql assoc, upgrade-over-electrobun).

## Out of scope

- Retiring `shell/` (electrobun) entirely — workspace entry, `typecheck` script, `scripts/dev.ts` electrobun Defender patterns. Separate cleanup once a Tauri-based release has shipped.
- Auto-uninstalling the spike's NSIS install from dev machines (never shipped; uninstall by hand).
- Code signing / CI packaging (unchanged status quo).

## Verification (manual, after implementation)

1. `pwsh scripts\package-win.ps1` → `dist/based-<version>-Setup.exe` builds with no electrobun/rcedit/csc steps.
2. On a machine with the old electrobun install: run the installer → **one** "based" entry in Apps & Features, launch shows the Tauri shell (dark titlebar, new icon), old `bin\launcher.exe` tree gone from `{localappdata}\Programs\based`.
3. `.sql` Open With → based listed, opens the file via `based-shell.exe`; existing default handler untouched.
4. `release.ps1 -DryRun` end-to-end: bump writes tauri.conf.json + Cargo.toml + version.ts; installer lands with the bumped version in its filename.
