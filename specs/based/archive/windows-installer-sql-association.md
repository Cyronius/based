# Windows installer + .sql file association

## Goal

1. A distributable Windows installer for based.
2. based registers as an **available handler** for `.sql` files (shows up in "Open with" and
   Settings → Default apps, user can make it the default) — not a forced default-steal.
3. Double-clicking a `.sql` file opens it in based as a query tab (reusing the running
   instance if there is one).

## Current state (findings)

- Shell is **Electrobun 1.18.1** ([shell/electrobun.config.ts](../../../shell/electrobun.config.ts)).
  `electrobun build --env=stable` produces a self-extracting `Setup.exe` + `.tar.zst`, wrapped in a
  zip. Strings in `extractor.exe` show it installs to `%LOCALAPPDATA%`, creates Start
  Menu/Desktop shortcuts via PowerShell, and writes an **uninstall `.reg` file the user must
  double-click manually** — no real Apps & Features entry, and `UninstallString` is a bare
  `rmdir /s /q`.
- Electrobun's `fileAssociations` config is **macOS-only** (CLI gates on
  `targetOS === "macos"`, generating CFBundleDocumentTypes). No Windows registry support.
- The Windows installer icon-embed path hits the same upstream `require.resolve("rcedit")` bug
  documented in [shell/README.md](../../../shell/README.md).
- `launcher.exe` spawn format string is `"{s}" "{s}"` (bun.exe + main.js — two slots), so **it
  likely does NOT forward its own argv to the bun process**. Must be verified empirically; this
  is the one real risk (see Decision gate below).
