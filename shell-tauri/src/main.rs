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
}

/// The spawned core process. None in dev mode, where dev:core runs separately (BASED_DEV_URL).
struct CoreChild(Mutex<Option<Child>>);

/// Mirror of core's dataDir() (core/src/storage/db.ts): %APPDATA%/based unless overridden.
fn data_dir() -> PathBuf {
    if let Ok(d) = std::env::var("BASED_DATA_DIR") {
        return PathBuf::from(d);
    }
    let appdata = std::env::var("APPDATA").unwrap_or_else(|_| ".".into());
    Path::new(&appdata).join("based")
}

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

fn create_window(app: &AppHandle, existing_sid: Option<String>, open_path: Option<String>) {
    let state = app.state::<ShellState>();
    let sid = existing_sid.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let n = state.windows_created.fetch_add(1, Ordering::SeqCst);
    let offset = (n % 8) as f64 * 40.0;
    let open = open_path
        .map(|p| format!("&open={}", urlencoding::encode(&p)))
        .unwrap_or_default();
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

    // Destroyed (not CloseRequested) so programmatic closes also release the core session.
    let base_url = state.base_url.clone();
    let token = state.token.clone();
    win.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) {
            let close = format!("{base_url}/api/session/close?sid={sid}&token={token}");
            std::thread::spawn(move || {
                let _ = ureq::post(&close).timeout(HTTP_TIMEOUT).call();
            });
        }
    });

    if std::env::var("BASED_DEVTOOLS").as_deref() == Ok("1") {
        win.open_devtools();
    }
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
    // Packaged layout: <resources>/{bun/bun.exe, core/index.js, ui/dist}. Dev: run the TS entry
    // from the repo checkout with whatever bun is on PATH.
    let resource_dir = app.path().resource_dir().ok();
    let packaged = resource_dir
        .as_ref()
        .filter(|d| d.join("core").join("index.js").exists())
        .cloned();

    let mut cmd = if let Some(res) = packaged {
        let bun = res.join("bun").join("bun.exe");
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
                    let _ = handle.run_on_main_thread(move || create_window(&h, None, None));
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

    tauri::Builder::default()
        // Single-instance at the OS level: a second launch fires this callback in the primary with
        // the secondary's argv, then exits.
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
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
                create_window(app, None, None);
            } else {
                for f in files {
                    create_window(app, None, Some(f));
                }
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
            });
            app.manage(CoreChild(Mutex::new(child)));

            // Restore ordering: persisted sids first, then explicit file-open requests, and a bare
            // window only if neither produced one — so a launch never opens zero windows.
            let handle = app.handle().clone();
            let restorable: Vec<String> = fetch_persisted_sids(&base_url, &token)
                .into_iter()
                .filter(|s| s != "default")
                .collect();
            for sid in &restorable {
                create_window(&handle, Some(sid.clone()), None);
            }
            for p in &open_requests {
                create_window(&handle, None, Some(p.clone()));
            }
            if restorable.is_empty() && open_requests.is_empty() {
                create_window(&handle, None, None);
            }
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
