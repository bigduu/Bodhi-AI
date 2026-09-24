use base64::{engine::general_purpose::STANDARD, Engine as _};
use std::io::Read;
use std::path::Path;
use tauri::{Url, WebviewWindow};

const MAX_IMAGE_BYTES: u64 = 10 * 1024 * 1024;

fn trusted_chat_origin(url: &Url, backend_port: u16, debug_build: bool) -> bool {
    if url.scheme() != "http" {
        return false;
    }
    if !matches!(url.host_str(), Some("localhost" | "127.0.0.1")) {
        return false;
    }
    url.port_or_known_default() == Some(backend_port)
        || (debug_build && url.port_or_known_default() == Some(1420))
}

fn raster_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

fn open_image(path: &Path) -> Result<std::fs::File, String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW)
            .open(path)
            .map_err(|_| "Image could not be opened".into())
    }
    #[cfg(not(unix))]
    std::fs::File::open(path).map_err(|_| "Image could not be opened".into())
}

fn read_image_data_url(path: &Path) -> Result<String, String> {
    if !path.is_absolute() {
        return Err("Image path must be absolute".into());
    }
    // A Markdown path must not cause Windows to authenticate to a remote SMB
    // share or use a device namespace when the transcript is rendered.
    #[cfg(windows)]
    {
        let raw = path.as_os_str().to_string_lossy();
        if raw.starts_with(r"\\") || raw.starts_with("//") {
            return Err("Network and device image paths are unavailable".into());
        }
    }
    let path_metadata =
        std::fs::symlink_metadata(path).map_err(|_| "Image could not be inspected")?;
    if !path_metadata.file_type().is_file() {
        return Err("Image path must point to a regular file".into());
    }
    let file = open_image(path)?;
    let metadata = file
        .metadata()
        .map_err(|_| "Image could not be inspected")?;
    if !metadata.is_file() {
        return Err("Image path must point to a regular file".into());
    }
    if metadata.len() > MAX_IMAGE_BYTES {
        return Err("Image exceeds the 10 MiB preview limit".into());
    }

    // Bound the actual read too: a file can grow after the metadata check.
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_IMAGE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Image could not be read")?;
    if bytes.len() as u64 > MAX_IMAGE_BYTES {
        return Err("Image exceeds the 10 MiB preview limit".into());
    }
    let mime = raster_mime(&bytes).ok_or("Unsupported image format")?;
    Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}

/// Resolve a local image only for Bodhi's own chat webview. No general asset
/// protocol or broad filesystem plugin scope is exposed to Markdown content.
#[tauri::command]
pub async fn read_local_image(window: WebviewWindow, path: String) -> Result<String, String> {
    let url = window
        .url()
        .map_err(|_| "Image preview origin is unavailable")?;
    if window.label() != "main"
        || !trusted_chat_origin(&url, crate::web_service_port(), cfg!(debug_assertions))
    {
        return Err("Image preview is unavailable from this window".into());
    }
    tokio::task::spawn_blocking(move || read_image_data_url(Path::new(&path)))
        .await
        .map_err(|_| "Image preview failed")?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_the_managed_chat_origin() {
        let url = |value: &str| Url::parse(value).unwrap();
        assert!(trusted_chat_origin(
            &url("http://127.0.0.1:9562/chat"),
            9562,
            false
        ));
        assert!(trusted_chat_origin(
            &url("http://localhost:1420/"),
            9562,
            true
        ));
        assert!(!trusted_chat_origin(
            &url("http://localhost:1420/"),
            9562,
            false
        ));
        assert!(!trusted_chat_origin(
            &url("http://localhost:9999/"),
            9562,
            true
        ));
        assert!(!trusted_chat_origin(
            &url("https://localhost:9562/"),
            9562,
            true
        ));
        assert!(!trusted_chat_origin(
            &url("http://example.com:9562/"),
            9562,
            true
        ));
    }

    #[test]
    fn reads_supported_raster_bytes_as_data_url() {
        for (bytes, mime) in [
            (b"\x89PNG\r\n\x1a\nimage".as_slice(), "image/png"),
            (b"\xff\xd8\xffimage".as_slice(), "image/jpeg"),
            (b"GIF89aimage".as_slice(), "image/gif"),
            (b"RIFF1234WEBPimage".as_slice(), "image/webp"),
        ] {
            let file = tempfile::NamedTempFile::new().unwrap();
            std::fs::write(file.path(), bytes).unwrap();
            assert_eq!(
                read_image_data_url(file.path()).unwrap(),
                format!("data:{mime};base64,{}", STANDARD.encode(bytes))
            );
        }
    }

    #[test]
    fn rejects_relative_non_image_and_oversized_files() {
        assert!(read_image_data_url(Path::new("relative.png")).is_err());
        let file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(file.path(), b"<svg onload=alert(1) />").unwrap();
        assert!(read_image_data_url(file.path()).is_err());
        file.as_file().set_len(MAX_IMAGE_BYTES + 1).unwrap();
        assert!(read_image_data_url(file.path()).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_named_pipes_without_waiting_for_a_writer() {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;

        let dir = tempfile::tempdir().unwrap();
        let fifo = dir.path().join("picture.png");
        let c_path = CString::new(fifo.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) }, 0);
        assert!(read_image_data_url(&fifo).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn rejects_unc_and_device_paths_before_opening_them() {
        for path in [r"\\server\share\image.png", r"\\?\C:\image.png"] {
            assert_eq!(
                read_image_data_url(Path::new(path)),
                Err("Network and device image paths are unavailable".into())
            );
        }
    }
}
