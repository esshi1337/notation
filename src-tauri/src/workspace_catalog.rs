//! Named workspaces are references, never filesystem containers.
use crate::storage::{clear_cache, Database};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRecord {
    pub id: String,
    pub name: String,
    pub files: Vec<String>,
    pub legacy_root: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceCatalog {
    pub active_id: Option<String>,
    pub workspaces: Vec<WorkspaceRecord>,
}
fn error(error: impl std::fmt::Display) -> String {
    error.to_string()
}
pub(crate) fn catalog(connection: &Connection) -> Result<WorkspaceCatalog, String> {
    let active_id = connection
        .query_row(
            "SELECT active_id FROM workspace_selection WHERE id=1",
            [],
            |r| r.get(0),
        )
        .map_err(error)?;
    let mut statement = connection
        .prepare("SELECT id,name,legacy_root FROM named_workspaces ORDER BY rowid")
        .map_err(error)?;
    let rows = statement
        .query_map([], |r| {
            Ok(WorkspaceRecord {
                id: r.get(0)?,
                name: r.get(1)?,
                legacy_root: r.get(2)?,
                files: vec![],
            })
        })
        .map_err(error)?;
    let mut workspaces = Vec::new();
    for row in rows {
        let mut record = row.map_err(error)?;
        let mut files = connection
            .prepare("SELECT path FROM workspace_members WHERE workspace_id=?1 ORDER BY path")
            .map_err(error)?;
        record.files = files
            .query_map([&record.id], |r| r.get(0))
            .map_err(error)?
            .collect::<Result<_, _>>()
            .map_err(error)?;
        workspaces.push(record);
    }
    Ok(WorkspaceCatalog {
        active_id,
        workspaces,
    })
}
pub(crate) fn revision(connection: &Connection) -> Result<i64, String> {
    connection
        .query_row(
            "SELECT revision FROM workspace_selection WHERE id=1",
            [],
            |r| r.get(0),
        )
        .map_err(error)
}
pub(crate) fn validate_index_snapshot(
    connection: &Connection,
    scope: &WorkspaceRecord,
    expected_revision: i64,
) -> Result<(), String> {
    let active: Option<String> = connection
        .query_row(
            "SELECT active_id FROM workspace_selection WHERE id=1",
            [],
            |r| r.get(0),
        )
        .map_err(error)?;
    if active.as_deref() != Some(&scope.id) || revision(connection)? != expected_revision {
        return Err("Workspace identity or membership changed during indexing. Refresh the active workspace.".into());
    }
    Ok(())
}
fn name(value: &str) -> Result<&str, String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > 120 || value.chars().any(char::is_control) {
        return Err("Workspace names must contain 1–120 non-control characters.".into());
    }
    Ok(value)
}
pub(crate) fn legacy_name(root: &str) -> String {
    let value = Path::new(root)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("Workspace");
    let value = value
        .trim()
        .chars()
        .filter(|c| !c.is_control())
        .take(120)
        .collect::<String>();
    if value.is_empty() {
        "Workspace".into()
    } else {
        value
    }
}
/// Reject symlinks in every component, not just the final filename.
pub(crate) fn absolute_file(value: &str) -> Result<PathBuf, String> {
    let path = Path::new(value);
    if value.len() > 4096 || !path.is_absolute() {
        return Err("Add an absolute regular-file path.".into());
    }
    let path = normalize_reference(value)?;
    let path = crate::explorer::resolve(Path::new("/"), &path.to_string_lossy())?;
    if !path.is_file() {
        return Err("Workspace references must be regular files.".into());
    }
    Ok(path)
}
/// Normalize relative segments only after checking the original traversal.
/// In particular `symlink/../member` must never erase a symlink check.
pub(crate) fn normalize_reference(value: &str) -> Result<PathBuf, String> {
    if value.len() > 4096 || !Path::new(value).is_absolute() {
        return Err("File references require an absolute path.".into());
    }
    let value = crate::explorer::system_path(Path::new(value));
    let mut result = PathBuf::new();
    for part in value.components() {
        match part {
            Component::ParentDir => {
                result.pop();
            }
            Component::CurDir => (),
            part => {
                result.push(part.as_os_str());
                match std::fs::symlink_metadata(&result) {
                    Ok(metadata) if metadata.is_symlink() => {
                        return Err(
                            "Symbolic links are not exposed through workspace operations.".into(),
                        )
                    }
                    Ok(_) => (),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
                    Err(e) => return Err(format!("Could not inspect {}: {e}", result.display())),
                }
            }
        }
    }
    Ok(result)
}
impl WorkspaceRecord {
    pub(crate) fn source_path(&self, value: &str) -> Result<PathBuf, String> {
        if let Ok(path) = self.resolve(value) {
            return Ok(path);
        }
        if let Some(root) = &self.legacy_root {
            let requested = if Path::new(value).is_absolute() {
                PathBuf::from(value)
            } else {
                Path::new(root).join(value)
            };
            let normalized = normalize_reference(&requested.to_string_lossy())?;
            return crate::explorer::resolve_allow_missing(
                Path::new(root),
                &normalized.to_string_lossy(),
            );
        }
        self.resolve(value)
    }
    pub(crate) fn source_folder(&self, source: Option<&str>) -> Result<PathBuf, String> {
        if let Some(source) = source {
            let path = self.source_path(source)?;
            let parent = path.parent().ok_or("Source note needs a parent folder.")?;
            return crate::explorer::resolve(Path::new("/"), &parent.to_string_lossy());
        }
        Ok(self
            .legacy_root
            .as_ref()
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/")))
    }
    /// Coordinate system for pure link calculations, NOT a permission boundary.
    pub(crate) fn link_root(&self) -> PathBuf {
        match &self.legacy_root {
            Some(root)
                if self
                    .files
                    .iter()
                    .all(|file| Path::new(file).starts_with(root)) =>
            {
                PathBuf::from(root)
            }
            _ => PathBuf::from("/"),
        }
    }
    pub(crate) fn resolve(&self, value: &str) -> Result<PathBuf, String> {
        let requested = if Path::new(value).is_absolute() {
            PathBuf::from(value)
        } else if let Some(root) = &self.legacy_root {
            Path::new(root).join(value)
        } else {
            return Err("Virtual workspace file references require absolute member paths.".into());
        };
        let normalized = normalize_reference(&requested.to_string_lossy())?;
        if self.files.iter().any(|file| Path::new(file) == normalized) {
            return absolute_file(&normalized.to_string_lossy());
        }
        if let Some(root) = &self.legacy_root {
            return crate::explorer::resolve(Path::new(root), &normalized.to_string_lossy());
        }
        Err("File is not an explicit member of the active workspace. Add it first.".into())
    }
}
impl Database {
    pub fn list_workspaces(&self) -> Result<WorkspaceCatalog, String> {
        let connection = self.lock()?;
        let tx = connection.unchecked_transaction().map_err(error)?;
        let result = catalog(&tx)?;
        tx.commit().map_err(error)?;
        Ok(result)
    }
    pub(crate) fn active_workspace(&self) -> Result<WorkspaceRecord, String> {
        let catalog = self.list_workspaces()?;
        catalog
            .workspaces
            .into_iter()
            .find(|w| Some(&w.id) == catalog.active_id.as_ref())
            .ok_or_else(|| "Select a named workspace first.".into())
    }
    pub(crate) fn workspace_snapshot(&self) -> Result<(WorkspaceRecord, i64), String> {
        let connection = self.lock()?;
        // SQLite snapshot, not merely the process-local mutex: another process
        // may hold its own connection to this database.
        let tx = connection.unchecked_transaction().map_err(error)?;
        let catalog = catalog(&tx)?;
        let record = catalog
            .workspaces
            .into_iter()
            .find(|w| Some(&w.id) == catalog.active_id.as_ref())
            .ok_or("Select a named workspace first.")?;
        let revision = revision(&tx)?;
        tx.commit().map_err(error)?;
        Ok((record, revision))
    }
    fn edit_catalog(
        &self,
        operation: impl FnOnce(&Connection) -> Result<(), String>,
    ) -> Result<WorkspaceCatalog, String> {
        // Index first, then state (the order everywhere). Holding the index
        // writer keeps a rebuild from committing rows for the old selection
        // after this change.
        let index = self.index_lock()?;
        let mut connection = self.lock()?;
        let tx = connection.transaction().map_err(error)?;
        operation(&tx)?;
        tx.execute(
            "UPDATE workspace_selection SET revision=revision+1 WHERE id=1",
            [],
        )
        .map_err(error)?;
        tx.execute("DELETE FROM workspaces", []).map_err(error)?;
        tx.execute("INSERT INTO workspaces(id,path) SELECT 1,legacy_root FROM named_workspaces WHERE id=(SELECT active_id FROM workspace_selection WHERE id=1) AND legacy_root IS NOT NULL",[]).map_err(error)?;
        let result = catalog(&tx)?;
        // The index was built for the previous selection or membership.
        // Empty it before the change becomes visible, so no query can pair
        // the new selection with old rows. If the commit below fails the
        // index is merely empty and is rebuilt on demand.
        clear_cache(&index)?;
        tx.commit().map_err(error)?;
        Ok(result)
    }
    pub fn create_workspace(&self, value: &str) -> Result<WorkspaceCatalog, String> {
        let value = name(value)?;
        self.edit_catalog(|tx| {
            let count:i64 = tx.query_row("SELECT count(*) FROM named_workspaces",[],|r|r.get(0)).map_err(error)?;
            if count>=1000 { return Err("At most 1,000 workspaces are supported.".into()); }
            tx.execute("INSERT INTO named_workspaces(id,name) VALUES(lower(hex(randomblob(16))),?1)",[value]).map_err(error)?;
            tx.execute("UPDATE workspace_selection SET active_id=(SELECT id FROM named_workspaces WHERE rowid=last_insert_rowid()) WHERE id=1",[]).map_err(error)?;
            Ok(())
        })
    }
    pub fn select_workspace(&self, id: &str) -> Result<WorkspaceCatalog, String> {
        self.edit_catalog(|tx| {
            require(tx, id)?;
            tx.execute(
                "UPDATE workspace_selection SET active_id=?1 WHERE id=1",
                [id],
            )
            .map_err(error)?;
            Ok(())
        })
    }
    pub fn rename_workspace(&self, id: &str, value: &str) -> Result<WorkspaceCatalog, String> {
        let value = name(value)?;
        self.edit_catalog(|tx| {
            require(tx, id)?;
            tx.execute(
                "UPDATE named_workspaces SET name=?2 WHERE id=?1",
                params![id, value],
            )
            .map_err(error)?;
            Ok(())
        })
    }
    pub fn delete_workspace(&self, id: &str) -> Result<WorkspaceCatalog, String> {
        self.edit_catalog(|tx| { require(tx,id)?;tx.execute("DELETE FROM named_workspaces WHERE id=?1",[id]).map_err(error)?;
            tx.execute("UPDATE workspace_selection SET active_id=(SELECT id FROM named_workspaces ORDER BY rowid LIMIT 1) WHERE id=1 AND active_id=?1",[id]).map_err(error)?;Ok(()) })
    }
    pub fn add_workspace_files(
        &self,
        id: &str,
        paths: &[String],
    ) -> Result<WorkspaceCatalog, String> {
        if paths.len() > 10000 {
            return Err("At most 10,000 file references are supported.".into());
        }
        let paths = paths
            .iter()
            .map(|p| {
                absolute_file(p).and_then(|p| {
                    p.to_str()
                        .map(str::to_owned)
                        .ok_or("File path must be UTF-8.".into())
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        self.edit_catalog(|tx| {
            require(tx, id)?;
            for path in paths {
                tx.execute(
                    "INSERT OR IGNORE INTO workspace_members(workspace_id,path) VALUES(?1,?2)",
                    params![id, path],
                )
                .map_err(error)?;
            }
            let count: i64 = tx
                .query_row(
                    "SELECT count(*) FROM workspace_members WHERE workspace_id=?1",
                    [id],
                    |r| r.get(0),
                )
                .map_err(error)?;
            if count > 10000 {
                return Err("At most 10,000 file references are supported.".into());
            }
            Ok(())
        })
    }
    pub fn remove_workspace_file(&self, id: &str, path: &str) -> Result<WorkspaceCatalog, String> {
        self.edit_catalog(|tx| {
            require(tx, id)?;
            if tx
                .execute(
                    "DELETE FROM workspace_members WHERE workspace_id=?1 AND path=?2",
                    params![id, path],
                )
                .map_err(error)?
                == 0
            {
                return Err("File is not a workspace member.".into());
            }
            Ok(())
        })
    }
    pub(crate) fn select_legacy_workspace(&self, path: &str) -> Result<(), String> {
        self.edit_catalog(|tx| {
            let existing:Option<String>=tx.query_row("SELECT id FROM named_workspaces WHERE legacy_root=?1",[path],|r|r.get(0)).optional().map_err(error)?;
            let id=match existing {Some(id)=>id,None=>{
                let count:i64=tx.query_row("SELECT count(*) FROM named_workspaces",[],|r|r.get(0)).map_err(error)?;
                if count>=1000 { return Err("At most 1,000 workspaces are supported.".into()); }
                let label=legacy_name(path);
                tx.execute("INSERT INTO named_workspaces(id,name,legacy_root) VALUES(lower(hex(randomblob(16))),?1,?2)",params![label,path]).map_err(error)?;
                tx.query_row("SELECT id FROM named_workspaces WHERE rowid=last_insert_rowid()",[],|r|r.get(0)).map_err(error)?
            }};
            tx.execute("UPDATE workspace_selection SET active_id=?1 WHERE id=1",[id]).map_err(error)?;Ok(())
        })?;
        Ok(())
    }
}
fn require(tx: &Connection, id: &str) -> Result<(), String> {
    if id.len() > 128 {
        return Err("Invalid workspace ID.".into());
    }
    let exists: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM named_workspaces WHERE id=?1)",
            [id],
            |r| r.get(0),
        )
        .map_err(error)?;
    if !exists {
        return Err("Workspace does not exist.".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn index_commit_rejects_membership_changes_and_switch_away_and_back() {
        let temp = tempfile::tempdir().unwrap();
        let db = Database::open(&temp.path().join("app/db.sqlite")).unwrap();
        let first = db.create_workspace("First").unwrap().active_id.unwrap();
        let (scope, revision) = db.workspace_snapshot().unwrap();
        validate_index_snapshot(&db.lock().unwrap(), &scope, revision).unwrap();
        let file = temp.path().join("file.md");
        std::fs::write(&file, "text").unwrap();
        db.add_workspace_files(&first, &[file.to_str().unwrap().into()])
            .unwrap();
        assert!(validate_index_snapshot(&db.lock().unwrap(), &scope, revision).is_err());
        let (scope, revision) = db.workspace_snapshot().unwrap();
        db.create_workspace("Second").unwrap();
        db.select_workspace(&first).unwrap();
        assert!(validate_index_snapshot(&db.lock().unwrap(), &scope, revision).is_err());
        let (scope, revision) = db.workspace_snapshot().unwrap();
        db.remove_workspace_file(&first, file.to_str().unwrap())
            .unwrap();
        assert!(validate_index_snapshot(&db.lock().unwrap(), &scope, revision).is_err());
    }
}
