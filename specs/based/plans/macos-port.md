# Plan: macOS port + CI release pipeline

**Status:** in progress — **Phases 1–3 complete** (`BASED-PLATFORM-PATHS` merged into `spec.md`;
macOS build workflow landed and green, `.dmg` artifact produced; dialogs moved into the shell as
`BASED-DIALOG-CHANNEL`)
**Spec impact:** 7 new requirements (`BASED-PLATFORM-PATHS` ✅, `BASED-DIALOG-CHANNEL` ✅,
`BASED-MENU-MAC`,
`BASED-WINDOW-LIFECYCLE-MAC`, `BASED-PACKAGE-MAC`, `BASED-INSTALLER-MAC`, `BASED-RELEASE-CI`),
8 modified (`BASED-SECRET-STORE`, `BASED-DIALOG-OPEN-FILE`, `BASED-FILE-OPEN-SQL`,
`BASED-SAVE-FILE-WRITER`, `BASED-UI-SHORTCUTS`, `BASED-OPEN-SQL-ARGV`, `BASED-DEV-CLEAN-SHUTDOWN`,
`BASED-SQL-ASSOC-WIN` → cross-reference only)

## Problem

based is Windows-only, and most prospective users are on macOS.

The architecture is already portable — the shipping shell is Tauri (Rust + WKWebView on macOS),
core is a Bun child process reached over loopback HTTP, and the UI is a Vite React app that never
touches Tauri IPC. There is no Electron-native code, no COM, no P/Invoke. The Windows coupling is
concentrated in five places, listed in Phases 1–5 below.

A second problem surfaces alongside it: **releases are built by hand on one Windows machine.**
[`scripts/release.ps1`](../../../scripts/release.ps1) does bump → verify → build → changelog → tag →
publish in a single local pass, which depends on Inno Setup and the Rust toolchain being installed
on that machine. Adding a second platform to a manual pipeline doubles the manual work, so the
pipeline moves to CI as part of this plan rather than after it.

## Decisions taken before this plan

Recorded here because each one removes work that an earlier draft of this port carried.

| Decision | Consequence |
|---|---|
| **arm64 only** | macOS Tahoe 26 is Apple's last Intel release. No universal binary, no second CI runner, no target-parameterizing of `bundle-core.ts` — the build host *is* the target. |
| **Unsigned** | No Apple Developer account, no hardened-runtime fight with Bun's JIT and the bundled `.node` addons. Cost is a worse first-run experience, mitigated below. |
| **Homebrew tap as the primary install path** | `brew install --cask based --no-quarantine` skips Gatekeeper entirely, so unsigned costs nothing for users who install this way. A `.dmg` on the releases page (plus an `xattr -cr` note) covers everyone else. |
| **GitHub Actions builds both platforms** | macOS CI runners are real Mac hardware; no Mac is required to *ship*. Free for public repos. The Mac mini becomes a debugging box, not release infrastructure. |
| **`shell/` (electrobun) is not ported** | It is vestigial — [`package-win.ps1`](../../../scripts/package-win.ps1) builds `shell-tauri`. Porting it would double every shell change in this plan for no shipped benefit. |

## Approach

Seven phases. Phase 2 deliberately produces a **broken but building** macOS app before any porting
work is done, so the toolchain risk (Bun + Rust + native `.node` prebuilds + DMG bundling on a CI
runner) is discovered on day two rather than day nine. Phases 1 and 2 need no Mac and no CI
credentials; Phase 7 is the only one that requires hands on hardware.

---

### ✅ Phase 1 — Platform abstraction (done)

Three hardcoded Windows assumptions, all mechanical. Shipped as `BASED-PLATFORM-PATHS` plus
per-platform process handling in the dev script.

