# Plan: macOS port + CI release pipeline

**Status:** in progress — **Phases 1–3 complete** (`BASED-PLATFORM-PATHS` merged into `spec.md`;
macOS build workflow landed and green, `.dmg` artifact produced; dialogs relayed to the shell)
**Spec impact:** 6 new requirements (`BASED-PLATFORM-PATHS` ✅, `BASED-MENU-MAC`,
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

Design (2) from the earlier draft was taken: dialogs moved into the Tauri shell
(`tauri-plugin-dialog`), the one deliberate exception to "the shell holds no app logic" — they are
a windowing-system concern (parenting, and on macOS a core-owned subprocess dialog can't exist).

Shipped:

- **Shell-dialog channel.** Core serves `GET /api/shell/dialogs` (SSE, token-authed); the shell
  subscribes for the app's lifetime — in packaged *and* dev mode, since both know core's URL — and
  answers each `{id, kind, filters/defaultName/startingFolder}` request with a real native dialog
  via `POST /api/shell/dialog-result {id, path}` ([`main.rs`](../../../shell-tauri/src/main.rs)
  `subscribe_shell_dialogs`/`show_shell_dialog`, reconnect loop for dev-core restarts; dialogs
  parent to the focused window). The SSE stream opens with a `: connected` comment frame — with no
  initial payload Bun never flushes headers and the subscriber sees a hung connect.
- **Core broker.** [`dialogs.ts`](../../../core/src/dialogs.ts) rewritten: structured
  `FileFilter {name, extensions[]}` on the wire (WinForms filter strings are now a
  fallback-formatting detail), `ShellDialogBroker` (per-server instance, not module state) with
  in-flight requests resolved as *cancelled* if the shell detaches. Endpoint contracts unchanged —
  the UI needed no edits.
- **Fallbacks, not deleted outright** (deviation from the draft's "deletes the PowerShell hack"):
  browser dev has no shell attached, so shell-less core still shows PowerShell WinForms on Windows
  and `osascript -e 'choose …'` on macOS. The packaged app never hits either path.
- `openWithDefaultApp` branched: `open` (darwin) / `cmd start` (win32) / `xdg-open` (else).
- `resolveDownloadDir()` verified — already `homedir()`-based, correct on macOS; spec wording was
  already platform-neutral.
- Covered by
  [`integration.shellDialogs.test.ts`](../tests/integration.shellDialogs.test.ts) (5 tests: relay
  round-trip with structured filters, cancel, defaultName carry, detach-cancels-in-flight, unknown
  id ignored). `BASED-DIALOG-OPEN-FILE` rewritten in `spec.md` (now core + shell-tauri,
  integration + manual).

**Verified:** 646 pass / 0 new failures (one pre-existing agent-threads failure on main), all three
typechecks clean, `cargo check` clean. Windows packaged dialogs switch from WinForms subprocess to
shell-native — strictly better (parented, no PowerShell spawn); noted for the Phase 7 checklist.

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
  obligation that the TS and Rust implementations agree. **Merged into `spec.md`.**
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

- **`BASED-SECRET-STORE`** — title and body currently say "Windows Credential Manager". Becomes the
  OS keychain (Credential Manager / macOS Keychain) via the same `@napi-rs/keyring` API. Note that
  the 2560-byte blob cap and the UTF-16 halving are **Credential Manager limits, not Keychain
  limits** — the byte-encoding requirement and the over-cap guard stay, but their justification and
  the platforms they bite on need restating. The legacy-blob upgrade path is Windows-only history.
- **`BASED-DIALOG-OPEN-FILE`**, **`BASED-FILE-OPEN-SQL`** — dialog mechanism is no longer
  "PowerShell WinForms"; endpoint contracts unchanged.
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
| ~~2 — First CI build~~ | ~~1 d~~ **done, run pending** | no |
| ~~3 — Native dialogs~~ | ~~2 d~~ **done** | no (verify in 7) |
| 4 — macOS UX conventions | 2.5 d | no (verify in 7) |
| 5 — Packaging + distribution | 1.5 d | no (verify in 7) |
| 6 — Release pipeline | 1 d | no |
| 7 — Verification + WKWebView shakeout | 1–3 d | **yes** |
| | **8–10 d remaining** | |

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
