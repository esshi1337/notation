use crate::storage::Database;
use serde::Serialize;
use std::fs;
use std::path::{Component, Path, PathBuf};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_file: bool,
    pub editable: bool,
}
#[derive(Debug, Serialize)]
pub struct Directory {
    pub root: String,
    pub path: String,
    pub parent: Option<String>,
    pub entries: Vec<Entry>,
    pub truncated: bool,
}

pub fn workspace_root(database: &Database) -> Result<PathBuf, String> {
    let root = database
        .workspace()?
        .ok_or("Choose a workspace directory first.")?;
    let root = PathBuf::from(root)
        .canonicalize()
        .map_err(|error| format!("Workspace is unavailable: {error}"))?;
    if !root.is_dir() {
        return Err("Workspace is not a directory.".into());
    }
    Ok(root)
}
pub fn resolve(root: &Path, path: &str) -> Result<PathBuf, String> {
    let requested = if Path::new(path).is_absolute() {
        PathBuf::from(path)
    } else {
        root.join(path)
    };
    let mut normalized = PathBuf::new();
    for component in requested.components() {
        match component {
            Component::ParentDir => {
                normalized.pop();
            }
            Component::CurDir => (),
            component => normalized.push(component.as_os_str()),
        }
    }
    let relative = normalized
        .strip_prefix(root)
        .map_err(|_| "Path is outside the selected workspace.")?;
    let mut checked = root.to_path_buf();
    for component in relative.components() {
        checked.push(component.as_os_str());
        let metadata = fs::symlink_metadata(&checked)
            .map_err(|error| format!("Could not inspect {}: {error}", checked.display()))?;
        if metadata.is_symlink() {
            return Err(
                "Symbolic links are not exposed through the workspace explorer or agents.".into(),
            );
        }
    }
    let canonical = normalized
        .canonicalize()
        .map_err(|error| format!("Could not resolve workspace path: {error}"))?;
    if !canonical.starts_with(root) {
        return Err("Path escapes the selected workspace.".into());
    }
    Ok(canonical)
}
/// Validate a deleted Git path against its nearest existing ancestor, while
/// rejecting symlink traversal in every ancestor that still exists.
pub fn resolve_allow_missing(root: &Path, path: &str) -> Result<PathBuf, String> {
    let requested = if Path::new(path).is_absolute() {
        PathBuf::from(path)
    } else {
        root.join(path)
    };
    let mut normalized = PathBuf::new();
    for component in requested.components() {
        match component {
            Component::ParentDir => {
                normalized.pop();
            }
            Component::CurDir => (),
            component => normalized.push(component.as_os_str()),
        }
    }
    let relative = normalized
        .strip_prefix(root)
        .map_err(|_| "Path is outside the selected workspace.")?;
    let mut checked = root.to_path_buf();
    for component in relative.components() {
        checked.push(component.as_os_str());
        match fs::symlink_metadata(&checked) {
            Ok(metadata) if metadata.is_symlink() => {
                return Err("Symbolic links are not exposed through workspace operations.".into())
            }
            Ok(_) => {
                let canonical = checked.canonicalize().map_err(|error| error.to_string())?;
                if !canonical.starts_with(root) {
                    return Err("Path escapes the selected workspace.".into());
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(normalized)
}
pub fn list_directory(database: &Database, path: Option<&str>) -> Result<Directory, String> {
    let root = workspace_root(database)?;
    let path = resolve(&root, path.unwrap_or("."))?;
    if !path.is_dir() {
        return Err("Choose a directory to list its children.".into());
    }
    let mut entries = Vec::new();
    let mut truncated = false;
    for entry in
        fs::read_dir(&path).map_err(|error| format!("Could not list directory: {error}"))?
    {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let kind = entry.file_type().map_err(|error| error.to_string())?;
        if kind.is_symlink()
            || name.starts_with('.')
            || kind.is_dir()
                && matches!(
                    name.as_str(),
                    "node_modules"
                        | "target"
                        | "dist"
                        | "build"
                        | "vendor"
                        | "coverage"
                        | "__pycache__"
                )
        {
            continue;
        }
        if !kind.is_dir() && !kind.is_file() {
            continue;
        }
        if entries.len() >= 2000 {
            truncated = true;
            break;
        }
        let editable = kind.is_file()
            && matches!(
                entry
                    .path()
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .map(str::to_ascii_lowercase)
                    .as_deref(),
                Some("md" | "markdown" | "mmd" | "txt" | "canvas")
            );
        entries.push(Entry {
            name,
            path: entry.path().to_string_lossy().into(),
            is_dir: kind.is_dir(),
            is_file: kind.is_file(),
            editable,
        });
    }
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(Directory {
        root: root.to_string_lossy().into(),
        path: path.to_string_lossy().into(),
        parent: if path == root {
            None
        } else {
            path.parent().map(|path| path.to_string_lossy().into())
        },
        entries,
        truncated,
    })
}
pub fn read_workspace_file(
    database: &Database,
    path: &str,
) -> Result<crate::documents::Document, String> {
    use std::io::Read;
    let root = workspace_root(database)?;
    let path = resolve(&root, path)?;
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file = options
        .open(&path)
        .map_err(|error| format!("Could not read file: {error}"))?;
    if !file
        .metadata()
        .map_err(|error| error.to_string())?
        .is_file()
    {
        return Err("Choose a regular text file.".into());
    }
    let mut bytes = Vec::new();
    file.take((crate::storage::MAX_CONTENT + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() > crate::storage::MAX_CONTENT {
        return Err("Agent file reads are limited to 4 MiB.".into());
    }
    Ok(crate::documents::Document {
        path: path.to_string_lossy().into(),
        content: String::from_utf8(bytes).map_err(|_| "File is not valid UTF-8 text.")?,
        warning: None,
    })
}
