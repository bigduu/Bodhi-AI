use serde::{Deserialize, Serialize};
use std::{fs, path::Path};
use tauri::utils::config::WindowConfig;
use tauri::{App, AppHandle, LogicalSize, Manager, Runtime, WebviewWindowBuilder};

const FILE_NAME: &str = "main-window-size.json";

/// Dimensions in logical pixels so the size is independent of display scaling.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
pub(crate) struct WindowSize {
    width: f64,
    height: f64,
}

impl WindowSize {
    fn valid(self) -> bool {
        self.width.is_finite() && self.height.is_finite() && self.width > 0.0 && self.height > 0.0
    }

    fn load(dir: &Path) -> Option<Self> {
        let bytes = fs::read(dir.join(FILE_NAME)).ok()?;
        let size: Self = serde_json::from_slice(&bytes).ok()?;
        size.valid().then_some(size)
    }

    fn write(self, dir: &Path) -> anyhow::Result<()> {
        fs::create_dir_all(dir)?;
        let file = tempfile::NamedTempFile::new_in(dir)?;
        serde_json::to_writer(file.as_file(), &self)?;
        file.persist(dir.join(FILE_NAME))?;
        Ok(())
    }

    fn apply(self, config: &mut WindowConfig, work_area: LogicalSize<f64>) {
        config.width = self
            .width
            .min(work_area.width)
            .max(config.min_width.unwrap_or(1.0));
        config.height = self
            .height
            .min(work_area.height)
            .max(config.min_height.unwrap_or(1.0));
    }
}

pub(crate) fn create_main_window<R: Runtime>(app: &App<R>) -> tauri::Result<()> {
    let Some(mut config) = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == "main")
        .cloned()
    else {
        return Ok(());
    };
    if let Some(size) = app
        .path()
        .app_local_data_dir()
        .ok()
        .and_then(|dir| WindowSize::load(&dir))
    {
        let monitor = app
            .primary_monitor()
            .ok()
            .flatten()
            .or_else(|| app.available_monitors().ok()?.into_iter().next());
        if let Some(monitor) = monitor {
            let work_area = monitor.work_area().size.to_logical(monitor.scale_factor());
            if work_area.width > 0.0 && work_area.height > 0.0 {
                size.apply(&mut config, work_area);
            }
        }
    }
    // Apply the size before the first visible frame, using the configured centering.
    WebviewWindowBuilder::from_config(app, &config)?.build()?;
    Ok(())
}

pub(crate) fn capture<R: Runtime>(app: &AppHandle<R>) -> Option<WindowSize> {
    let window = app.get_webview_window("main")?;
    if window.is_minimized().ok()? || window.is_fullscreen().ok()? {
        return None;
    }
    let size = window
        .inner_size()
        .ok()?
        .to_logical(window.scale_factor().ok()?);
    let size = WindowSize {
        width: size.width,
        height: size.height,
    };
    size.valid().then_some(size)
}

pub(crate) fn save<R: Runtime>(
    app: &AppHandle<R>,
    last_window_size: Option<WindowSize>,
) -> anyhow::Result<()> {
    // A close request can destroy the window before Exit. Keep the last measured size.
    if let Some(size) = capture(app).or(last_window_size) {
        size.write(&app.path().app_local_data_dir()?)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saves_and_replaces_the_last_logical_size() {
        let dir = tempfile::tempdir().unwrap();
        let dir = dir.path().join("app");
        let first = WindowSize {
            width: 1300.5,
            height: 850.0,
        };
        let last = WindowSize {
            width: 1512.0,
            height: 982.5,
        };
        first.write(&dir).unwrap();
        assert_eq!(WindowSize::load(&dir), Some(first));
        last.write(&dir).unwrap();
        assert_eq!(WindowSize::load(&dir), Some(last));
    }

    #[test]
    fn ignores_missing_corrupt_and_zero_sized_preferences() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(WindowSize::load(dir.path()), None);
        for bytes in [r#"{broken"#, r#"{"width":0,"height":900}"#] {
            fs::write(dir.path().join(FILE_NAME), bytes).unwrap();
            assert_eq!(WindowSize::load(dir.path()), None);
        }
    }

    #[test]
    fn fits_saved_size_to_the_display_and_configured_minimum() {
        let mut config = WindowConfig {
            min_width: Some(960.0),
            min_height: Some(640.0),
            ..Default::default()
        };
        let size = WindowSize {
            width: 1800.0,
            height: 825.5,
        };
        size.apply(&mut config, LogicalSize::new(1920.0, 1080.0));
        assert_eq!((config.width, config.height), (1800.0, 825.5));
        size.apply(&mut config, LogicalSize::new(1440.0, 800.0));
        assert_eq!((config.width, config.height), (1440.0, 800.0));
        size.apply(&mut config, LogicalSize::new(800.0, 600.0));
        assert_eq!((config.width, config.height), (960.0, 640.0));
    }
}
