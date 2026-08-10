# assets

Design sources. Nothing here is imported at build time — these are the originals that generated
artwork elsewhere in the repo was derived from, kept so it can be regenerated.

| Path | What it is |
|---|---|
| `icon-source.png` | The 1254x1254 app icon master. Everything in `shell-tauri/icons/` is generated from it by `bun x @tauri-apps/cli icon assets/icon-source.png` — including `icon.ico` (Windows) and `icon.icns` (macOS). Edit this, regenerate, never hand-edit the outputs. |
| `capi/` | The original layered capybara artwork for "Ask Capi" — `capy-demo.html` plus the eye/eyebrow SVGs. The shipping avatar inlines these paths as JSX in [`ui/src/components/CapiAvatar.tsx`](../ui/src/components/CapiAvatar.tsx); this is the provenance for the poses. |
