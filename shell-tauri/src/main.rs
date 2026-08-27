// based — the native shell. Duty list: start core, open one window per sid at a tokened URL,
// forward window lifecycle to core over loopback HTTP. All app logic stays in core; the page never
// gets Tauri IPC (windows load External URLs, so the Tauri API is not injected — core keeps every
// secret).
#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{mpsc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};

const HTTP_TIMEOUT: Duration = Duration::from_secs(5);

struct ShellState {
    base_url: String,
    token: String,
    windows_created: AtomicUsize,
    /// (sid, window label), most-recently-focused first — the dispatch target for
    /// current-window file opens (BASED-SQL-OPEN-TARGET). Maintained by window events.
    focus_order: Mutex<Vec<(String, String)>>,
}

/// The spawned core process. None in dev mode, where dev:core runs separately (BASED_DEV_URL).
struct CoreChild(Mutex<Option<Child>>);

/// BASED-PLATFORM-PATHS: mirror of core's appDataRoot()/dataDir() (core/src/storage/db.ts).
/// %APPDATA%\based on Windows, ~/Library/Application Support/based on macOS, unless overridden.
/// Change this and the TypeScript side together — the shell reads pending-open.txt from the
/// directory core writes it to, so a drift between them silently breaks file-open-at-launch.
///
/// `cfg!` (not `#[cfg]`) so both branches type-check on every host; the dead one is optimized out.
fn data_dir() -> PathBuf {
    if let Ok(d) = std::env::var("BASED_DATA_DIR") {
        return PathBuf::from(d);
    }
    if cfg!(target_os = "macos") {
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
        Path::new(&home)
            .join("Library")
            .join("Application Support")
            .join("based")
    } else {
        let appdata = std::env::var("APPDATA").unwrap_or_else(|_| ".".into());
        Path::new(&appdata).join("based")
    }
}

/// The bundled Bun runtime's filename, as written by shell-tauri/bundle-core.ts.
const BUN_EXE: &str = if cfg!(windows) { "bun.exe" } else { "bun" };

/// Read + delete <dataDir>/pending-open.txt, keeping lines that are existing files. Written by the
/// legacy based-open.exe stub registration (see BASED-OPEN-SQL-ARGV); consumed here so a mid-upgrade
/// machine whose .sql association still points at the old stub keeps working.
fn consume_pending_opens() -> Vec<String> {
    let file = data_dir().join("pending-open.txt");
    let Ok(raw) = std::fs::read_to_string(&file) else {
        return vec![];
    };
    let _ = std::fs::remove_file(&file);
    raw.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && Path::new(l).exists())
        .map(str::to_owned)
        .collect()
}

fn create_window(app: &AppHandle, existing_sid: Option<String>, open_paths: &[String]) {
    let state = app.state::<ShellState>();
    let sid = existing_sid.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let n = state.windows_created.fetch_add(1, Ordering::SeqCst);
    let offset = (n % 8) as f64 * 40.0;
    // BASED-OPEN-SQL-ARGV: one repeated `open=` param per file — a whole batch rides one window.
    let open: String = open_paths
        .iter()
        .map(|p| format!("&open={}", urlencoding::encode(p)))
        .collect();
    let url: tauri::Url = match format!(
        "{}/#token={}&sid={}{}",
        state.base_url, state.token, sid, open
    )
    .parse()
    {
        Ok(u) => u,
        Err(e) => {
            eprintln!("based shell: bad window url: {e}");
            return;
        }
    };

    let label = format!("based-{n}");
    let built = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url))
        .title("based")
        .inner_size(1680.0, 1000.0)
        .position(120.0 + offset, 80.0 + offset)
        .build();
    let win = match built {
        Ok(w) => w,
        Err(e) => {
            eprintln!("based shell: window create failed: {e}");
            return;
        }
    };

    state
        .focus_order
        .lock()
        .unwrap()
        .insert(0, (sid.clone(), label.clone()));

    // Destroyed (not CloseRequested) so programmatic closes also release the core session.
    let base_url = state.base_url.clone();
    let token = state.token.clone();
    let app_handle = app.clone();
    win.on_window_event(move |event| match event {
        WindowEvent::Focused(true) => {
            if let Some(state) = app_handle.try_state::<ShellState>() {
                let mut order = state.focus_order.lock().unwrap();
                if let Some(pos) = order.iter().position(|(s, _)| s == &sid) {
                    let entry = order.remove(pos);
                    order.insert(0, entry);
                }
            }
        }
        WindowEvent::Destroyed => {
            if let Some(state) = app_handle.try_state::<ShellState>() {
                state.focus_order.lock().unwrap().retain(|(s, _)| s != &sid);
            }
            let close = format!("{base_url}/api/session/close?sid={sid}&token={token}");
            std::thread::spawn(move || {
                let _ = ureq::post(&close).timeout(HTTP_TIMEOUT).call();
            });
        }
        _ => {}
    });

    if std::env::var("BASED_DEVTOOLS").as_deref() == Ok("1") {
        win.open_devtools();
    }
}

