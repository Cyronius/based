fn main() {
    tauri_runtime_verso_build::get_verso_as_external_bin()
        .expect("failed to download the matching prebuilt versoview engine");
    println!(
        "cargo:rustc-env=BASED_SERVO_TARGET={}",
        std::env::var("TARGET").unwrap()
    );
    tauri_build::build();
}
