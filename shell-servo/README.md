# based with Servo

## Current Servo preview

```sh
bun run servo:latest
# Or use the Bun binary from the existing local bundle automatically:
bash scripts/dev-servo-latest.sh
```

This launches the actual based UI and Bun backend in the official Servo **0.7.0**
demo shell, the latest stable release checked on 2026-10-25. It is a separate
preview from the Tauri runtime below. The current Tauri/Verso runtime cannot
control the newer demo executable through its existing IPC protocol.

The Linux x86_64 release is pinned in `servo-release.json`. The launcher verifies
its SHA-256 before extraction, checks the executable version, and builds the
frontend into `ui/dist-servo-latest`. It needs Bun, tar, and internet access for
the initial download; it does not compile Rust or Servo. Dibs coordinates preparation
and rendering when installed. Pass `--build-only` to prepare without opening a
window.

Data is isolated under `shell-servo/target/latest-data` (override with
`BASED_DATA_DIR`). Each window gets its own browser profile; core listens on an
automatically assigned loopback port behind a fresh token. Closing the last
window stops the core. Ctrl+C stops all preview windows and core together.
`BASED_DEVTOOLS=1` prints a loopback Firefox remote debugging address.

Verified with this binary: the workspace mounts, Settings and the connection form
open, the frontend reaches backend health successfully, and CSS Grid performs a
two-column layout correctly. The new-window action starts another working window;
closing the last window shuts down its backend and releases its ports. The
first-run downloader, frontend typechecking, and launcher typechecking also pass.
AbortController and
ResizeObserver are available natively. Monaco additionally needs the experimental
entry's fallback for the missing deprecated `document.queryCommandSupported`
capability probe. It reports the unsupported capability as false. OffscreenCanvas
is not exposed by default; the embeddings atlas and real database workflows have
not been validated. The demo preview does not provide the Tauri native-dialog
bridge, desktop registration, or release packaging.

## Tauri/Verso experiment

This experimental launcher renders the actual based UI with Servo through
[`tauri-runtime-verso`](https://github.com/versotile-org/tauri-runtime-verso).
Tauri controls the app and its native dialogs; a prebuilt `versoview` child process
supplies the web engine. The Bun core still handles databases, files, and the agent.

From the repository root:

```sh
bun run servo
# Or, if Bun is only available in the existing local bundle:
bash scripts/dev-servo.sh
```

The script rebuilds the frontend and this shell, then starts based. It uses Dibs
for compilation/downloads when Dibs is installed. Pass `--build-only` to compile
without opening a window. Bun, a recent Rust toolchain (edition 2024 support), and
the native Tauri/GTK development dependencies are required. The build downloads
the matching prebuilt Versoview engine, rather than compiling Servo.
The Servo frontend is built into `ui/dist-servo`; the normal `ui/dist` build is
separate. Its entry loads AbortController/fetch and ResizeObserver shims before
loading the app. The AbortController shim rejects aborted requests but does not
stop their underlying network connections.

This is a separate Cargo project because the runtime currently pins Tauri 2.7.0.
The normal shell retains its existing dependencies and lockfile. Both launchers
share `shell-tauri/src/app.rs`, including window lifecycle and native dialogs.
The experimental app identifier is separate, and data defaults to
`shell-servo/target/data`. Test connections must be added separately; the normal
app's settings and session state are not loaded.

Useful overrides:

```sh
# Load an existing frontend dev server instead of starting a Bun core child.
# Start it with `bun run --cwd ui dev --mode servo`; core must already be running
# behind its /api proxy. Coordinate the fixed dev ports with Dibs.
BASED_DEV_URL=http://localhost:5183 bun run servo

# Use a locally built engine instead of the downloaded binary.
BASED_VERSO_PATH=/absolute/path/to/versoview bun run servo

# Enable Servo's remote debugging server (connect using Firefox about:debugging).
BASED_DEVTOOLS=1 bun run servo
```

`BASED_DATA_DIR` can override the isolated test directory. The test directory does
not isolate the OS credential store; use test credentials for test connections.

Verified locally: the Servo shell compiles, the actual workspace mounts, Settings
and the new-connection form open, and the UI receives a successful backend health
response. UI typechecking and the normal frontend production build also pass.

The prebuilt Versoview 0.0.9 engine reports no CSS Grid or OffscreenCanvas support.
It originally failed at module startup because AbortController was not exposed;
the experimental shims get the UI running. Compatibility still needs to be
established for Monaco, the canvas data grid, Web Workers, SSE/WebSockets, and
the WebGL embeddings atlas. No database connections or AI requests were made
during this smoke test. This environment used Mesa software rendering, so the
startup check establishes no hardware rendering or performance result.

Verso's runtime has incomplete window/webview APIs and an upstream caveat about
capability checks for remote content. Keep this experiment pointed at based's own
loopback UI. See the runtime's README for its current limitations.

