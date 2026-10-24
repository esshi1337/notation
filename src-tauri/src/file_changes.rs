//! Guard ordinary saves against stale editor baselines. The final replacement is
//! atomic; this is a content comparison, not an OS-wide lock on other editors.
use crate::{documents::Document, launch, storage};

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