**1a. Data directory.** `appDataRoot(platform?, env?)` added to
[`core/src/storage/db.ts`](../../../core/src/storage/db.ts) — `%APPDATA%` on Windows,
`~/Library/Application Support` on macOS — and consumed by `dataDir()` and
[`core/src/dev.ts`](../../../core/src/dev.ts). Both parameters are injectable so each branch is
unit-testable from either host; the packaged app only ever exercises one.
[`main.rs`](../../../shell-tauri/src/main.rs) `data_dir()` mirrors it in Rust via `cfg!` (not
`#[cfg]`, so both branches type-check everywhere). Covered by
[`unit.platformPaths.test.ts`](../tests/unit.platformPaths.test.ts) — 5 tests.

**1b. Bun runtime filename.** [`bundle-core.ts`](../../../shell-tauri/bundle-core.ts) writes
`bun.exe` or `bun` by host platform and `chmod 0o755`s it on POSIX (insurance against a lost exec
bit in a DMG or artifact-zip round-trip — the failure mode is an opaque "permission denied" at
launch). `main.rs` reads the same name from a `BUN_EXE` const. The duplicated duckdb companion-lib
map was hoisted to one `DUCKDB_COMPANION_LIBS` const; it had been spelled out twice, which is
exactly the kind of duplication a port breaks.

Unchanged on purpose: `DUCKDB_BINDING_TARGETS` / `LIBSQL_NEON_TARGETS` already carried correct
`darwin-arm64` entries, and the `${process.platform}-${process.arch}` host lookup is right *because*
we build on the target. A header comment now says so, since it otherwise reads like an oversight.

**1c. Dev-script process cleanup.** [`scripts/dev.ts`](../../../scripts/dev.ts) branched at
`killTree` (`taskkill /T` ↔ depth-first `pgrep -P` walk — POSIX has no tree-kill, and killing a
parent first reparents its children to launchd where no ancestry query can find them),
`killOrphanedShellProcesses` (`Get-CimInstance` ↔ `pkill -f`), and `freeDevPorts`
(`Get-NetTCPConnection` ↔ `lsof -ti`).

**Verified:** 605 pass / 0 fail, `bun run typecheck` clean, `cargo check` clean, and a full
`build:ui` + `bundle-core.ts` on Windows still emits `bun.exe`, `duckdb.dll`, and all four native
addons.

---

### ✅ Phase 2 — First macOS build in CI (done)

Get `tauri build` to *complete* on a macOS runner. The resulting app is expected to launch and then
misbehave (no menu, PowerShell dialogs throw, Ctrl shortcuts) — that is fine. This phase is about
proving the toolchain, not the app.

Shipped:

- [`.github/workflows/build-macos.yml`](../../../.github/workflows/build-macos.yml),
  `workflow_dispatch`-triggered: checkout → `oven-sh/setup-bun` → `dtolnay/rust-toolchain@stable` →
  `Swatinem/rust-cache` → `bun install` → `bun run build:ui` → `bun bundle-core.ts` → **verify
  bundle layout** → `bun x @tauri-apps/cli build` → upload the `.dmg`.
- The verify step is an addition to the original sketch: it asserts `libduckdb.dylib`,
  `ui/dist/index.html`, `core/index.js`, and an **executable** `bun/bun` before the Tauri build, so
  a Phase 1 regression fails at the runner with a named file rather than as a dead app later.
- [`tauri.conf.json`](../../../shell-tauri/tauri.conf.json): `bundle.targets` → `["nsis", "dmg"]`,
  `bundle.macOS.minimumSystemVersion` → `11.0`, and the `icon` array widened from `icon.ico` alone
  to the full per-platform set.
- `runs-on: macos-latest` rather than a pinned image — `macos-14` risks 404ing as GitHub retires
  images, and Phase 2 only needs to prove the build. **Phase 6 must pin it** for reproducible
  releases.
- `bun install` is deliberately *not* `--frozen-lockfile`: `bun.lock` was written on Windows and
  this is the first darwin resolve. Tighten in Phase 6 once a macOS install is known-good.

Already done, contrary to the original sketch: `icons/icon.icns` and the whole Tauri icon set were
generated at some earlier point. No `tauri icon` run was needed.

