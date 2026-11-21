//! Guard ordinary saves against stale editor baselines. The final replacement is
//! atomic; this is a content comparison, not an OS-wide lock on other editors.
use crate::{documents::Document, launch, storage};

/// What identifies a file's current content cheaply: its size, modification
/// time and identity. The editor polls this instead of reading the file, and
/// reads the content only when it changed. Numbers are strings so 64-bit
/// values survive JSON.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Fingerprint {
    pub size: String,
    /// Nanoseconds since the Unix epoch.
    pub modified_ns: String,
    pub device: String,
    pub inode: String,
}

pub fn fingerprint(path: &str) -> Result<Fingerprint, String> {
    let supplied = std::path::Path::new(path);
    if path.is_empty() || !supplied.is_absolute() {
        return Err("A document fingerprint requires an absolute local file path.".into());
    }
    // Like the content read, do not follow a link in the last component.
    let metadata = std::fs::symlink_metadata(supplied)
        .map_err(|error| format!("Could not inspect the document: {error}"))?;
    if !metadata.is_file() {
        return Err("The document is not a regular file.".into());
    }
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |duration| duration.as_nanos());
    #[cfg(unix)]
    let (device, inode) = {
        use std::os::unix::fs::MetadataExt;
        (metadata.dev(), metadata.ino())
    };
    #[cfg(not(unix))]
    let (device, inode) = (0u64, 0u64);
    Ok(Fingerprint {
        size: metadata.len().to_string(),
        modified_ns: modified.to_string(),
        device: device.to_string(),
        inode: inode.to_string(),
    })
}

pub fn write_checked(
    path: &str,
    content: &str,
    expected: &str,
    database: &Result<storage::Database, String>,
) -> Result<Document, String> {
    if content.len() > storage::MAX_CONTENT || expected.len() > storage::MAX_CONTENT {
        return Err("Document exceeds the 4 MiB editor limit.".into());
    }
    let disk = launch::read_document(path)
        .map_err(|error| format!("Cannot verify the disk file. Your buffer is unchanged; use Save As to create a copy. {error}"))?;
    if disk.content != expected {
        return Err("File changed on disk. Compare or reload it before saving, or use Save As to keep a separate copy.".into());
    }
    storage::write_with_metadata(&disk.path, content, database)
}
