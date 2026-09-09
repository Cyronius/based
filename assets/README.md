# assets

Design sources. Nothing here is imported at build time — these are the originals that generated
artwork elsewhere in the repo was derived from, kept so it can be regenerated. (The Capi avatar has
no external source: it is authored directly as SVG in `ui/src/components/CapiAvatar.tsx`; preview
every mood at `/?capi` in the dev UI.)

| Path | What it is |
|---|---|
| `icon-source.png` | The 1254x1254 app icon master. Everything in `shell-tauri/icons/` is generated from it by `bun x @tauri-apps/cli icon assets/icon-source.png` — including `icon.ico` (Windows) and `icon.icns` (macOS). Edit this, regenerate, never hand-edit the outputs. |