**Windows regression check:** adding `"dmg"` cannot affect the Windows release —
`package-win.ps1` passes `--no-bundle`, so `bundle.targets` is never consulted there. The widened
`icon` array *is* read by `tauri-build` on both platforms, which is why the release build was
re-run after the change rather than only `cargo check`.

**Exit criterion (met):** [run 31622051229](https://github.com/Cyronius/based/actions/runs/31622051229)
was green in 5m07s and uploaded a 76 MB `based-macos-arm64` `.dmg`. Nothing on the runner needed a
darwin-specific workaround — every native prebuild resolved, the `.bun` store layout matched, and
DMG bundling worked on the stock image. The toolchain risk this phase existed to surface did not
materialize.

The `.dmg` has **not** been launched on a Mac. It is not expected to work yet; that is Phase 7.

The workflow's temporary `push: branches: [macos_port_wip]` trigger was removed once the run had
served its purpose, leaving `workflow_dispatch` as the sole trigger described in its header.

---

### ✅ Phase 3 — Native dialogs (done)

[`core/src/dialogs.ts`](../../../core/src/dialogs.ts) was the single genuinely Windows-locked source
file: all four exports shelled out to `powershell.exe` with WinForms
(`SaveFileDialog` / `OpenFileDialog` / `FolderBrowserDialog`) or to `cmd.exe /c start`.

**Design (2) was taken** — dialogs moved into the Tauri shell — over design (1), an `osascript`
sibling branch. What settled it was the Linux port ([`linux-port.md`](linux-port.md)): design (1)
would have needed a *third* branch (`zenity`/`kdialog` plus `xdg-open`) and a runtime dependency on
a dialog binary that is not guaranteed present, while (2) covers all three targets at once. It also
retires code the spec had to apologize for.

Shipped as the new **`BASED-DIALOG-CHANNEL`** requirement:

- `core/src/dialogs.ts` is now a broker, not a subprocess launcher. `requestDialog()` queues a
  `{ id, kind, … }` request and awaits an answer; `filterFor()` returns
  `{ name, extensions[] }[]` (mirroring `tauri-plugin-dialog`'s `add_filter`) instead of a
  pipe-delimited WinForms filter string.
- Two routes carry it, behind the existing token auth: `GET /api/shell/dialog/next` (long-poll,
  `204` when idle) and `POST /api/shell/dialog/result`.
- [`main.rs`](../../../shell-tauri/src/main.rs) gained `start_dialog_worker`, a background thread
  that polls, draws the picker with `tauri-plugin-dialog`'s **blocking** API (correct precisely
  because it is not the main thread), and posts the answer back.
  `openWithDefaultApp` became `tauri-plugin-opener`.

**HTTP rather than the `BASED_EVENT` stdout protocol** — the design detail worth remembering. In
dev, `scripts/dev.ts` starts core, so the shell is *not* core's parent and has no stdout to read.
Loopback HTTP is the only channel that exists in both dev and packaged runs.

The core-facing API (`POST /api/dialog/open-file`, `/api/file/open-sql`, `/api/file/save-sql`) is
unchanged, so the UI needed no edits.

**Two consequences, both accepted:**

1. The `dev:core` + `dev:ui` browser loop has no native pickers — nothing is attached to draw them.
   Those routes answer with a named error naming the explicit-path alternative rather than hanging.
   Documented in [`docs/development.md`](../../../docs/development.md).
2. The "shell holds no app logic" invariant now has exactly one exception, noted in
   [`docs/architecture.md`](../../../docs/architecture.md). A file picker is a windowing-system
   concern and the shell is the only process with a window.

**Verified:** `cargo check` clean, 621 pass / 0 fail (up from 606), and a new
[`integration.dialogChannel.test.ts`](../tests/integration.dialogChannel.test.ts) plays the shell's
part — 11 tests covering both routes, all four kinds, cancel, the no-shell error, duplicate and
unknown result ids, and auth. That turns what was a `manual` requirement into a real `integration`
one; only "does the picker widget actually appear" stays manual, on the Phase 7 checklist.

**Still open from this phase:** `resolveDownloadDir()` in `core/src/files/saveFile.ts`
(`BASED-SAVE-FILE-WRITER`) — verify it resolves the Downloads folder from `$HOME` on macOS rather
than `USERPROFILE`, and that its temp-dir fallback is right. (The Linux plan additionally wants XDG
user-dirs there, since a localized desktop has no `~/Downloads`.)

---

### Phase 4 — macOS UX conventions (2.5 d)

**4a. The app menu (must-do, easy to miss).** Tauri on macOS with no menu means **Cmd+C / Cmd+V /
Cmd+X / Cmd+A do not work anywhere in the webview** — WKWebView routes edit commands through the
menu bar. An app with a working query editor and broken copy/paste will read as fundamentally
broken. Requires a real `Menu` with the standard App / Edit / Window submenus, plus based's own
items wired to the same actions as the shortcut table.

**4b. Modifier keys.** 14 `e.ctrlKey` checks in
[`App.tsx`](../../../ui/src/App.tsx#L136-L190) plus 29 hardcoded `"Ctrl+"` label strings across the
UI. Introduce a platform helper — `isAccel(e)` returning `e.metaKey || e.ctrlKey`, and an
`accelLabel()` formatter emitting `⌘` or `Ctrl`. The `BASED-UI-SHORTCUTS` table gains a macOS
column; the help tab (`BASED-HELP-DOCS`) renders whichever applies. Mechanical, but it touches many
files and the tooltip discoverability rule means every advertised shortcut string is in scope.

Watch for collisions: Cmd+W (close tab) and Cmd+Q (quit) have OS-level meaning on macOS, and Ctrl+N
→ Cmd+N must not fight the menu's New Window item.

**4c. Window and dock lifecycle.** The current `RunEvent::Exit` handler in
[`main.rs`](../../../shell-tauri/src/main.rs) kills the core child — correct on Windows, wrong on
macOS, where closing the last window should leave the app running. Needs `RunEvent::ExitRequested`
with `api.prevent_exit()` on macOS, plus `RunEvent::Reopen` to create a window when the dock icon is
clicked.

**4d. File-open events.** `BASED-OPEN-SQL-ARGV` assumes argv, which is a Windows/Linux convention.
**macOS delivers file-open requests as Apple Events, not argv** — double-clicking a `.sql` file will
not populate `std::env::args()`. Tauri surfaces these as `RunEvent::Opened { urls }`. The argv path
and the `pending-open.txt` mechanism both stay for Windows; macOS gets the event handler routed into
the same `create_window(app, None, Some(path))` call.

---

### Phase 5 — Packaging and distribution (1.5 d)

**5a. DMG.** Unlike Windows there is no staging step to hand-roll — Tauri places `bundle.resources`
into `based.app/Contents/Resources` natively, and `resource_dir()` returns that path, so
`spawn_core()`'s existing packaged-layout lookup works as-is. Configure DMG window
background/layout in `tauri.conf.json` if desired; the default is acceptable.

**5b. `.sql` association.** The Windows path is HKCU registry keys written by
[`installer.iss`](../../../scripts/installer.iss). macOS is `CFBundleDocumentTypes` in `Info.plist`,
declared via `tauri.conf.json`'s `bundle.macOS` config, with `LSHandlerRank: Alternate` so we
register as an available handler without stealing the user's existing default — matching the
non-destructive stance `BASED-SQL-ASSOC-WIN` already takes.

**5c. Homebrew tap.** A `homebrew-based` repo containing `Casks/based.rb` pointing at the release
DMG. Bumped by the release workflow (Phase 6) so it never drifts from the latest tag. README install
section gains the macOS block:

```bash
brew tap cyronius/based
brew install --cask based --no-quarantine
```

**5d. Unsigned-install documentation.** For DMG downloaders, Gatekeeper shows *"'based' is damaged
and can't be opened"*, and since macOS 15 the Control-click → Open bypass no longer works — the
route is System Settings → Privacy & Security → Open Anyway, or `xattr -cr /Applications/based.app`.
This must be in the README and the release notes template, worded as clearly as the existing
SmartScreen note in [`release.ps1`](../../../scripts/release.ps1).

One consequence worth noting: quarantined unsigned apps are subject to **App Translocation** (run
from a randomized read-only path). `resource_dir()` stays self-consistent under translocation and
all writes go to `~/Library/Application Support`, so this should be harmless — but it is on the
Phase 7 checklist because "should be" is doing work in that sentence. The Homebrew path avoids it
entirely.

---

### Phase 6 — Release pipeline (1 d)

Split [`release.ps1`](../../../scripts/release.ps1) at the build boundary:

| Stays local | Moves to CI (tag-triggered) |
|---|---|
| bump ([`bump-version.ps1`](../../../scripts/bump-version.ps1), unchanged — `tauri.conf.json` remains the version source of truth), changelog draft + edit, commit, tag, push | typecheck, tests, Windows build (Inno Setup via `winget`), macOS build, checksum, `gh release create` with both artifacts, Homebrew cask bump |

`.github/workflows/release.yml` on `push: tags: ['v*']`, two jobs (`windows-latest`,
`macos-14`), both uploading to the same release.

Secondary benefit: Windows releases become reproducible. Today they depend on whatever happens to be
installed on one machine — [`docs/development.md`](../../../docs/development.md) says as much, and
records "moving to GitHub Actions is tracked as future work." This closes that.

**Cost: $0.** Standard runners, including macOS, are free for public repositories.

---

### Phase 7 — Verification on the Mac mini (1–3 d, the real unknown)

Everything above is estimable. This is not. The three heaviest UI components have never run in
WKWebView:

- **deck.gl** (`@deck.gl/core`, `@deck.gl/layers`) — the Embeddings Atlas, WebGL
- **glide-data-grid** — every result grid, canvas-rendered
- **Monaco** + `monaco-vim` — the editor, and its own keybinding layer, which interacts with 4b

Plus: CSS scrollbar styling (`::-webkit-scrollbar` works in WKWebView, but sizing differs), font
stack, and `streamdown`/`mermaid` rendering.

Also in this phase, the manual verification procedures the spec requires for the new and modified
requirements: install from DMG **and** from the tap, `.sql` association, keychain round-trip
(including a 1704-character PEM), a LanceDB query to exercise the DuckDB native stack, window
restore, and the dock-reopen behavior.

---

## Spec impact

**New requirements:**

- ✅ **`BASED-PLATFORM-PATHS`** (core + shell-tauri, unit) — per-platform data directory, and the
  obligation that the TS and Rust implementations agree. **Merged into `spec.md`.** (Later extended
  with the Linux/XDG branch by [`linux-port.md`](linux-port.md) Phase 1.)
- ✅ **`BASED-DIALOG-CHANNEL`** (core + shell-tauri, integration) — the shell draws every native
  picker; core requests one over loopback HTTP. Added in Phase 3, not in the original sketch, which
  assumed the dialog change would only reword `BASED-DIALOG-OPEN-FILE`. It needs its own requirement
  because the wire protocol, the no-shell failure mode, and the fire-and-forget `open-path` kind are
  all behavior a stakeholder would file a bug about. **Merged into `spec.md`.**
- **`BASED-MENU-MAC`** (shell-tauri, manual) — the macOS menu bar, and specifically that webview
  edit commands work because of it.
- **`BASED-WINDOW-LIFECYCLE-MAC`** (shell-tauri, manual) — close ≠ quit, dock reopen, core child
  outlives the last window.
- **`BASED-PACKAGE-MAC`** (shell-tauri, manual) — `.app` bundle is self-contained; sibling to
  `BASED-PACKAGE-WIN`, same verification shape (run from a path with no repo checkout; LanceDB query
  exercises the DuckDB companion `libduckdb.dylib`).
- **`BASED-INSTALLER-MAC`** (repo, manual) — DMG + Homebrew cask, unsigned-install path documented,
  `.sql` association via `CFBundleDocumentTypes` at `LSHandlerRank: Alternate`.
- **`BASED-RELEASE-CI`** (repo, manual) — tag-triggered two-platform build and publish; local
  release script owns only bump/changelog/tag.

**Modified:**

- ✅ **`BASED-SECRET-STORE`** — **merged into `spec.md`.** Retitled "Secrets in the OS keychain";
  body now says Credential Manager / macOS Keychain behind one `@napi-rs/keyring` API. The
  2560-byte blob cap and the UTF-16 halving are restated as **Credential Manager limits, not
  Keychain limits**, applied on both platforms so one entry format reads back anywhere; the
  legacy-blob upgrade path is called out as Windows-only history. No code change was needed — only
  comments, the test's describe title, and the docs (README, `docs/architecture.md`,
  `docs/development.md`, `docs/local-models.md`). The on-hardware round-trip stays a Phase 7 item.
- ✅ **`BASED-DIALOG-OPEN-FILE`**, **`BASED-FILE-OPEN-SQL`** — **merged into `spec.md`.** Both now
  say "native open-file picker (BASED-DIALOG-CHANNEL)" rather than "PowerShell WinForms"; endpoint
  contracts unchanged. `BASED-DIALOG-OPEN-FILE` stays `manual`, but only for the widget itself —
  its verification note now points at the channel's integration test for the round trip.
- **`BASED-SAVE-FILE-WRITER`** — `resolveDownloadDir` resolution on macOS. Extension whitelist is
  unchanged (`.exe`/`.ps1` etc. stay refused regardless of platform — the caller is still the model).
- **`BASED-UI-SHORTCUTS`** — binding table gains macOS modifiers; discoverability rule now requires
  tooltips to show the *platform-correct* accelerator.
- **`BASED-OPEN-SQL-ARGV`** — argv remains the Windows mechanism; macOS uses `RunEvent::Opened`.
  Retitle to drop the argv-specific framing.
- ✅ **`BASED-DEV-CLEAN-SHUTDOWN`** — per-platform orphan cleanup **implemented in Phase 1**; the
  requirement text still needs its Windows-only wording updated (deferred to the Phase 7 spec sweep,
  since the macOS path is unverifiable until then).
- **`BASED-SQL-ASSOC-WIN`** — cross-reference to `BASED-INSTALLER-MAC` only; no behavior change.

## Effort

| Phase | Est. | Mac needed? |
|---|---|---|
| ~~1 — Platform abstraction~~ | ~~0.5 d~~ **done** | no |
| ~~2 — First CI build~~ | ~~1 d~~ **done** | no |
| ~~3 — Native dialogs~~ | ~~2 d~~ **done** | no (verify in 7) |
| 4 — macOS UX conventions | 2.5 d | no (verify in 7) |
| 5 — Packaging + distribution | 1.5 d | no (verify in 7) |
| 6 — Release pipeline | 1 d | no |
| 7 — Verification + WKWebView shakeout | 1–3 d | **yes** |
| | **6–8 d remaining** | |

## Out of scope

- **Code signing and notarization.** Deferred by decision, not oversight. Adding it later touches
  only the CI workflow and `tauri.conf.json` — no application code — so nothing in this plan needs
  to anticipate it. Revisit if Mac download-to-retention numbers look bad, since the "damaged"
  dialog would be the first suspect.
- **Intel Macs.** Add `macos-13` to the release matrix and parameterize `bundle-core.ts` by target
  if it is ever warranted; nothing else in this plan blocks it.
- **Linux.** Most of Phases 1, 3, and 6 are prerequisites for it, but no Linux-specific work is
  planned here. `appDataRoot()` is where an XDG branch would go.
- **Retiring `shell/` (electrobun).** Still tracked as separate cleanup from the Tauri packaging
  change. This plan simply does not port it.
- **Auto-update.** Tauri's updater needs signing keys and is a distinct feature; Homebrew's
  `brew upgrade` is the interim story.
