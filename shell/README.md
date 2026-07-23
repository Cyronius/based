# shell

Electrobun-based native shell. Thin and disposable — see `src/bun/index.ts` for the
window/server wiring.

## Known issues

### Windows: app icon doesn't embed (`electrobun dev` / `electrobun build`)

**Symptom:** build output includes

```
Embedding icon into launcher.exe: C:\code\based\shell\assets\icon.png
Warning: Failed to embed icon into launcher.exe: ResolveMessage: Cannot find module
'D:\a\electrobun\electrobun\package\node_modules\rcedit\package.json' from 'B:\~BUN\root\electrobun'
```

and the taskbar/window icon falls back to Electrobun's own default instead of
`assets/icon.png`.

**Cause:** upstream bug in electrobun 1.18.1's Windows CLI. `bin/electrobun.exe` is
itself a Bun-compiled standalone binary (downloaded from GitHub releases by
`bin/electrobun.cjs`, not built from this repo). Its icon-embed step does
`require.resolve("rcedit/package.json")`, and inside a Bun-compiled binary that
resolves against an absolute path baked in at the *upstream* CI build
(`D:\a\electrobun\electrobun\package\node_modules\rcedit\...`) rather than doing
real resolution against this project's `node_modules` — where `rcedit` is in fact
correctly installed. Since drive `D:` doesn't exist locally, resolution fails.

Checked and ruled out:
- The `1.18.4-beta.6` prerelease — same bug, unfixed there too.
- Running electrobun's CLI from its own TS source (`node_modules/electrobun/src/cli/index.ts`)
  via `bun`, to bypass the broken compiled binary entirely — doesn't work because the
  published npm package only ships `src/cli/`, not the sibling `src/shared/*` modules
  that source imports (`platform`, `naming`, `bun-version`, etc.), so it can't run
  standalone.

**Workaround (machine-local, session-scoped):** trick the compiled binary's broken
resolution by mapping a virtual `D:` drive to a folder that mirrors the exact baked
path, containing a minimal `rcedit` stub (just `package.json` + `bin/rcedit-x64.exe`,
copied from the real installed `rcedit` package — electrobun only shells out to the
binary, it never actually loads rcedit's JS).

```sh
# One-time setup — build the shim
SHIM_ROOT="/c/Users/<you>/.electrobun-rcedit-shim"
TARGET="$SHIM_ROOT/a/electrobun/electrobun/package/node_modules/rcedit"
mkdir -p "$TARGET/bin"
SRC="$(find /c/code/based/node_modules/.bun -maxdepth 1 -iname 'rcedit@*' | head -1)/node_modules/rcedit"
cp "$SRC/package.json" "$TARGET/package.json"
cp "$SRC/bin/rcedit-x64.exe" "$TARGET/bin/rcedit-x64.exe"
cp "$SRC/bin/rcedit.exe" "$TARGET/bin/rcedit.exe"

# Every session (subst does not survive a reboot)
subst D: C:\Users\<you>\.electrobun-rcedit-shim
```

Then `electrobun dev`/`build` embeds the icon successfully. To undo: `subst D: /D`.

This is local-machine-only — not committed anywhere, and doesn't help other devs or
CI building on Windows; they'll hit the same electrobun bug until upstream fixes it.
Worth filing an issue against `blackboardsh/electrobun` if it's still broken next time
you check.

### Windows: taskbar icon still stale after fixing the above

Even with the exe icon and favicon both correct on disk, Windows can keep showing
the old icon in the taskbar — it caches icons per app identity (AUMID) independently
of the exe file or window content. If a rebuild + relaunch doesn't update it:

```sh
taskkill //F //IM explorer.exe
cmd.exe //c "del /A /Q %LOCALAPPDATA%\Microsoft\Windows\Explorer\iconcache*.db"
cmd.exe //c "if exist %LOCALAPPDATA%\IconCache.db del /A /Q %LOCALAPPDATA%\IconCache.db"
cmd.exe //c "start explorer.exe"
```

Briefly flickers the desktop and closes/reopens Explorer windows; doesn't affect
other running apps.

### `electrobun dev` fails with `EACCES: permission denied, rm 'shell\build\dev-win-x64'`

A previous `based-dev` run is still alive and holding the build folder open — the
Electrobun `launcher.exe` parent can die (e.g. from a truncated/killed terminal)
while the spawned `based-dev\bin\bun.exe` core process keeps running detached. Find
and kill it:

```powershell
Get-CimInstance Win32_Process -Filter "Name='bun.exe'" |
  Where-Object { $_.CommandLine -like '*based-dev*' } |
  Select-Object ProcessId,CommandLine
```

then `taskkill //F //PID <pid>` and retry.
