# Phase 0 — Validation spike results

Plan: [.claude/plans/feasibility-and-architecture.md](../../.claude/plans/feasibility-and-architecture.md)
Spike code: deleted after Phase 1 started; results below are the retained record.

Environment: Windows 11 Pro, system Bun 1.3.14, Node v24.9.0, az CLI 2.80.0.
Test DB: `zl5qolt7t8.database.windows.net` / `learnermobile_db_ci` (read-only queries only).

| # | Spike | Verdict | Date |
|---|-------|---------|------|
| 1 | Electrobun hello-world on Windows | **PASS** (final DPI eyeball check = user) | 2026-07-21 |
| 2 | tedious/mssql under Bun vs Node | **PASS** | 2026-07-21 |
| 3 | Entra ID interactive browser auth under Bun | **PASS** | 2026-07-22 |
| 4 | Mastra → AG-UI → lm-ag-ui + Streamdown streaming | **PASS** | 2026-07-21 |
| 5 | LanceDB napi under Bun on Windows | **PASS** | 2026-07-21 |

**Bottom line: 5 of 5 gates passed. Nothing fell back to a sidecar. Phase 1 is unblocked on the current evidence.**

## Spike 2 — tedious/mssql in-process under Bun: PASS

`spikes/02-tedious-bun/spike.mjs`, identical script both runtimes, mssql@11.0.1 (tedious), @azure/identity AzureCliCredential → `azure-active-directory-access-token`.

| Check | Bun 1.3.14 | Node 24.9.0 |
|---|---|---|
| AzureCliCredential in-process (spawns az.cmd) | OK, 2641ms | OK, 1273ms |
| Connect (AAD token auth) | OK, 525ms | OK, 498ms |
| 30 sequential pooled `SELECT 1` (mean/p50/p95) | 108.4 / 109 / 111 ms | 102.7 / 103 / 105 ms |
| 10 concurrent pooled queries | 583ms | 600ms |
| INFORMATION_SCHEMA metadata query | OK | OK |
| `pool.close()` | OK, 2ms | OK, 1ms |
| Natural process exit after close | yes | yes |