/// BASED-SQL-OPEN-TARGET: where a file-open batch lands, read fresh per batch so a settings
/// change applies without a restart. Any failure means the default.
fn fetch_open_target(base_url: &str, token: &str) -> String {
    let url = format!("{base_url}/api/settings?token={token}");
    let fallback = || "current-window".to_string();
    let Ok(resp) = ureq::get(&url).timeout(HTTP_TIMEOUT).call() else {
        return fallback();
    };
    let Ok(body) = resp.into_string() else {
        return fallback();
    };
    serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|v| {
            v.get("sqlFileOpenTarget")
                .and_then(|s| s.as_str())
                .map(str::to_owned)
        })
        .unwrap_or_else(fallback)
}

/// Send one deduped file-open batch where the setting says (BASED-SQL-OPEN-TARGET): as tabs in the
/// last-focused window (relayed through core, since the page has no Tauri IPC), or into ONE new
/// window carrying the whole batch. Runs on the batcher thread.
fn dispatch_open_batch(app: &AppHandle, paths: Vec<String>) {
    if paths.is_empty() {
        return;
    }
    let state = app.state::<ShellState>();
    let base_url = state.base_url.clone();
    let token = state.token.clone();
    let front = state.focus_order.lock().unwrap().first().cloned();
    drop(state);
    if fetch_open_target(&base_url, &token) == "current-window" {
        if let Some((sid, label)) = front {
            let body = serde_json::json!({ "sid": sid, "paths": paths }).to_string();
            let url = format!("{base_url}/api/open-files?token={token}");
            let sent = ureq::post(&url)
                .timeout(HTTP_TIMEOUT)
                .set("content-type", "application/json")
                .send_string(&body);
            if sent.is_ok() {
                let app2 = app.clone();
                let _ = app.run_on_main_thread(move || {
                    if let Some(w) = app2.get_webview_window(&label) {
                        let _ = w.set_focus();
                    }
                });
                return;
            }
            // Relay failed — fall through to a new window rather than dropping the open.
        }
    }
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || create_window(&app2, None, &paths));
}

/// BASED-WINDOW-RESTORE: sids that were still open when the app last exited.
fn fetch_persisted_sids(base_url: &str, token: &str) -> Vec<String> {
    let url = format!("{base_url}/api/windows?token={token}");
    let Ok(resp) = ureq::get(&url).timeout(HTTP_TIMEOUT).call() else {
        return vec![];
    };
    let Ok(body) = resp.into_string() else {
        return vec![];
    };
    serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|v| {
            v.as_array().map(|arr| {
                arr.iter()
                    .filter_map(|w| w.get("sid").and_then(|s| s.as_str()).map(str::to_owned))
                    .collect()
            })
        })
        .unwrap_or_default()
}

struct CoreInfo {
    url: String,
    token: String,
}

/// Dev runs resolve the repo root from the exe path (shell-tauri/target/<profile>/based-shell.exe).
fn repo_root_from_exe() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    exe.ancestors()
        .find(|d| d.join("package.json").exists() && d.join("core").is_dir())
        .map(Path::to_path_buf)
}

/// Spawn core as a child process and wait for its BASED_CORE_READY handshake line. Replaces the
/// in-process startServer() call the Bun shell makes; the onRequestNewWindow callback becomes a
/// BASED_EVENT line on the child's stdout (read by a thread for the life of the process).
fn spawn_core(app: &tauri::App) -> Result<(CoreInfo, Child), String> {
    // Packaged layout: <resources>/{bun/<BUN_EXE>, core/index.js, ui/dist} — the exe dir on Windows,
    // based.app/Contents/Resources on macOS. Dev: run the TS entry from the repo checkout with
    // whatever bun is on PATH.
    let resource_dir = app.path().resource_dir().ok();
    let packaged = resource_dir
        .as_ref()
        .filter(|d| d.join("core").join("index.js").exists())
        .cloned();

    let mut cmd = if let Some(res) = packaged {
        let bun = res.join("bun").join(BUN_EXE);
        let program = if bun.exists() {
            bun.into_os_string()
        } else {
            "bun".into()
        };
        let mut c = Command::new(program);
        c.arg(res.join("core").join("index.js"));
        c.current_dir(&res);
        c
    } else {
        let root = repo_root_from_exe()
            .or_else(|| std::env::current_dir().ok())
            .ok_or("could not locate repo root")?;
        let mut c = Command::new("bun");
        c.arg("shell-tauri/core-child.ts");
        c.current_dir(&root);
        c
    };

    // CREATE_NO_WINDOW: bun.exe is a console-subsystem exe; without this, launching the
    // windows-subsystem shell pops a console window for the child. Piped/inherited handles
    // still work, so dev-terminal output is unaffected.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }

    let mut child = cmd
        .stdin(Stdio::piped()) // held open; EOF tells core the shell is gone (crash backstop)
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("failed to spawn core (is bun on PATH?): {e}"))?;

    let stdout = child.stdout.take().ok_or("core child has no stdout")?;
    let (tx, rx) = mpsc::channel::<String>();
    let handle = app.handle().clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if let Some(rest) = line.strip_prefix("BASED_CORE_READY ") {
                let _ = tx.send(rest.to_string());
            } else if let Some(rest) = line.strip_prefix("BASED_EVENT ") {
                let parsed: serde_json::Value = serde_json::from_str(rest).unwrap_or_default();
                if parsed.get("type").and_then(|t| t.as_str()) == Some("new-window") {
                    let h = handle.clone();
                    let _ = handle.run_on_main_thread(move || create_window(&h, None, &[]));
                }
            } else {
                println!("[core] {line}");
            }
        }
    });

    let ready = rx
        .recv_timeout(Duration::from_secs(60))
        .map_err(|_| "core did not print BASED_CORE_READY within 60s".to_string())?;
    let v: serde_json::Value =
        serde_json::from_str(&ready).map_err(|e| format!("bad BASED_CORE_READY line: {e}"))?;
    let url = v["url"].as_str().ok_or("ready line missing url")?.to_string();
    let token = v["token"]
        .as_str()
        .ok_or("ready line missing token")?
        .to_string();
    Ok((CoreInfo { url, token }, child))
}

