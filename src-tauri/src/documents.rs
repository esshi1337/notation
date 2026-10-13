use serde::Serialize;
use std::fs::{self, File};
use std::io::Write;
use std::path::Path;
use tempfile::NamedTempFile;

#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct Document {
    pub path: String,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

fn document_path(path: &str) -> Result<&Path, String> {
    if path.trim().is_empty() {
        return Err("Choose a file before opening or saving a document.".into());
    }
    Ok(Path::new(path))
}
pub fn resolve_document_path(path: &str) -> Result<String, String> {
    let path = document_path(path)?;
    let resolved = if path.exists() {
        path.canonicalize()
            .map_err(|error| format!("Could not resolve document path: {error}"))?
    } else {
        let parent = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        parent
            .canonicalize()
            .map_err(|error| format!("Could not resolve destination directory: {error}"))?
            .join(path.file_name().ok_or("Choose a file name.")?)
    };
    resolved
        .to_str()
        .map(str::to_string)
        .ok_or_else(|| "The canonical file path is not valid UTF-8.".into())
}

pub fn read_document(path: &str) -> Result<Document, String> {
    let file_path = document_path(path)?;
    let metadata =
        fs::metadata(file_path).map_err(|error| format!("Could not open {path}: {error}"))?;
    if !metadata.is_file() {
        return Err(format!("Could not open {path}: choose a regular file."));
    }
    let canonical = file_path
        .canonicalize()
        .map_err(|error| format!("Could not resolve {path}: {error}"))?;
    let canonical_path = canonical
        .to_str()
        .ok_or("The canonical file path is not valid UTF-8.")?;
    let content = fs::read_to_string(&canonical)
        .map_err(|error| format!("Could not read {path} as UTF-8 text: {error}"))?;
    Ok(Document {
        path: canonical_path.into(),
        content,
        warning: None,
    })
}

/// Stage content beside the destination and replace it only after a successful flush.
/// An interrupted write leaves the previous document intact until the final rename.
pub fn write_document(path: &str, content: &str) -> Result<Document, String> {
    let file_path = document_path(path)?;
    let parent = file_path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));

    let existing = match fs::symlink_metadata(file_path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() {
                return Err("Saving through symbolic links is not supported. Use Save As to choose a regular file.".into());
            }
            if !metadata.is_file() {
                return Err(format!("Could not save {path}: choose a regular file."));
            }
            if metadata.permissions().readonly() {
                return Err(format!("Could not save {path}: the file is read-only."));
            }
            Some(metadata)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("Could not inspect {path}: {error}")),
    };

    let save_error = |error| format!("Could not save {path}: {error}");
    let mut temporary = NamedTempFile::new_in(parent).map_err(save_error)?;
    temporary
        .write_all(content.as_bytes())
        .map_err(save_error)?;
    if let Some(metadata) = existing {
        temporary
            .as_file()
            .set_permissions(metadata.permissions())
            .map_err(save_error)?;
    }
    temporary.as_file().sync_all().map_err(save_error)?;
    temporary.persist(file_path).map_err(|error| {
        format!("Could not replace {path}; the previous file was kept: {error}")
    })?;

    // On Unix, syncing the directory also persists the rename across a system crash.
    // Once the rename succeeds the save has happened; do not report a misleading
    // failure if the filesystem cannot sync directories.
    #[cfg(unix)]
    if let Ok(directory) = File::open(parent) {
        let _ = directory.sync_all();
    }

    Ok(Document {
        path: resolve_document_path(path).unwrap_or_else(|_| path.into()),
        content: content.into(),
        warning: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn round_trips_markdown_and_mermaid_as_utf8() {
        let directory = tempdir().unwrap();
        for (name, content) in [
            ("notas.md", "# Notación\n\n日本語 · 🖋️\n"),
            ("diagram.mmd", "flowchart LR\n  A[Inicio] --> B[Fin]\n"),
        ] {
            let path = directory.path().join(name);
            let path = path.to_str().unwrap();
            let saved = write_document(path, content).unwrap();
            assert_eq!(saved, read_document(path).unwrap());
            assert_eq!(saved.content, content);
            assert_eq!(saved.path, path);
        }
    }

    #[test]
    fn replacing_a_document_removes_old_trailing_content_and_temporary_files() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("notes.md");
        fs::write(&path, "A much longer old document").unwrap();
        write_document(path.to_str().unwrap(), "new").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "new");
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
        write_document(path.to_str().unwrap(), "").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"");
    }

    #[test]
    fn reports_missing_files_and_invalid_utf8_without_replacing_content() {
        let directory = tempdir().unwrap();
        let missing = directory.path().join("missing.md");
        assert!(read_document(missing.to_str().unwrap())
            .unwrap_err()
            .contains("Could not open"));
        let invalid = directory.path().join("invalid.md");
        fs::write(&invalid, [0xff, 0xfe]).unwrap();
        assert!(read_document(invalid.to_str().unwrap())
            .unwrap_err()
            .contains("UTF-8"));
        assert_eq!(fs::read(&invalid).unwrap(), [0xff, 0xfe]);
    }

    #[test]
    fn rejects_empty_paths_directories_and_missing_parents() {
        let directory = tempdir().unwrap();
        assert!(read_document(" ").is_err());
        assert!(write_document("", "text").is_err());
        let path = directory.path().to_str().unwrap();
        assert!(read_document(path).is_err());
        assert!(write_document(path, "text").is_err());
        let missing_parent = directory.path().join("missing").join("notes.md");
        assert!(write_document(missing_parent.to_str().unwrap(), "text").is_err());
        assert!(!missing_parent.exists());
    }

    #[test]
    fn read_only_file_is_preserved_when_a_save_is_rejected() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("notes.md");
        fs::write(&path, "original").unwrap();
        let original_permissions = fs::metadata(&path).unwrap().permissions();
        let mut read_only = original_permissions.clone();
        read_only.set_readonly(true);
        fs::set_permissions(&path, read_only).unwrap();
        let result = write_document(path.to_str().unwrap(), "replacement");
        fs::set_permissions(&path, original_permissions).unwrap();
        assert!(result.unwrap_err().contains("read-only"));
        assert_eq!(fs::read_to_string(&path).unwrap(), "original");
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn preserves_existing_file_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempdir().unwrap();
        let path = directory.path().join("notes.md");
        fs::write(&path, "original").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
        write_document(path.to_str().unwrap(), "replacement").unwrap();
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o640
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_saves_without_replacing_link_or_target() {
        use std::os::unix::fs::symlink;
        let directory = tempdir().unwrap();
        let target = directory.path().join("target.md");
        let link = directory.path().join("link.md");
        fs::write(&target, "original").unwrap();
        symlink(&target, &link).unwrap();
        assert!(write_document(link.to_str().unwrap(), "replacement")
            .unwrap_err()
            .contains("symbolic links"));
        assert!(fs::symlink_metadata(&link).unwrap().is_symlink());
        assert_eq!(fs::read_to_string(target).unwrap(), "original");
    }
}