- Latency delta Bun vs Node: ~5% — network-dominated, bun #13093 pool-latency bug **not observed**.
- Close-hang (tedious #1681) **not observed**.
- AzureCliCredential works in-process under Bun (child-process spawn of `az.cmd` on Windows works).
- **Consequence: in-process tedious/mssql is confirmed as the mainline. No STS sidecar needed for the driver.** (STS remains interesting later for IntelliSense only.)
- Caveat: run under system Bun 1.3.14, not Electrobun's pinned 1.3.11 — re-check trivially once the Electrobun app exists (spike 1). Delta is 3 patch versions; risk considered negligible.

## Spike 5 — LanceDB napi under Bun on Windows: PASS

`spikes/05-lancedb/spike.mjs`, @lancedb/lancedb 0.24.x win32 prebuild.

- Native addon loads under Bun 1.3.14 (no crash — the bun-napi-on-Windows issue history did not reproduce).
- Create table (500 rows × 64-dim vectors), `vectorSearch` returns correct nearest neighbor (query row itself, id 123), `where` filter query OK, clean exit.
- Node control run: identical results.
- **Consequence: LanceDB adapter can be in-process later; no Node sidecar needed on current evidence.**

## Spike 3 — Entra ID interactive browser auth: PASS

Ran interactively by the user (`InteractiveBrowserCredential`, system browser + loopback listener on `http://localhost:8400`, Azure CLI public client id, no app registration). Browser opened, sign-in succeeded, token acquired, connect succeeded as `josh.attoun@sviworld.com`.

The only issue encountered was the target dev DB being restricted to SQL-login auth only (a database-config constraint) — not a defect in the Bun loopback listener or `InteractiveBrowserCredential` path, which is what this spike gated.

## Spike 1 — Electrobun hello-world on Windows: PASS

`spikes/01-electrobun-hello/`, electrobun@1.18.1 (bundles its own Bun **1.3.13** — it does not run the app on system bun).

- `electrobun dev` on Windows 11: core win-x64 binaries downloaded/cached, launcher spawned bundled bun, window opened. No crash, no Dev Drive issue.
- **The architecture's key pattern works**: `Bun.serve` on `127.0.0.1:<random port>` inside the Electrobun main process, `BrowserWindow` pointed at that `http://` URL (not `views://`, not Electrobun RPC). Page served and rendered in WebView2.
- Dense-text page (10–14px ladder, 1px hairlines, 30-row table, monospace SQL) rendered correctly — screenshot at native 2560x1440/100% scaling: [phase0-evidence/spike1-electrobun-window.png](phase0-evidence/spike1-electrobun-window.png). Text is crisp in the 1:1 capture; **final eyeball verdict on sharpness is the user's** (run `bun start` in the spike dir; the #324 issue only bites at >100% scaling anyway).
- Console output from the main process reaches the terminal in dev builds. Devtools: `win.webview.openDevTools()` (spike wires it behind `SPIKE_DEVTOOLS=1`); `electrobun dev --watch` = kill-rebuild-relaunch, not HMR — real HMR comes free from our Vite-on-localhost pattern anyway.
- Notes: Electrobun 1.18.1 pins Bun 1.3.13 vs system 1.3.14 — spikes 2/5 ran on 1.3.14; delta is negligible but trivially re-runnable via the bundled `bun.exe` if wanted. Log line "Custom class failed, falling back to STATIC class" appears once at startup; benign (window still created).

## Spike 4 — Streaming path (Mastra → AG-UI → lm-ag-ui → Streamdown): PASS

`spikes/04-streaming/` — `server/` (Bun.serve) + `ui/` (Vite+React+Tailwind v4).

Stack actually validated (all current versions, resolved 2026-07-21): @mastra/core 1.51 Agent as a pure library (no CLI), model = **AI SDK v7 `MockLanguageModelV4`** (`ai/test`, keyless scripted stream), **@ag-ui/mastra 1.1.1** bridge `.run()` glued to `Bun.serve` via `@ag-ui/encoder` SSE (~30 lines), route `POST /agent/spike` per lm-ag-ui convention; UI = **@itkennel/lm-ag-ui 1.4.0** (from git — **not on public npm**) with @ag-ui/client **0.0.47** (its peer pin) against server-side @ag-ui/* **0.0.57** — the exact version-skew seam the plan flagged.

Verified by curl + Playwright (8/8 checks):

- 401 without bearer token; per-launch token flows via lm-ag-ui `tokenProvider` on **every** request (initial run + tool-result follow-up).
- Wire: `RUN_STARTED` → 38× `TEXT_MESSAGE_CHUNK` → `TOOL_CALL_START/ARGS/END` → `RUN_FINISHED`. 0.0.47 client consumed 0.0.57 server events with no incompat.
- UI text streams incrementally (streaming box grew 24→209 chars in 400ms).
- Frontend tool `confirm_mutation`: renderer = approval card with parsed SQL args; **async-handler pattern** (handler awaits a promise the card's Approve button resolves) → lm-ag-ui auto-dispatches the tool message + `submitToolResults` → server runs a second turn → mock model sees the tool result and streams the wrap-up. `onResult` hook fired with `{"approved":true}`.
- Streamdown 2.5 rendered: Shiki-highlighted SQL block, GFM table, and an interactive **mermaid ER diagram** (SVG with pan/zoom controls). No console errors.
- Screenshots: [mid-stream](phase0-evidence/spike4-streaming.png), [final](phase0-evidence/spike4-final.png).

Gotchas recorded for Phase 1/2:
- `bun install github:Cyronius/lm-ag-ui` fails its `prepare` (vite build) during install because peers aren't present in the isolated build env; fix = run `bun install && bun run vite build` once inside `node_modules/@itkennel/lm-ag-ui` (or prebuild/publish the package). Its `dist/` builds fine (dts step logs TS errors but completes).
- lm-ag-ui has no `sendMessage`; the send pattern is `addMessage` + `agentClient.startNewRun()` + `agentClient.runAgent(...)`.
- Spike used `sendFullHistory: true` because the server is stateless (no Mastra Memory); with LibSQLStore memory in the real app, the default (false) applies.
- Streamdown 2.x needs Tailwind (v4 `@source` globs into its dist) + shadcn-style CSS tokens + plugin packages `@streamdown/code`, `@streamdown/mermaid`; `import "streamdown/styles.css"` only carries animation keyframes.
- Server bridge usage: construct a **fresh** `MastraAgent({ agent })` per request.

## Version pins that Phase 1 should adopt (resolved during this spike)

| Package | Version |
|---|---|
| electrobun | 1.18.1 (bundles Bun 1.3.13) |
| mssql | 11.x (12.x exists — evaluate at Phase 1 start) |
| @azure/identity | 4.10.x |
| @mastra/core | ^1.51.0 |
| @ag-ui/mastra | ^1.1.1 |
| @ag-ui/core / client / encoder (server) | ^0.0.57 |
| @ag-ui/core / client (UI, lm-ag-ui peers) | 0.0.47 |
| ai | ^7.0.34 |
| streamdown / @streamdown/code / @streamdown/mermaid | ^2.5.0 / ^1.1.1 / ^1.0.2 |
| @lancedb/lancedb | ^0.24.0 |
