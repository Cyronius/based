# Phase 0 validation spikes

Throwaway code with binary pass/fail gates. Results recorded in
[specs/based/phase0-results.md](../specs/based/phase0-results.md) — read that, not this.

- `01-electrobun-hello/` — Electrobun on Windows: window, dense text UI (DPI check), devtools, hot reload, webview → localhost URL.
- `02-tedious-bun/` — tedious/mssql in-process under Bun vs Node against Azure SQL (Entra token auth, pool latency, clean close).
- `03-entra-interactive/` — InteractiveBrowserCredential (system browser + loopback listener) under Bun. **Interactive — run it yourself.**
- `04-streaming/` — Mastra agent → AG-UI bridge on Bun.serve → lm-ag-ui + Streamdown in a Vite webview; frontend tool round-trip; per-launch token.
- `05-lancedb/` — @lancedb/lancedb napi binding under Bun on Windows.

Delete this directory once Phase 1 is underway.
