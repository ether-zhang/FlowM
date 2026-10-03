mod auth;
mod kernel;
mod models;
mod provider;
mod responses_bridge;
mod server;
mod sessions;
mod state;

use codex_core_api::Arg0DispatchPaths;
use std::path::PathBuf;

fn main() -> anyhow::Result<()> {
    if std::env::args().any(|arg| arg == "--version") {
        println!(
            "flowm-harness {} ({})",
            env!("CARGO_PKG_VERSION"),
            state::UPSTREAM_REVISION
        );
        return Ok(());
    }
    // arg0 creates helper paths before the Tokio runtime. Set the private home before it can
    // resolve any upstream path. Child helpers inherit this setting, never the user's Codex home.
    let args: Vec<String> = std::env::args().collect();
    let home = args
        .windows(2)
        .find(|args| args[0] == "--home")
        .map(|args| PathBuf::from(&args[1]))
        .or_else(|| std::env::var_os("FLOWM_HARNESS_HOME").map(PathBuf::from))
        .ok_or_else(|| anyhow::anyhow!("FlowM harness requires --home or FLOWM_HARNESS_HOME"))?;
    if !home.is_absolute() {
        anyhow::bail!("FlowM harness home must be absolute");
    }
    std::fs::create_dir_all(home.join("helpers"))?;
    // SAFETY: main has not started any threads; the values are set before arg0/runtime startup.
    unsafe {
        std::env::set_var("FLOWM_HARNESS_HOME", &home);
        std::env::set_var("CODEX_HOME", home.join("helpers"));
    }
    codex_core_api::arg0_dispatch_or_else(run)
}

async fn run(paths: Arg0DispatchPaths) -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_max_level(tracing::Level::WARN)
        .try_init()
        .ok();
    codex_core_api::set_default_originator(provider::ORIGINATOR.to_owned()).ok();
    server::serve(
        PathBuf::from(std::env::var_os("FLOWM_HARNESS_HOME").unwrap()),
        paths,
    )
    .await
}
