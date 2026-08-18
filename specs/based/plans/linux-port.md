# Plan: Linux port (Fedora first)

**Status:** in progress — **Phases 1 and 3 complete.** XDG paths landed on both sides of the TS/Rust
mirror, the localized-Downloads and `lsof` fixes are in, and dialogs moved into the shell
(`BASED-DIALOG-CHANNEL`, shared with the macOS plan's Phase 3). **Nothing here has yet been run on
Linux** — Phase 2a (WSL2) is the first time any of it executes.
**Spec impact:** 3 new requirements (`BASED-PACKAGE-LINUX`, `BASED-INSTALLER-LINUX`,
`BASED-SQL-ASSOC-LINUX`), 6 modified (`BASED-PLATFORM-PATHS` ✅, `BASED-SECRET-STORE`,
`BASED-DIALOG-OPEN-FILE` ✅, `BASED-FILE-OPEN-SQL` ✅, `BASED-SAVE-FILE-WRITER` ✅,
`BASED-DEV-CLEAN-SHUTDOWN` ⚠️ — see the note in Spec impact), 2 cross-reference only
(`BASED-OPEN-SQL-ARGV`, `BASED-UI-SHORTCUTS`)

**Depends on:** [`macos-port.md`](macos-port.md) Phase 6. Its Phase 3 is now done, and was
**decided in this plan's favour** — see "Coupling to the macOS plan" below.

## Problem

based runs on Windows. The macOS port is at Phase 2 of 7. Linux is the third target: a Fedora
workstation is the machine that matters, with WSL2 (Ubuntu 24.04, WSLg) and Docker Desktop on the
development box as the cheap environments in front of it.

The porting work is small and mostly already scoped. The genuinely new question is **which package
format to ship**, and the answer determines how much sandbox work the port carries.

There was also a live bug rather than a gap: `appDataRoot()` had a `darwin` branch and a `%APPDATA%`
fallback, so on Linux the fallback returned `"."` and a launch would write `app.db` and `agent.db`
into the process working directory. `data_dir()` in Rust had the same shape and the same defect.
**Fixed in Phase 1a/1b below.**

## Decisions taken before this plan

| Decision | Consequence |
|---|---|
| **`.rpm` + `.deb` + AppImage via Tauri's bundler. No Flatpak.** | Flatpak is a sandbox, and based is a database client: it opens arbitrary files, connects to arbitrary hosts, spawns a bundled `bun` subprocess, and writes to the Secret Service. Each of those needs a portal or an explicit sandbox hole, and the result is a worse app. Tauri emits rpm/deb/appimage natively, so the alternative costs one config line. Revisit only if Flathub distribution becomes a goal. |
| **x86_64 only** | Matches the target machine. `DUCKDB_BINDING_TARGETS` and `LIBSQL_NEON_TARGETS` in [`bundle-core.ts`](../../../shell-tauri/bundle-core.ts#L51-L88) already carry `linux-arm64` entries if that ever changes; nothing else in this plan blocks it. |
| **glibc, not musl** | All four native addons ship `-gnu` prebuilds only. Alpine is not a target. |
| **The `.rpm` is the primary artifact; AppImage is best-effort** | AppImage has to bundle WebKitGTK itself, which is the least reliable part of Tauri's Linux bundler. The rpm links the system WebKitGTK, which is what a Fedora user wants anyway. |
| **Phase 2 builds locally, not in CI** | This differs from the macOS plan on purpose. There, CI came first because no Mac was available. Here Linux environments are already on the desk, so the fastest toolchain feedback is a local build. CI comes in Phase 6. |
| **Phase 2 spends WSL2 and a Fedora container before the Fedora box** | Revised once WSL2 (Ubuntu 24.04, WSLg present) and Docker Desktop turned out to be available. The box is the only place the GPU driver, the keyring daemon, and the desktop session are real, so it is worth more as a Phase 7 machine than as a build host. Everything Phase 2 asks is answerable in a throwaway environment. |
| **`shell/` (electrobun) is not ported** | Same as the macOS plan. It is vestigial. |

## Approach

Seven phases, deliberately mirroring the macOS plan so the two can be read side by side. Phase 2
again produces a **broken but building** app before any porting work, because the Linux toolchain
carries more unknowns than macOS turned out to: four native addons need `linux-x64-gnu` prebuilds, the
Tauri build needs a list of system `-devel` packages, and the webview is a different engine from both
existing targets.

Phase 2 splits across three environments in increasing cost — WSL2, a Fedora container, then the
workstation — so that each question is answered in the cheapest place that can answer it honestly.
The ordering principle matters more than the specifics: the workstation is the only environment where
the GPU driver, the keyring daemon, and the desktop session are real, so nothing that a throwaway
environment can settle should be spent there.

---

### Phase 1 — XDG paths and dev-script fixes (0.5 d; 1a/1b done)

**✅ 1a. Application-data root (done).** [`appDataRoot()`](../../../core/src/storage/db.ts) gained a
`linux` branch resolving `$XDG_DATA_HOME`, falling back to `~/.local/share`. **Data, not config** —
the directory holds SQLite databases (`app.db`, `agent.db`) and window-restore state, not
user-editable settings, so `~/.local/share/based` is correct and `~/.config/based` is not. This also
matches what Rust's `dirs::data_dir()` and Tauri's own path API resolve to, which keeps the shell
mirror honest.

The Windows branch became explicit rather than the fallback it had been — that fallback *was* the
bug. Per the XDG spec, an empty or non-absolute `$XDG_DATA_HOME` is ignored in favour of the default;
without that check a relative value reintroduces the same defect through a different door.

The signature was already parameterized (`platform`, `env`), so the Linux branch is unit testable
from Windows. [`unit.platformPaths.test.ts`](../tests/unit.platformPaths.test.ts) gained 4 tests:
`XDG_DATA_HOME` set, unset, relative-and-empty, and the no-`HOME` case asserting the result is never
`"."`.

**✅ 1b. Rust mirror (done).** [`data_dir()`](../../../shell-tauri/src/main.rs) is now a three-way
`cfg!` chain rather than macOS-or-Windows, with the same absolute-path filter on `$XDG_DATA_HOME`.
`cfg!` over `#[cfg]` for the reason the macOS work gave — every branch type-checks on every host.
The header comment on both functions already said they must change together; it now names three
platforms.

This was not cosmetic. Both sides resolved to a *relative* path on Linux, and the shell reads
`pending-open.txt` out of the directory core writes it to. Two processes with different working
directories would have silently disagreed.

**✅ 1c. Downloads directory (done).** [`resolveDownloadDir()`](../../../core/src/files/saveFile.ts)
joined `homedir()` with the literal `"Downloads"`. That is right on an English desktop and wrong on a
localized one — a French GNOME session has `~/Téléchargements` and no `~/Downloads` at all, so the
`existsSync` check degraded straight to `tmpdir()`.

Linux now reads `user-dirs.dirs` under `$XDG_CONFIG_HOME` (default `~/.config`) first.
`parseXdgDownloadDir(body, home)` is a **pure** parser, separate from the file read, so all nine
branches are unit-testable from Windows — that split is the reason this stayed a `unit` requirement
instead of drifting to `manual`. Parsing the file beats shelling out to `xdg-user-dir`, which is its
own package and may be absent.

The parser expands `$HOME` and nothing else. A value naming another variable is discarded rather
than half-expanded, because a half-expanded path looks valid and is not. Windows and macOS skip the
lookup entirely: both use the literal `~/Downloads` whatever the display language is.

The duplicated `join(homedir(), "Downloads")` at `shared.ts` (for `export_data`) is gone — it now
calls `resolveDownloadDir(deps.exportDir?.())`, which has exactly the override semantics that copy
was reimplementing. `shared.ts` already imported the function; the copy was pure drift, and it is
what would have made this a two-site fix. `BASED-SAVE-FILE-WRITER` now states the single-resolver
rule so it cannot drift back.

**✅ 1d. Dev-script POSIX branches (done).** [`scripts/dev.ts`](../../../scripts/dev.ts) already
branched Windows/POSIX at `killTree`, `killOrphanedShellProcesses`, and `freeDevPorts` — written for
macOS in the macOS plan's Phase 1. Two of the three carried over unchanged (`pgrep -P`, `pkill -f`).
The third did not: `listenerPids()` shelled out to **`lsof`, which Fedora Workstation does not
install by default.**

Linux now tries `ss -Hltnp 'sport = :<port>'` first and falls back to `lsof`; macOS has no `ss` and
stays on lsof. `ss` is in iproute, which every distro installs. Only a *missing binary* falls
through — `ss` exits 0 with empty output when nothing is listening, and that is an answer, not a
failure.

`ss` embeds pids in `users:(("bun",pid=1234,fd=20))` rather than printing them bare, so it needs its
own parser; that parser dedupes, because one process listening on both IPv4 and IPv6 appears once
per socket and `freeDevPorts` logs a line per pid.

Not covered by a test: `scripts/` is outside the tested packages, and moving a dev-script helper into
`core` purely to reach the test harness is the artificial restructuring the doctrine warns against.
The parser was checked against real `ss` output shapes by hand; the live path is a Phase 2a item
(WSL2 has both `ss` and `lsof`, so it proves the `ss` branch works — not the "lsof absent" fallback,
which only Fedora exercises).

---

### Phase 2 — First Linux builds (1 d)

Get `tauri build` to *complete*. The resulting app may launch and misbehave — the webview may not
render at all (see 7a). That is the point: prove the toolchain before spending time on the app.

Three environments, cheapest first. **None of them is the Fedora workstation**, which is deliberate:
the box is the only place where the GPU driver and the keyring daemon are real, so spending it on
build-toolchain questions that a throwaway environment answers just as well wastes the one machine
that can settle Phase 7.

**2.0. Bundle targets** (shared by all three).
[`tauri.conf.json`](../../../shell-tauri/tauri.conf.json#L14) `bundle.targets` goes from
`["nsis", "dmg"]` to `["nsis", "dmg", "rpm", "deb", "appimage"]`. This cannot affect the Windows
release — [`package-win.ps1`](../../../scripts/package-win.ps1) passes `--no-bundle`, so
`bundle.targets` is never read there, the same reasoning that made adding `"dmg"` safe in the macOS
plan. The icon array widened for macOS already covers Linux; Tauri derives the hicolor PNG set
from it.

Also port the **verify-bundle-layout** check from
[`build-macos.yml:57-66`](../../../.github/workflows/build-macos.yml#L57-L66), swapping
`libduckdb.dylib` for `libduckdb.so`. `bundle-core.ts` already has the `linux` entry in
`DUCKDB_COMPANION_LIBS`.

---

#### 2a. WSL2 (Ubuntu 24.04) — the toolchain proof

WSLg is present, so a Tauri window genuinely appears; this is not a headless build. It answers every
row of the risk table below except the rpm, on the machine development already happens on.

**Use a checkout inside the WSL filesystem, never `/mnt/c/…`.** Two reasons, and the second is the
one that bites: the 9p bridge makes `bun install` and `cargo build` slow, and a shared
`node_modules/.bun` would end up holding win32-x64 *and* linux-x64 native packages.
[`bundle-core.ts`](../../../shell-tauri/bundle-core.ts#L8-L11) resolves every addon by
`${process.platform}-${process.arch}` against that one store, and it is built on the assumption that
a checkout targets a single host.

```sh
# --- one-time setup, inside WSL ---
sudo apt update && sudo apt install -y \
    libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev \
    libjavascriptcoregtk-4.1-dev librsvg2-dev libssl-dev \
    build-essential curl wget file pkg-config

curl -fsSL https://bun.sh/install | bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source "$HOME/.cargo/env"

git clone https://github.com/Cyronius/based.git ~/based   # SEPARATE checkout; not /mnt/c/code/based
cd ~/based

# --- build ---
bun install                          # first linux resolve: the prebuild risks surface here
bun run build:ui
cd shell-tauri && bun bundle-core.ts

# --- verify the bundle before spending a cargo build on it ---
test -f dist-core/core/index.js      || { echo "missing core/index.js"; exit 1; }
test -f dist-core/core/libduckdb.so  || { echo "missing core/libduckdb.so"; exit 1; }
test -f dist-core/ui/dist/index.html || { echo "missing ui/dist/index.html"; exit 1; }
test -x dist-core/bun/bun            || { echo "missing or non-executable bun/bun"; exit 1; }
ls -la dist-core/core

bun x @tauri-apps/cli build

# --- run it ---
sudo apt install -y ./target/release/bundle/deb/*.deb
based
```

Do **not** use `--frozen-lockfile`: `bun.lock` was written on Windows and this is the first Linux
resolve, so the optional per-platform native packages legitimately differ. Same reasoning as the
macOS workflow's first run.

**What a green 2a proves:** all four native prebuilds resolve, the WebKitGTK headers are right,
`cargo build` links, `.deb` bundling works, the XDG data path from Phase 1a actually gets used, `ss`
in the dev script works, and a GTK file picker draws (Phase 3).

**What it cannot prove**, so do not read a pass as coverage:

| Question | Why WSL2 can't answer it |
|---|---|
| rpm `Requires:` names | Ubuntu, not Fedora — see 2b |
| Blank window / DMABUF (7a) | WSLg runs Mesa on a virtualized D3D12 GPU, nothing like a bare-metal driver |
| deck.gl WebGL2 (7b) | Weak signal. A **pass** proves little; a **fail** is real and worth chasing |
| Secret Service (7d) | No session D-Bus and no gnome-keyring. Secrets *will* appear broken — that is environmental, not the code |
| `.desktop` association | No real desktop session |

The keyring one deserves naming because it looks exactly like a bug: `@napi-rs/keyring` throws,
[`readSecret`](../../../core/src/secrets.ts#L41-L54) swallows it and returns `null`, and every saved
connection password reads as absent. That silent-null is the very thing 7d proposes to change.

**glibc floor:** 2.39 on Ubuntu 24.04. A `.deb` from here will not run on Ubuntu 22.04 or Debian 12.
Fine for a toolchain proof, wrong for a shipped artifact — see 5d.

#### 2b. Fedora container — the rpm

Docker Desktop's WSL integration is already available, and a `fedora:latest` container is a more
faithful place to build the rpm than WSL-Ubuntu is. No GUI, so this proves build and bundle only —
which is exactly what the rpm dependency question needs, and nothing more.

```sh
docker run --rm -it -v "$HOME/based:/src" -w /src fedora:latest bash
```

Inside:

```sh
dnf install -y webkit2gtk4.1-devel gtk3-devel libsoup3-devel \
    javascriptcoregtk4.1-devel librsvg2-devel openssl-devel \
    rpm-build file git
dnf group install -y "C Development Tools and Libraries"
```

Check that list against the current Tauri prerequisites page rather than trusting it — package names
drift, and `webkit2gtk4.1` vs `webkit2gtk4.0` in particular has changed with Tauri versions.

Then the same build sequence as 2a. Build in a container-local directory rather than the bind mount
if `target/` churn is slow.

**Exit criterion:** an `.rpm` exists, and `rpm -qpR` on it lists dependencies that actually resolve
in Fedora's repos. That last check is the entire point of 2b — see 5c for why Tauri's defaults get
it wrong.

#### 2c. The Fedora workstation

Deferred. Install the 2b rpm there and confirm it launches, then go straight to Phase 7 — the GPU
driver, the keyring, and the desktop integration are the only questions the box is uniquely able to
answer, and they are all Phase 7 questions.

---

**Named risks this phase exists to surface**, in the order they would fail:

| Risk | Where it fails |
|---|---|
| `@duckdb/node-bindings-linux-x64` prebuild missing | `bun install`, or the companion-lib scan at [`bundle-core.ts:117`](../../../shell-tauri/bundle-core.ts#L117-L127) |
| `@libsql/linux-x64-gnu` missing | Bundle succeeds, core dies at startup |
| `@napi-rs/keyring` linux-x64-gnu missing | Bundle succeeds, secrets throw on first use |
| `@lancedb/lancedb-linux-x64-gnu` missing | LanceDB connections fail |
| System WebKitGTK headers absent or wrong version | `cargo build` |
| `rpm-build` absent | Tauri bundler, after a successful compile (2b only) |

All four addon prebuilds are published upstream. The maps in `bundle-core.ts` already name the right
targets. The expectation is that this phase is uneventful, exactly as macOS Phase 2 was — but it is
cheap and it is the only way to find out.

---

### ✅ Phase 3 — Native dialogs (done, and it cost Linux nothing)

`core/src/dialogs.ts` was the only genuinely Windows-locked source file. All four exports shelled
out to `powershell.exe` with WinForms, or to `cmd.exe /c start`.

**The macOS plan's open decision was resolved in this plan's favour: design (2).** Dialogs moved
into the Tauri shell (`tauri-plugin-dialog` + `tauri-plugin-opener`), reached over the loopback HTTP
channel, shipped as `BASED-DIALOG-CHANNEL`. See [`macos-port.md`](macos-port.md) Phase 3 for what
was built.

The argument that settled it was the one this plan raised. Under design (1) — an `osascript` sibling
branch — Linux would have needed a **third** branch: `zenity` or `kdialog` for the three pickers plus
`xdg-open` for `openWithDefaultApp`, another day of work, and a runtime dependency on a dialog binary
that is not guaranteed present (Fedora Workstation ships `zenity`; a minimal or KDE install may not).
Under design (2) Linux costs nothing: `tauri-plugin-dialog` uses GTK's native pickers, or the XDG
desktop portal where one is running.

The core-facing API (`POST /api/dialog/open-file`, `/api/file/open-sql`, `/api/file/save-sql`) is
unchanged, so the UI needed no edits.

**Left for Phase 7 on Linux specifically:** confirm the GTK picker is what appears (not a Tauri
fallback), and that it goes through `xdg-desktop-portal` under a sandboxed or Wayland session rather
than drawing a GTK dialog the compositor mispositions. `openWithDefaultApp` now goes through
`tauri-plugin-opener`, which uses `xdg-open` on Linux — verify it respects the `.desktop` handler
list from Phase 5b rather than always picking the first match.

---

### Phase 4 — Linux desktop conventions (1 d)

Much smaller than the macOS equivalent, because Linux desktop conventions match Windows almost
everywhere.

**Carries over with no work** — record these so a future reader does not re-open them:

| macOS Phase 4 item | Linux status |
|---|---|
| 4a — app menu required for webview copy/paste | **Not applicable.** That is a WKWebView constraint. WebKitGTK handles edit commands in the webview directly. `BASED-MENU-MAC` gets no Linux sibling. |
| 4b — Cmd vs Ctrl modifiers | **Free.** Linux uses Ctrl, so the existing Windows bindings are already correct. If macOS Phase 4b lands its `isAccel()` / `accelLabel()` helpers first, Linux falls into the Windows branch with no third case. `BASED-UI-SHORTCUTS` needs no Linux column. |
| 4c — close ≠ quit, dock reopen | **Not applicable.** Linux matches Windows: closing the last window quits. The `RunEvent::Exit` handler at [`main.rs:313`](../../../shell-tauri/src/main.rs#L312-L321) is correct as written. |
| 4d — Apple Events for file-open | **Not applicable.** Linux delivers file arguments as argv, like Windows, so `BASED-OPEN-SQL-ARGV` holds unchanged. `tauri-plugin-single-instance` uses D-Bus on Linux and works. |

**The one genuinely new item: the `.desktop` entry.** Tauri's deb and rpm bundlers generate one, but
the generated file needs review and probably overriding via `bundle.linux`:

- `Exec` must pass `%F` so a file manager can hand it a path — this is what makes `BASED-OPEN-SQL-ARGV`
  reachable from a double-click.
- `MimeType=application/sql;text/x-sql;` for the `.sql` association (Phase 5b).
- `Categories=Development;Database;`
- Icon must land in the hicolor theme (`/usr/share/icons/hicolor/*/apps/based.png`) or the launcher
  shows a placeholder.
- `StartupWMClass` should match what the GTK window reports, or the taskbar treats a launched window
  as a separate un-pinned entry.

---

### Phase 5 — Packaging and distribution (1 d)

**5a. Package format comparison**, recorded so the Flatpak question stays closed:

| Format | Mechanism | Best for | Cost here |
|---|---|---|---|
| `.rpm` | Native package, links system WebKitGTK | Fedora / RHEL, the target machine | One config line |
| `.deb` | Native package, same shape | Debian / Ubuntu users | Free alongside the rpm |
| AppImage | Single file, bundles WebKitGTK | "Download and run", no install | Free to emit, unreliable in practice |
| Flatpak | Sandboxed, Flathub distribution | Public distribution to strangers | Hand-written manifest, plus a portal or hole per capability |
| Snap | Ubuntu's sandboxed format | Ubuntu Store | Not pursued |

**5b. `.sql` association.** The Windows path is HKCU registry keys written by
[`installer.iss`](../../../scripts/installer.iss); macOS is `CFBundleDocumentTypes`. Linux is the
`MimeType` line in the `.desktop` file plus `update-desktop-database` in the package's post-install
scriptlet. This registers based as an *available* handler and does not touch the user's default,
which is the same non-destructive stance `BASED-SQL-ASSOC-WIN` takes. Setting a default would need
`xdg-mime default`, and this plan deliberately does not.

**5c. RPM dependency metadata.** Tauri writes `Requires:` entries from `bundle.linux.rpm.depends`.
The defaults are oriented toward Debian package names, so an rpm built without an explicit list can
declare dependencies that do not exist in Fedora's repos — the package then either fails to install
or installs and dies at launch. Set them explicitly: `webkit2gtk4.1`, `gtk3`, and **`libsecret`**,
which is easy to forget because nothing references it at build time. It is what `@napi-rs/keyring`
dlopens at runtime.

**5d. glibc floor.** The bundled `bun` binary and all four `.node` addons link against the build
host's glibc, and glibc is forward-compatible only. An rpm built on Fedora 42 runs on Fedora 42 and
newer, and does not run on Fedora 40 or Ubuntu 22.04.

The same applies to the Phase 2a `.deb`: WSL2's Ubuntu 24.04 is glibc 2.39, so that artifact runs on
Ubuntu 24.04 and newer and nothing older. It is a toolchain proof, not a release candidate.

For a package aimed at the one Fedora box, ignore this. For a public `.deb` or AppImage, build inside
a `ubuntu:22.04` container so the floor is glibc 2.35 — the same container mechanism Phase 2b already
uses for the rpm. Decide when Phase 6 defines the CI matrix, not before.

**5e. Distribution.** There is no Homebrew-tap equivalent. GitHub release assets are the baseline.
A **COPR** repository is the Fedora-native way to get `dnf install based` plus automatic updates, and
is the closest analogue to the Homebrew cask in the macOS plan. Treat COPR as follow-on work, not part
of this plan — release assets are enough to start.

---

### Phase 6 — Release pipeline (0.5 d, after macOS Phase 6)

The macOS plan moves releases into a tag-triggered `.github/workflows/release.yml` with two jobs.
This adds a third.

Runner choice interacts with 5d:

- `ubuntu-22.04` for the `.deb` and AppImage — the oldest available runner, so the widest glibc reach.
- A `fedora:latest` container step for the `.rpm`, so `rpm-build` and the dependency names come from
  the distro the package targets.

Do not build the rpm on the Ubuntu runner just because it works. It produces a package whose
`Requires:` were never validated against a Fedora repo.

---

### Phase 7 — Verification on the Fedora box (1–3 d, the real unknown)

Everything above is estimable. This is not. WebKitGTK is a third rendering engine, after Chromium via
WebView2 on Windows and WKWebView on macOS.

This is what the workstation is *for*. Every item below turns on something no throwaway environment
has: a real GPU driver (7a, 7b), a running keyring daemon (7d), or an actual desktop session (7e).
A green Phase 2a says nothing about any of them.

**7a. The blank-window failure, check this first.** WebKitGTK 2.42 and newer render a blank or black
window on some GPU and driver combinations, most commonly the NVIDIA proprietary driver. The app
builds, launches, and shows nothing. The standard workaround is the environment variable
`WEBKIT_DISABLE_DMABUF_RENDERER=1`, with `WEBKIT_DISABLE_COMPOSITING_MODE=1` as a heavier fallback.

If it reproduces, set it in `main()` before `tauri::Builder` runs rather than in the `.desktop` `Exec`
line, so a terminal launch behaves the same as a launcher launch. Expect to gate it on a driver check
or make it overridable, because disabling DMABUF costs rendering performance on hardware that does not
need it.

**7b. WebGL.** The Embeddings Atlas uses deck.gl and needs a working WebGL2 context inside WebKitGTK.
Mesa on Intel or AMD is generally fine. NVIDIA proprietary is the risk, and it is the same driver
implicated in 7a. This is the single most likely component to be unshippable on Linux, and it should
be tested on day one of this phase rather than last.

**7c. The other two heavy components**, same list as macOS Phase 7:

- **glide-data-grid** — every result grid, canvas-rendered.
- **Monaco** + `monaco-vim` — the editor and its keybinding layer.

Plus CSS scrollbar styling (`::-webkit-scrollbar` is supported by WebKitGTK but sized differently),
the font stack, and `streamdown` / `mermaid` rendering.

**7d. Secret Service.** `@napi-rs/keyring` on Linux talks to the Secret Service over D-Bus —
`gnome-keyring` on Fedora Workstation, `kwallet` under KDE. A normal desktop session has an unlocked
collection and this works. A headless session, a minimal window manager, or a locked keyring does not,
and the current [`readSecret`](../../../core/src/secrets.ts#L41-L54) swallows the failure and returns
`null`, which the UI reads as "no secret stored" rather than "the keyring is unavailable".

That silent-null is defensible on Windows and macOS, where the store is always present. It is not on
Linux. Expect a `BASED-SECRET-STORE` change: distinguish "no entry" from "no keyring service", and
name the latter.

Also verify the 2560-byte cap still reads back correctly. That cap is a Credential Manager limit
applied everywhere so one entry format is portable; libsecret has no such limit, so this is a
round-trip check, not a new constraint.

**7e. The rest of the manual checklist:** install the rpm from a path with no repo checkout and run a
LanceDB query to exercise the DuckDB native stack (this is `BASED-PACKAGE-LINUX`'s verification), the
`.sql` double-click association, window restore, a 1704-character PEM through the keyring, the
localized-Downloads behavior from 1c, and HiDPI / fractional scaling under GTK.

---

## Coupling to the macOS plan

| macOS plan item | Effect here |
|---|---|
| Phase 1 (done) | Made `appDataRoot()` parameterized and hoisted `DUCKDB_COMPANION_LIBS`. Phase 1 here is a third branch in existing seams rather than new abstraction. |
| Phase 3 design choice | **Settled, design (2), done.** This plan's argument decided it: (2) makes Linux dialogs free, (1) would have cost a day and added a `zenity` runtime dependency. Shared work — neither port pays for it twice. |
| Phase 4b (`isAccel` / `accelLabel`) | If it lands first, Linux needs no shortcut work at all. |
| Phase 6 (release CI) | This plan's Phase 6 is a third job on that workflow. Doing it before the macOS workflow exists means building the same scaffolding twice. |

Sequencing: Phase 2a (WSL2) is next and needs no new hardware. Phase 6 should wait for macOS Phase 6
to land.

## Spec impact

**New requirements:**

- **`BASED-PACKAGE-LINUX`** (shell-tauri, manual) — the packaged bundle is self-contained. Sibling of
  `BASED-PACKAGE-WIN` and `BASED-PACKAGE-MAC`, same verification shape: run from a path with no repo
  checkout, and a LanceDB query exercises the DuckDB companion `libduckdb.so`.
- **`BASED-INSTALLER-LINUX`** (repo, manual) — `.rpm` primary, `.deb` and AppImage secondary; the
  `.desktop` entry and its `Exec %F`, icon, and `StartupWMClass`; the explicit RPM `Requires:` list
  including `libsecret`; the glibc floor implied by the build host.
- **`BASED-SQL-ASSOC-LINUX`** (installer, manual) — `MimeType` in the `.desktop` file plus
  `update-desktop-database`, registering as an available handler and never as the default. Mirrors
  `BASED-SQL-ASSOC-WIN`'s non-destructive stance.

**Modified:**

- ✅ **`BASED-PLATFORM-PATHS`** — **merged into `spec.md`.** Third branch, `$XDG_DATA_HOME` falling
  back to `~/.local/share`, in both the TypeScript and Rust implementations, with an empty or
  non-absolute value ignored per the XDG spec. The requirement now records that the pre-Linux
  behavior resolved to a relative path, so this was a defect fix and not only an extension. The
  acceptance-criteria list gained 4 Linux cases, all covered by `unit.platformPaths.test.ts`.
- **`BASED-SECRET-STORE`** — third backing store, the Secret Service via libsecret, still behind the
  one `@napi-rs/keyring` API with no per-platform branch in `secrets.ts`. Adds the "keyring service
  unavailable" failure mode, which has no Windows or macOS counterpart.
- ✅ **`BASED-DIALOG-OPEN-FILE`**, **`BASED-FILE-OPEN-SQL`** — **merged into `spec.md`** by Phase 3.
  Both point at the new `BASED-DIALOG-CHANNEL` instead of naming PowerShell WinForms. Endpoint
  contracts unchanged.
- ✅ **`BASED-SAVE-FILE-WRITER`** — **merged into `spec.md`.** `resolveDownloadDir` honors XDG
  user-dirs on Linux rather than a hardcoded `Downloads`; `parseXdgDownloadDir` is specified as the
  pure parser, with 9 new acceptance criteria covered by `unit.saveFile.test.ts`. The requirement now
  also states that `export_data` resolves through the same function rather than carrying a copy. The
  extension whitelist is unchanged; it is a caller-trust rule, not a platform rule.
- ⚠️ **`BASED-DEV-CLEAN-SHUTDOWN`** — the POSIX branch was written for macOS and assumed `lsof`,
  which Fedora does not install by default. **Fixed in code (1d), but the requirement does not exist
  in `spec.md`** — the ID is cited in `scripts/dev.ts` and in both port plans, and traces to nothing.
  That gap predates this plan. Either write the requirement (developer tooling, so `manual`) or drop
  the ID from the code comments; a cited-but-absent ID is the worst of the three.

**Cross-reference only, no behavior change:**

- **`BASED-OPEN-SQL-ARGV`** — Linux uses argv, identical to Windows. Worth stating explicitly so the
  macOS retitle does not imply a Linux exception.
- **`BASED-UI-SHORTCUTS`** — Linux uses the Windows modifier column unchanged. Stated so nobody adds
  a redundant third column.

## Effort

| Phase | Est. | Where it runs |
|---|---|---|
| ~~1a/1b — XDG paths~~ | ~~0.25 d~~ **done** | Windows |
| ~~1c/1d — Downloads dir + dev script~~ | ~~0.25 d~~ **done** | Windows |
| 2a — Toolchain proof + `.deb` | 0.5 d | WSL2 |
| 2b — `.rpm` and its dependency names | 0.25 d | Fedora container |
| 2c — Install check | 0.25 d | **Fedora box** |
| ~~3 — Native dialogs~~ | ~~0.5–1.5 d~~ **done** | Windows |
| 4 — Desktop conventions | 1 d | any (verify in 7) |
| 5 — Packaging | 1 d | WSL2 + container |
| 6 — Release pipeline | 0.5 d | CI |
| 7 — Verification + WebKitGTK shakeout | 1–3 d | **Fedora box** |
| | **4.5–6.5 d remaining** | |

The spread is almost entirely Phase 7, and within Phase 7 almost entirely 7a and 7b. If deck.gl works
under WebKitGTK on the target hardware, this is a one-week port. If it does not, the Embeddings Atlas
needs either a driver workaround or a documented Linux limitation, and that is a separate decision.

## Out of scope

- **Flatpak and Flathub.** Decided against above, not overlooked. Revisit if public distribution
  becomes a goal; nothing in this plan makes it harder later.
- **Snap.** Ubuntu-store-specific, and the sandbox objection to Flatpak applies equally.
- **COPR repository.** The Fedora analogue of the Homebrew tap. Worth doing once releases are in CI;
  not a prerequisite for a working package.
- **arm64 Linux and musl.** No target hardware, and no `-musl` prebuilds for the native addons.
- **Wayland-specific work.** GTK handles both X11 and Wayland. If something is broken only under one,
  it belongs to Phase 7 as a finding, not to this plan as scoped work.
- **Code signing.** Linux has no equivalent to Authenticode or notarization that affects whether the
  app runs. RPM signing matters only for a repository, which follows COPR.
- **Auto-update.** Same as the macOS plan: Tauri's updater needs signing keys and is its own feature.
  `dnf upgrade` from a COPR repo is the eventual answer.
