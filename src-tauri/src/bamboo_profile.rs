use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};

#[derive(Clone)]
pub(crate) struct Profile {
    pub data: PathBuf,
    pub state_dir: PathBuf,
}

impl Profile {
    pub fn open(data: &Path) -> io::Result<Self> {
        let data = data.canonicalize()?;
        let state_dir = data.join(".bodhi-kernel");
        create_directory(&state_dir)?;
        Ok(Self { data, state_dir })
    }

    pub fn writer(&self) -> Result<File, String> {
        exclusive_file(&self.state_dir.join("writer.lock")).map_err(|error| {
            format!("Cannot open the Bamboo profile {}. Close any Bodhi instance using this data directory and try again. ({error})", self.data.display())
        })
    }

    pub fn update_lock(&self) -> Result<File, String> {
        exclusive_file(&self.state_dir.join("update.lock"))
            .map_err(|error| format!("Cannot lock the Bamboo update state: {error}"))
    }
}

pub(crate) fn create_directory(path: &Path) -> io::Result<()> {
    match fs::create_dir(path) {
        Ok(()) => sync_directory(path.parent().expect("state directory parent")),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            if fs::symlink_metadata(path)?.is_dir() {
                Ok(())
            } else {
                Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "expected an owned directory",
                ))
            }
        }
        Err(error) => Err(error),
    }
}

fn exclusive_file(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.create(true).truncate(false).read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW).mode(0o600);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;
        // The share restriction stays in force for the lifetime of the file
        // object, including when the child inherits the same handle as stdin.
        options
            .share_mode(0)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(path)?;
    if !file.metadata()?.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "expected a regular lock file",
        ));
    }
    #[cfg(unix)]
    file.try_lock().map_err(io::Error::from)?;
    Ok(file)
}

fn sync_directory(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    File::open(path)?.sync_all()?;
    #[cfg(windows)]
    let _ = path;
    Ok(())
}

pub(crate) fn persist(file: tempfile::TempPath, destination: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        file.persist(destination).map_err(|error| error.error)?;
        sync_directory(destination.parent().expect("checkpoint parent"))?;
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            MoveFileExW, SetFileAttributesW, FILE_ATTRIBUTE_NORMAL, MOVEFILE_REPLACE_EXISTING,
            MOVEFILE_WRITE_THROUGH,
        };
        let source: Vec<u16> = file
            .canonicalize()?
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect();
        let destination = destination
            .parent()
            .expect("checkpoint parent")
            .canonicalize()?
            .join(destination.file_name().expect("checkpoint filename"));
        let destination: Vec<u16> = destination
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect();
        // These are adjacent, NUL-terminated paths. Clear NamedTempFile's
        // temporary attribute before the write-through rename.
        if unsafe { SetFileAttributesW(source.as_ptr(), FILE_ATTRIBUTE_NORMAL) } == 0 {
            return Err(io::Error::last_os_error());
        }
        if unsafe {
            MoveFileExW(
                source.as_ptr(),
                destination.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}

#[cfg(all(test, windows))]
#[test]
fn the_committed_checkpoint_is_a_regular_windows_file() {
    use std::os::windows::fs::MetadataExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_TEMPORARY;

    let directory = tempfile::tempdir().unwrap();
    let destination = directory.path().join("state.json");
    let checkpoint = tempfile::NamedTempFile::new_in(directory.path()).unwrap();
    checkpoint.as_file().sync_all().unwrap();
    persist(checkpoint.into_temp_path(), &destination).unwrap();
    let attributes = fs::metadata(destination).unwrap().file_attributes();
    assert_eq!(attributes & FILE_ATTRIBUTE_TEMPORARY, 0);
}