fn main() {
    // BASED-OPEN-SQL-ARGV: files this launch was asked to open. The exe receives argv directly, so
    // the association points at it; the pending-opens file is kept only for compatibility with the
    // legacy based-open.exe stub registration.
    let open_requests: Vec<String> = std::env::args()
        .skip(1)
        .filter(|a| !a.starts_with('-') && Path::new(a).exists())
        .chain(consume_pending_opens())
        .collect();

    // BASED-OPEN-SQL-ARGV: file-open batching. Explorer launches one process per selected file, so
    // one multi-select arrives as N near-simultaneous single-instance callbacks — they all feed
    // this channel, and a batcher thread (spawned in setup, once core's URL is known) accumulates
    // until ~300ms of silence before dispatching once. The channel needs no Tauri state, so a
    // callback firing before setup completes is safe.
    let (open_tx, open_rx) = mpsc::channel::<Vec<String>>();
    let cb_tx = open_tx.clone();

    tauri::Builder::default()
        // Single-instance at the OS level: a second launch fires this callback in the primary with
        // the secondary's argv, then exits.
        .plugin(tauri_plugin_single_instance::init(move |app, argv, cwd| {
            let mut files: Vec<String> = argv
                .iter()
                .skip(1)
                .filter(|a| !a.starts_with('-'))
                .map(|a| {
                    let p = Path::new(a);
                    if p.is_absolute() {
                        a.clone()
                    } else {
                        Path::new(&cwd).join(p).to_string_lossy().into_owned()
                    }
                })
                .filter(|a| Path::new(a).exists())
                .collect();
            files.extend(consume_pending_opens());
            if files.is_empty() {
                // A plain re-launch still opens a bare window immediately — no batching delay.
                create_window(app, None, &[]);
            } else {
                let _ = cb_tx.send(files);
            }
        }))
        .setup(move |app| {
            let (base_url, token, child) = if let Ok(dev_url) = std::env::var("BASED_DEV_URL") {
                let token = std::env::var("BASED_TOKEN").unwrap_or_else(|_| "dev".into());
                println!("based shell (tauri): dev mode -> {dev_url} (core from dev:core)");
                (dev_url, token, None)
            } else {
                let (info, child) = spawn_core(app)?;
                println!("based core listening on {}", info.url);
                (info.url, info.token, Some(child))
            };

            app.manage(ShellState {
                base_url: base_url.clone(),
                token: token.clone(),
                windows_created: AtomicUsize::new(0),
                focus_order: Mutex::new(Vec::new()),
            });
            app.manage(CoreChild(Mutex::new(child)));

            // Restore ordering: persisted sids first, then the file-open batch (via the batcher, so
            // a cold multi-select's sibling processes coalesce with the primary's own argv), and a
            // bare window only if neither produced one — so a launch never opens zero windows.
            let handle = app.handle().clone();
            let restorable: Vec<String> = fetch_persisted_sids(&base_url, &token)
                .into_iter()
                .filter(|s| s != "default")
                .collect();
            for sid in &restorable {
                create_window(&handle, Some(sid.clone()), &[]);
            }
            if !open_requests.is_empty() {
                let _ = open_tx.send(open_requests.clone());
            }
            if restorable.is_empty() && open_requests.is_empty() {
                create_window(&handle, None, &[]);
            }

            // The batcher: block for a first chunk, keep accumulating until 300ms of silence,
            // dedupe preserving order, dispatch, repeat.
            let batcher_handle = app.handle().clone();
            std::thread::spawn(move || {
                while let Ok(first) = open_rx.recv() {
                    let mut batch = first;
                    while let Ok(more) = open_rx.recv_timeout(Duration::from_millis(300)) {
                        batch.extend(more);
                    }
                    let mut seen = std::collections::HashSet::new();
                    batch.retain(|p| seen.insert(p.clone()));
                    dispatch_open_batch(&batcher_handle, batch);
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("based shell: failed to build tauri app")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(state) = app.try_state::<CoreChild>() {
                    if let Some(mut child) = state.0.lock().unwrap().take() {
                        let _ = child.kill();
                        let _ = child.wait();
                    }
                }
            }
        });
}
