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
        .ok_or("This virtual workspace has no repository root. Select a file/repository or a legacy folder workspace for Git operations.")?;
    let root = PathBuf::from(root)
        .canonicalize()
        .map_err(|error| format!("Workspace is unavailable: {error}"))?;
    if !root.is_dir() {
        return Err("Workspace is not a directory.".into());
    }
    Ok(root)
}
/// Pin each directory while opening: a concurrent ancestor swap must not turn a
/// previously validated member into a symlink traversal at the actual read.
pub(crate) fn open_regular(path: &Path) -> Result<fs::File, String> {
    #[cfg(unix)]
    let file = {
        use std::{
            ffi::CString,
            os::{
                fd::{AsRawFd, FromRawFd},
                unix::ffi::OsStrExt,
            },
        };
        if !path.is_absolute() {
            return Err("Workspace reads require an absolute path.".into());
        }
        let mut directory = fs::File::open("/").map_err(|e| e.to_string())?;
        let components = path
            .components()
            .filter_map(|part| match part {
                Component::Normal(name) => Some(Ok(name)),
                Component::RootDir => None,
                _ => Some(Err("Workspace reads require a normalized path.")),
            })
            .collect::<Result<Vec<_>, _>>()?;
        let mut result = None;
        for (index, component) in components.iter().enumerate() {
            let name =
                CString::new(component.as_bytes()).map_err(|_| "File paths cannot contain NUL.")?;
            let last = index + 1 == components.len();
            let flags = libc::O_RDONLY
                | libc::O_NOFOLLOW
                | libc::O_CLOEXEC
                | if last {
                    libc::O_NONBLOCK
                } else {
                    libc::O_DIRECTORY
                };
            // SAFETY: live pinned directory fd and a NUL-terminated component;
            // ownership of each successful fd is transferred exactly once.
            let fd = unsafe { libc::openat(directory.as_raw_fd(), name.as_ptr(), flags) };
            if fd < 0 {
                return Err(format!(
                    "Could not read {} without symbolic links: {}",
                    path.display(),
                    std::io::Error::last_os_error()
                ));
            }
            let opened = unsafe { fs::File::from_raw_fd(fd) };
            if last {
                result = Some(opened);
            } else {
                directory = opened;
            }
        }
        result.ok_or("Choose a regular file, not a filesystem root.")?
    };
    #[cfg(not(unix))]
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    if !file.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err("Choose a regular file.".into());
    }
    Ok(file)
}
/// macOS keeps `/var`, `/tmp` and `/etc` as system-owned symbolic links into
/// `/private`. Paths under them (the default temporary directory, for one)
/// would be refused by the symlink checks below, so they are first rewritten
/// to the directories they name. No other symbolic link is ever followed.
const SYSTEM_ALIASES: &[(&str, &str)] = if cfg!(target_os = "macos") {
    &[
        ("/var", "/private/var"),
        ("/tmp", "/private/tmp"),
        ("/etc", "/private/etc"),
    ]
} else {
    &[]
};
/// The aliases that really are links to their expected targets on this host.
static VERIFIED_ALIASES: std::sync::LazyLock<Vec<(&str, &str)>> = std::sync::LazyLock::new(|| {
    SYSTEM_ALIASES
        .iter()
        .copied()
        .filter(|(alias, target)| {
            fs::symlink_metadata(alias).is_ok_and(|metadata| metadata.is_symlink())
                && fs::canonicalize(alias).is_ok_and(|resolved| resolved == Path::new(target))
        })
        .collect()
});
/// Replace a leading alias component with its target; whole components only.
pub(crate) fn rewrite_aliases(path: &Path, aliases: &[(&str, &str)]) -> PathBuf {
    for (alias, target) in aliases {
        if let Ok(rest) = path.strip_prefix(alias) {
            return Path::new(target).join(rest);
        }
    }
    path.to_path_buf()
}
pub(crate) fn system_path(path: &Path) -> PathBuf {
    rewrite_aliases(path, &VERIFIED_ALIASES)
}
pub fn resolve(root: &Path, path: &str) -> Result<PathBuf, String> {
    let root = &system_path(root);
    let requested = if Path::new(path).is_absolute() {
        system_path(Path::new(path))
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
    let root = &system_path(root);
    let requested = if Path::new(path).is_absolute() {
        system_path(Path::new(path))
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
    let scope = database.active_workspace()?;
    if scope.legacy_root.is_none() {
        if path.is_some_and(|path| path != scope.id && path != scope.name && path != ".") {
            return Err("Virtual workspaces list explicit file references only; directory traversal is not permitted.".into());
        }
        let entries = scope
            .files
            .iter()
            .map(|path| Entry {
                name: Path::new(path)
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned(),
                path: path.clone(),
                is_dir: false,
                is_file: true,
                editable: matches!(
                    Path::new(path).extension().and_then(|s| s.to_str()),
                    Some("md" | "markdown" | "mmd" | "txt" | "canvas")
                ),
            })
            .collect();
        return Ok(Directory {
            root: scope.id.clone(),
            path: scope.id,
            parent: None,
            entries,
            truncated: false,
        });
    }
    let root = workspace_root(database)?;
    let at_root =
        path.is_none() || path == Some(".") || path == Some(root.to_string_lossy().as_ref());
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
    if at_root {
        for file in &scope.files {
            if entries.iter().any(|entry| entry.path == *file) {
                continue;
            }
            entries.push(Entry {
                name: Path::new(file)
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned(),
                path: file.clone(),
                is_dir: false,
                is_file: true,
                editable: matches!(
                    Path::new(file).extension().and_then(|s| s.to_str()),
                    Some("md" | "markdown" | "mmd" | "txt" | "canvas")
                ),
            });
        }
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
    let scope = database.active_workspace()?;
    read_scoped_file(&scope, path)
}
pub(crate) fn read_scoped_file(
    scope: &crate::workspace_catalog::WorkspaceRecord,
    path: &str,
) -> Result<crate::documents::Document, String> {
    use std::io::Read;
    let path = scope.resolve(path)?;
    let file = open_regular(&path)?;
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

#[cfg(test)]
mod alias_tests {
    use super::*;

    #[test]
    fn system_aliases_rewrite_whole_leading_components_only() {
        let mac = [("/var", "/private/var"), ("/tmp", "/private/tmp")];
        let rewrite = |path: &str| rewrite_aliases(Path::new(path), &mac);
        assert_eq!(rewrite("/var/folders/x/note.md"), Path::new("/private/var/folders/x/note.md"));
        assert_eq!(rewrite("/var"), Path::new("/private/var"));
        assert_eq!(rewrite("/tmp/a b/ü.md"), Path::new("/private/tmp/a b/ü.md"));
        for unchanged in ["/variable/x", "/private/var/x", "/Users/var/x", "/home/tmp", "relative/var", "/"] {
            assert_eq!(rewrite(unchanged), Path::new(unchanged), "{unchanged}");
        }
        // Without a table (every platform but macOS) nothing is rewritten.
        assert_eq!(rewrite_aliases(Path::new("/var/x"), &[]), Path::new("/var/x"));
        if !cfg!(target_os = "macos") {
            assert_eq!(system_path(Path::new("/var/x")), Path::new("/var/x"));
            assert_eq!(system_path(Path::new("/tmp/x")), Path::new("/tmp/x"));
        }
    }

    // The default macOS temporary directory is under the /var alias.
    #[cfg(target_os = "macos")]
    #[test]
    fn files_under_the_var_alias_resolve_to_their_private_path() {
        let directory = tempfile::tempdir_in("/var/tmp").unwrap();
        let note = directory.path().join("note.md");
        fs::write(&note, "# Note\n").unwrap();
        assert!(note.starts_with("/var/tmp"));
        let resolved = resolve(directory.path(), note.to_str().unwrap()).unwrap();
        assert!(resolved.starts_with("/private/var/tmp"), "{resolved:?}");
        assert_eq!(resolved, note.canonicalize().unwrap());
        let reference = crate::workspace_catalog::normalize_reference(note.to_str().unwrap()).unwrap();
        assert!(reference.starts_with("/private/var/tmp"), "{reference:?}");
        // A user-made symbolic link is still refused.
        let link = directory.path().join("link.md");
        std::os::unix::fs::symlink(&note, &link).unwrap();
        assert!(resolve(directory.path(), link.to_str().unwrap()).is_err());
        assert!(crate::workspace_catalog::normalize_reference(link.to_str().unwrap()).is_err());
    }
}
