#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

#[path = "../../shell-tauri/src/app.rs"]
mod app;

fn main() {
    // Keep experimental sessions separate from the installed app's databases and window state.
    if std::env::var_os("BASED_DATA_DIR").is_none() {
        std::env::set_var(
            "BASED_DATA_DIR",
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target/data"),
        );
    }
    if std::env::var_os("BASED_WEBVIEW_DATA_DIR").is_none() {
        let data = std::path::PathBuf::from(std::env::var_os("BASED_DATA_DIR").unwrap());
        std::env::set_var("BASED_WEBVIEW_DATA_DIR", data.join("webview"));
    }
    if std::env::var_os("BASED_UI_DIST").is_none() {
        std::env::set_var(
            "BASED_UI_DIST",
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../ui/dist-servo"),
        );
    }

    let engine = std::env::var_os("BASED_VERSO_PATH")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("versoview")
                .join(format!(
                    "versoview-{}{}",
                    env!("BASED_SERVO_TARGET"),
                    std::env::consts::EXE_SUFFIX
                ))
        });
    if let Some(resources) = engine
        .parent()
        .map(|p| p.join("resources"))
        .filter(|p| p.is_dir())
    {
        tauri_runtime_verso::set_verso_resource_directory(resources);
    }
    tauri_runtime_verso::set_verso_path(engine);
    if std::env::var("BASED_DEVTOOLS").as_deref() == Ok("1") {
        // This engine version logs "port 0" without reporting the assigned port.
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0))
            .expect("failed to choose a Servo devtools port");
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        tauri_runtime_verso::set_verso_devtools_port(port);
        eprintln!("based Servo devtools: connect Firefox to localhost:{port}");
    }
    eprintln!("based: experimental Servo rendering via Verso");
    app::run(tauri_runtime_verso::builder(), tauri::generate_context!());
}
