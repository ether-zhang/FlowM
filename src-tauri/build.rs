fn main() {
    println!(
        "cargo:rustc-env=FLOWM_TARGET={}",
        std::env::var("TARGET").unwrap()
    );
    tauri_build::build()
}