- The packaged app is currently **incomplete**: `build.copy` only copies
  `src/mainview/index.html`. The core server's `staticDir` comes from `findUiDist()`
  ([shell/src/bun/index.ts:10](../../../shell/src/bun/index.ts#L10)) which walks up from cwd
  looking for `ui/dist` — present in the dev repo, absent from an installed bundle. A packaged
  install today would show the bare core page.
- Single-instance ([shell/src/bun/singleInstance.ts](../../../shell/src/bun/singleInstance.ts))
  already has a localhost control server (`/new-window`) — natural place to forward a file path
  from a second launch.
- Tabs already have `filePath` ([core/src/storage/tabs.ts](../../../core/src/storage/tabs.ts))
  and `/api/file/save-sql` exists. The read endpoint + in-app open flow now exist too
  (BASED-FILE-OPEN-SQL: `/api/file/open-sql`, Ctrl+O, `openSqlFile()` in the ui store) — the
  argv flow reuses them.

## Approach: Inno Setup wrapping the electrobun stable build

Use **Inno Setup** (winget `JRSoftware.InnoSetup`) rather than electrobun's built-in Setup.exe:

- Real per-user installer (`PrivilegesRequired=lowest`, no UAC), Start Menu shortcut, proper
  Apps & Features uninstall entry, and clean removal of registry keys on uninstall.
- `[Registry]` section handles the `.sql` association — the thing electrobun can't do on
  Windows at all.
- Sidesteps electrobun's broken rcedit icon-embed for the installer exe (Inno embeds its own
  `SetupIconFile`).
- Same route VS Code takes; well understood.

Alternative considered and rejected: electrobun's own Setup.exe — no association support, no
real uninstall entry, and we'd still need a post-install registry step somewhere.

Electrobun's auto-updater (bsdiff channels) is tied to its own extractor layout; adopting it
later would mean revisiting this. Auto-update is explicitly **out of scope** here.

## Spec impact — new requirements

### BASED-PACKAGE-WIN: Packaged app bundle is self-contained
**Applies to:** based (shell)
**Test category:** manual

`electrobun build --env=stable` output includes the built `ui/dist` (via `build.copy` in
`electrobun.config.ts`), and the shell locates it inside the bundle — an installed app serves
the real UI with no repo checkout present.

**Acceptance criteria:**
- Launching the installed app (repo absent) renders the full UI, not the bare core page.

### BASED-INSTALLER-WIN: Windows installer
**Applies to:** based (repo `scripts/`)
**Test category:** manual

A packaging script produces `dist/based-<version>-Setup.exe` (Inno Setup). Installs per-user to
`{localappdata}\Programs\based`, creates a Start Menu shortcut, registers an Apps & Features
uninstall entry. Uninstall removes the app directory, shortcuts, and all registry keys written
at install; user data (`app.db`, `agent.db`, secrets) is left in place.

**Acceptance criteria:**
- Install on a machine without the repo → app launches from Start Menu.
- Appears in Settings → Apps; uninstall removes install dir + registry keys, keeps user data.

### BASED-SQL-ASSOC-WIN: .sql "Open with" registration
**Applies to:** based (installer)
**Test category:** manual

The installer registers (all under HKCU):
- ProgID `based.sql` — friendly name, `DefaultIcon`, `shell\open\command = "<launcher>" "%1"`.
- `Software\Classes\.sql\OpenWithProgids\based.sql` (adds to Open With without stealing the
  user's current default).
- `Software\based\Capabilities` (+ `FileAssociations: .sql=based.sql`) and
  `Software\RegisteredApplications\based` so based appears in Settings → Default apps.

**Acceptance criteria:**
- Right-click a `.sql` → Open with → based is listed and opens the file.
- based is offered for `.sql` in Settings → Default apps; existing default is untouched by install.
- After uninstall, based no longer appears in Open with / Default apps.

### BASED-OPEN-SQL-ARGV: Opening a .sql path at launch
**Applies to:** based (shell, core, ui)
**Test category:** e2e (manual procedure) — plus `integration` for the read endpoint below

Launching the app with an existing `.sql` file path argument opens a window whose active tab is
a query tab titled with the file's basename, `filePath` set, content loaded from disk. If an
instance is already running, the second launch forwards the path to the primary (new window in
the running instance) and exits.

**Acceptance criteria (manual procedure):**
1. Double-click a `.sql` file with based not running → app starts, tab shows file content.
2. Double-click another `.sql` with based running → new window in the same instance, no second
   process, no `app.db` contention.

### ~~BASED-FILE-READ-SQL~~ — superseded by BASED-FILE-OPEN-SQL (already shipped)

The read endpoint now exists as `POST /api/file/open-sql { path? }` (BASED-FILE-OPEN-SQL in
`spec.md`): explicit `path` skips the dialog and returns `{ path, content }`, strips a UTF-8
BOM, rejects missing files (400) and files over 2 MB. The argv/launch flow should call it with
the explicit path — no new endpoint needed.

## Implementation steps

1. **Bundle completeness (BASED-PACKAGE-WIN)** — add `"../ui/dist" → "ui/dist"`-style entries
   to `build.copy` in [shell/electrobun.config.ts](../../../shell/electrobun.config.ts) (copy
   the dist tree; verify whether electrobun's `copy` handles directories — if file-only, add a
   prebuild step in the packaging script). `findUiDist()`'s cwd walk-up should then find it at
   iteration 0; verify, and prefer an explicit bundle-relative check first.

2. **Decision gate: launcher argv forwarding.** Build stable, run
   `<bundle>\bin\launcher.exe C:\tmp\test.sql`, log `process.argv` from the shell.
   - Forwarded → association command targets `launcher.exe "%1"` directly (clean path).
   - Not forwarded → file an upstream issue; interim: register the association command as
     `"<bundle>\bin\bun.exe" "<bundle>\...\main.js" "%1"` **only if** running main.js under bare
     bun works outside the launcher, else ship a minimal GUI-subsystem stub exe that re-execs
     launcher and posts the path to the control server. Decide at the gate; don't build the
     stub speculatively.

3. **Shell argv + forwarding (BASED-OPEN-SQL-ARGV)** — in
   [shell/src/bun/index.ts](../../../shell/src/bun/index.ts): parse trailing argv for an
   existing `.sql` path; thread `openPath` through `createWindow` → window URL hash
   (`&open=<encodeURIComponent(path)>`). In `singleInstance.ts`: add `POST /open-file
   { path }` to the control server; a secondary launch with a path calls it (falls back to
   `/new-window` when pathless).

4. **Core endpoint** — done: `/api/file/open-sql` (BASED-FILE-OPEN-SQL) already exists with an
   explicit-path mode and integration tests; reuse it.

5. **UI boot handling (BASED-OPEN-SQL-ARGV)** — where the UI parses the hash
   (token/sid), also read `open`; after store init, call open-sql with the path and create a query tab
   (`kind: "query"`, title = basename, `filePath`, content), make it active. Strip `open` from
   the hash after handling so a reload doesn't duplicate the tab (tab is persisted via
   TabStore anyway).

6. **Packaging script** — `scripts/package-win.ps1` (or `.ts`): `bun run build:ui` →
   `electrobun build --env=stable` (from `shell/`) → convert `assets/icon.png` to `.ico`
   (png-to-ico is already in the tree) → `ISCC.exe scripts/installer.iss` → `dist/`. Fail
   loudly if ISCC is missing, with the winget install hint.

7. **Inno script** — `scripts/installer.iss` with `[Registry]` per BASED-SQL-ASSOC-WIN
   (`uninsdeletekey` on every key so uninstall is clean), `[Icons]` Start Menu entry,
   `SetupIconFile`, version pulled from `electrobun.config.ts` (parameterized via
   `/D` defines from the packaging script). Exact exe names/layout inside the stable bundle
   confirmed at step 2.

8. **Spec + archive** — merge the five requirements into `spec.md` with the manual
   procedures, move this plan to `archive/`.

## Out of scope

- Auto-update (electrobun channels or otherwise).
- macOS/Linux packaging (electrobun's `fileAssociations` covers macOS when that day comes).
- ~~An in-app "Open file…" menu action~~ — shipped (BASED-FILE-OPEN-SQL: Ctrl+O / toolbar "Open…").
- Fixing the upstream rcedit icon bug for `launcher.exe` itself (documented workaround stands).

## Risks

- **Launcher argv forwarding unknown** — gated at step 2 with fallbacks listed; worst case is a
  tiny stub exe.
- **Electrobun `copy` semantics for directories** — if file-only, the packaging script stages
  `ui/dist` into the bundle after `electrobun build` instead.
- **Bundle layout drift across electrobun versions** — installer references exe paths; pin
  electrobun (already exact-pinned at 1.18.1).

---

## Outcome (2026-07-25, implemented)

- Decision gate resolved: launcher.exe does NOT forward argv (verified empirically — spawns
  `bun.exe main.js` with exactly two args). Shipped the stub: `scripts/win/based-open.cs`
  (winexe, compiled at package time with .NET Framework csc) + `pending-open.txt` hand-off +
  `BASED_STUB_OPEN=1` blank-window suppression.
- Stable build wrinkle: `electrobun build --env=stable` leaves only the self-extractor package
  on disk; the runnable tree is extracted from `based-Setup.tar.zst` (Windows bsdtar) by
  `scripts/package-win.ps1` before ISCC runs.
- Requirements merged into spec.md as BASED-PACKAGE-WIN, BASED-INSTALLER-WIN,
  BASED-SQL-ASSOC-WIN, BASED-OPEN-SQL-ARGV (BASED-FILE-READ-SQL was superseded by the
  already-shipped BASED-FILE-OPEN-SQL). End-to-end verified on a real install; remaining
  human-pass items are recorded per requirement.
