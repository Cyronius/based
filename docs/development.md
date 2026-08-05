# Development

based is a Bun workspace with four packages:

| Package | What it is |
|---|---|
| `core/` | Bun server. Every bit of logic and every secret lives here: engine adapters, the agent, the language servers, storage, import/export. REST + NDJSON query streaming + SSE + a WebSocket LSP endpoint on `127.0.0.1:<port>`, behind a per-launch bearer token. |
| `ui/` | React 19 + Vite + Tailwind webview. Talks only to core. |
| `shell/` | Electrobun native window. Deliberately thin and disposable — it starts core in-process and points a window at it. |
| `specs/` | Requirements (`specs/based/spec.md`) and the tests that verify them. |

## Prerequisites

- **Bun** (a recent 1.x)
- **Windows 11 x64** for the shell and installer. `core` and `ui` are platform-agnostic enough to
  develop on, but secrets go through Windows Credential Manager and packaging is Windows-only.
- For the installer: **Inno Setup 6** (`winget install JRSoftware.InnoSetup`) and .NET Framework
  4.x (for `csc.exe`, which builds the `.sql` association stub).

```sh
bun install
```

## Dev loops

Three ways to run it, fastest feedback first.

**`bun run dev` — the one you want.** [scripts/dev.ts](../scripts/dev.ts) starts core in watch mode
and Vite, waits for both to listen, then launches the native window pointed at Vite
(`BASED_DEV_URL=http://localhost:5183`). Full hot reload inside the real window. Ctrl-C, or closing
the window, tears all three down. Logs interleave in one terminal.

**`bun run dev:core` + `bun run dev:ui` — browser loop.** Same core (port 7042, token `dev`) and
Vite (port 5183, proxying `/api`), but you iterate at http://localhost:5183 in a browser. The
client falls back to token `dev` when there's no URL hash, so there's no auth wiring to do.

**`bun run shell` — production-like smoke test.** Serves the static `ui/dist`. No watch, no HMR —
run `bun run build:ui` after UI changes or you'll be looking at a stale bundle.

```sh
bun run dev            # core + Vite + native window, all with HMR
bun run dev:core       # core alone on 127.0.0.1:7042
bun run dev:ui         # Vite alone on 5183
bun run build:ui       # -> ui/dist
bun run shell          # Electrobun window over ui/dist
bun run typecheck      # core, ui, shell
bun test               # specs
```

## Tests

```sh
bun test               # from the repo root; runs specs/
```

Unit tests run anywhere. **Integration tests need a real SQL Server** and self-skip without one —
they will not fail, they will report why they skipped. Point them at a database you control:

```powershell
$env:BASED_TEST_SERVER = "your-server.database.windows.net"
$env:BASED_TEST_DB     = "your_database"
az login
bun test
```

There is deliberately **no default** for those variables ([specs/based/tests/_devDb.ts](../specs/based/tests/_devDb.ts)):
a real hostname must never be committed, and a silent fallback would make a green run ambiguous
about which database it actually hit. Auth is `AzureCliCredential`, so `az login` has to be current.

Most suites only need connect + read. The table-edit suites additionally probe for `CREATE TABLE`
permission and skip themselves if it isn't there.

The Snowflake suites need **no live account** — they assert connect-option construction, the
bounded connect, and the driver-environment workaround, and run anywhere.

## Spec-driven changes

`specs/based/spec.md` is authoritative. Every requirement has an ID (`BASED-*`), a test category,
and either an executable test or a written verification procedure. Tests carry a
`// Traces: BASED-XXX` comment linking back. If you change specified behavior, update the spec in
the same change. See [CONTRIBUTING.md](../CONTRIBUTING.md).

## Building the installer

```powershell
.\scripts\package-win.ps1      # -> dist\based-<version>-Setup.exe
```

Five steps: build the UI, bundle the core (`shell-tauri/bundle-core.ts` →
`dist-core/{core,ui,bun}`), build the Tauri shell (`tauri build --no-bundle`; Tauri's own NSIS
bundler is not used — Inno Setup is the installer, and keeping the electrobun-era Inno `AppId`
means installing over an old install upgrades it in place instead of registering a second
"based"), stage `based-shell.exe` + resources + icon, and run Inno Setup. The version comes from
[shell-tauri/tauri.conf.json](../shell-tauri/tauri.conf.json), which is the single source of
truth. Requires Inno Setup 6 (`winget install JRSoftware.InnoSetup`) and the Rust toolchain.

## Cutting a release

```powershell
.\scripts\release.ps1 patch            # or minor / major / -Version 1.0.0
.\scripts\release.ps1 patch -DryRun    # build and draft everything, publish nothing
```

Preflight (clean tree, on `main`, `gh` authenticated) → typecheck + tests → bump → build installer →
draft a `CHANGELOG.md` section from the commit log and **stop for you to rewrite it** → commit, tag,
push → `gh release create` with the `.exe` and its SHA-256.

Version bumping alone:

```powershell
.\scripts\bump-version.ps1 patch -WhatIf   # print the transition, write nothing
.\scripts\bump-version.ps1 minor
```

It rewrites the version in `shell-tauri/tauri.conf.json` and `shell-tauri/Cargo.toml` (kept in
step — Cargo.toml feeds the exe's file-version metadata) and regenerates
[core/src/version.ts](../core/src/version.ts), which is committed so a fresh clone typechecks
without running the script first. The version reaches the status bar via `/api/health`.

**Releases are built locally, not in CI.** Between Inno Setup, the Rust toolchain, and native
modules whose bindings are selected from the build host's platform, a Windows runner is several
fragile pieces at once. Moving to GitHub Actions is tracked as future work; `release.ps1` is
written so the same steps would drop into a workflow when it's worth doing.

### Note on PowerShell scripts

Keep `scripts/*.ps1` **ASCII-only**. Windows PowerShell 5.1 decodes `.ps1` files as ANSI, so a
UTF-8 em-dash or curly quote — even inside a comment — corrupts the parse of the entire script.
