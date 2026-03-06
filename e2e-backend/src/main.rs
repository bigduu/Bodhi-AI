//! Standalone web service binary for E2E testing
//!
//! This binary runs the bamboo-agent web service without Tauri for testing purposes.

use std::path::PathBuf;
use anyhow::Context;
use clap::Parser;

#[derive(Parser, Debug)]
#[command(name = "e2e-backend")]
#[command(about = "Standalone web service for E2E testing", long_about = None)]
struct Args {
    /// Port to run the web service on
    #[arg(long, default_value_t = 9562)]
    port: u16,

    /// Directory to store test data
    #[arg(long)]
    data_dir: Option<PathBuf>,

    /// Bind address (127.0.0.1 for local development, 0.0.0.0 for external access)
    #[arg(long, default_value = "127.0.0.1")]
    bind: String,

    /// Optional static dir to serve (dist/ or /app/static)
    #[arg(long)]
    static_dir: Option<PathBuf>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Initialize logging
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    // Parse command line arguments using clap
    let args = Args::parse();

    let port = args.port;
    let data_dir = args
        .data_dir
        .unwrap_or_else(|| std::env::temp_dir().join("bamboo-test-data"));

    // Ensure data directory exists
    std::fs::create_dir_all(&data_dir)
        .with_context(|| format!("Failed to create data directory {:?}", data_dir))?;

    log::info!("Starting web service on port {}", port);
    log::info!("Data directory: {:?}", data_dir);
    log::info!("Bind address: {}", args.bind);
    log::info!("Static directory: {:?}", args.static_dir);

    // Validate static directory if provided
    if let Some(ref static_path) = args.static_dir {
        if !static_path.exists() {
            eprintln!("ERROR: Static directory does not exist: {:?}", static_path);
            anyhow::bail!("Static directory not found: {:?}", static_path);
        }
        if !static_path.is_dir() {
            eprintln!("ERROR: Static path is not a directory: {:?}", static_path);
            anyhow::bail!("Static path is not a directory: {:?}", static_path);
        }
        log::info!("Static directory validated: {:?}", static_path);
    }

    // Run the web service with bind and static file support
    log::info!("Calling bamboo_agent::server::run_with_bind_and_static...");
    bamboo_agent::server::run_with_bind_and_static(
        data_dir,
        port,
        &args.bind,
        args.static_dir,
    )
    .await
    .map_err(|e| anyhow::anyhow!(e))?;

    log::info!("Web service exited successfully");
    Ok(())
}
