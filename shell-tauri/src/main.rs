// The shell implementation is shared with the experimental Servo launcher.
#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

mod app;

fn main() {
    app::run(tauri::Builder::default(), tauri::generate_context!());
}
