//! Embedded web service module
//!
//! This module manages the embedded bamboo-agent HTTP server running within the Tauri app.
//! Instead of using a sidecar process, we run the HTTP server directly in the app process.

use log::info;
use std::sync::Arc;
use std::path::PathBuf;

// Import the server module from bamboo-agent
use bamboo_agent::server::WebService;

/// Embedded web service manager
///
/// Manages the lifecycle of the embedded HTTP server
pub struct EmbeddedWebService {
    port: u16,
    web_service: Arc<tokio::sync::Mutex<WebService>>,
}

impl EmbeddedWebService {
    /// Create a new embedded web service manager
    pub fn new(port: u16, data_dir: PathBuf) -> Self {
        Self {
            port,
            web_service: Arc::new(tokio::sync::Mutex::new(WebService::new(data_dir))),
        }
    }

    /// Start the embedded HTTP server
    ///
    /// This uses bamboo-agent's managed WebService lifecycle to avoid Send constraints.
    pub async fn start(&self) -> Result<(), String> {
        info!("Starting embedded web service on port {}", self.port);

        // Check if already running and start managed service
        {
            let mut service = self.web_service.lock().await;
            if service.is_running() {
                info!("Embedded web service is already running");
                return Ok(());
            }
            service
                .start(self.port)
                .await
                .map_err(|e| format!("Failed to start embedded web service: {}", e))?;
        }

        // Wait a bit for server to start
        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

        // Check if server is healthy
        self.wait_for_health().await?;

        info!(
            "Embedded web service is healthy and ready on port {}",
            self.port
        );
        Ok(())
    }

    /// Stop the embedded HTTP server
    pub async fn stop(&self) -> Result<(), String> {
        info!("Stopping embedded web service");

        let mut service = self.web_service.lock().await;

        if service.is_running() {
            service
                .stop()
                .await
                .map_err(|e| format!("Failed to stop embedded web service: {}", e))?;
            info!("Embedded web service stopped");
        } else {
            info!("No running server to stop");
        }

        Ok(())
    }

    /// Wait for the web service to become healthy
    async fn wait_for_health(&self) -> Result<(), String> {
        let health_url = format!("http://127.0.0.1:{}/api/v1/health", self.port);
        let client = reqwest::Client::new();

        info!(
            "Waiting for embedded service health check at {}",
            health_url
        );

        for attempt in 1..=10 {
            match client
                .get(&health_url)
                .timeout(tokio::time::Duration::from_secs(2))
                .send()
                .await
            {
                Ok(response) if response.status().is_success() => {
                    info!(
                        "Embedded service health check passed on attempt {}",
                        attempt
                    );
                    return Ok(());
                }
                Ok(response) => {
                    info!(
                        "Health check returned status {} on attempt {}",
                        response.status(),
                        attempt
                    );
                }
                Err(e) => {
                    info!(
                        "Health check attempt {} failed: {}. Retrying in 200ms...",
                        attempt, e
                    );
                }
            }

            tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;
        }

        Err("Embedded service failed health check after 10 attempts".to_string())
    }

    /// Check if service is running by testing health endpoint
    pub async fn is_running(&self) -> bool {
        let health_url = format!("http://127.0.0.1:{}/api/v1/health", self.port);
        let client = reqwest::Client::new();

        match client
            .get(&health_url)
            .timeout(tokio::time::Duration::from_secs(2))
            .send()
            .await
        {
            Ok(response) => response.status().is_success(),
            Err(_) => false,
        }
    }
}

impl Drop for EmbeddedWebService {
    fn drop(&mut self) {
        // Note: We can't await in Drop, so we just log
        // The process exit will terminate any remaining background tasks.
        log::info!("EmbeddedWebService being dropped");
    }
}
