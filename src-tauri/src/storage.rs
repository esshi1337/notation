//! Authoritative application metadata. Document files remain authoritative for
//! saved content; workspace cache tables can be rebuilt independently.
use crate::automation::{ScriptRequest, ScriptResponse};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

pub const MAX_CONTENT: usize = 4 * 1024 * 1024;
const REVISION_LIMIT: usize = 50;
const RUN_LIMIT: usize = 200;
const SCHEMA_VERSION: i64 = 5;

pub fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
fn database_error(error: impl std::fmt::Display) -> String {
    format!("Local database: {error}")
}

#[derive(Clone)]
pub struct Database {
    connection: Arc<Mutex<Connection>>,
    pub path: PathBuf,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyState {
    pub session: Option<Value>,
    pub settings: Option<Value>,
    pub draft: Option<Value>,
    pub script_draft: Option<Value>,
    #[serde(default)]
    pub scripts: Vec<ScriptInput>,
    #[serde(default)]
    pub recents: Vec<Recent>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StateUpdate {
    #[serde(default, deserialize_with = "present_value")]
    pub session: Option<Value>,
    pub settings: Option<Value>,
    // Option<Value> deliberately preserves explicit JSON null as clearing the draft.
    #[serde(default, deserialize_with = "present_value")]
    pub draft: Option<Value>,
    #[serde(default, deserialize_with = "present_value")]
    pub script_draft: Option<Value>,
}
fn present_value<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Value>, D::Error> {
    Value::deserialize(deserializer).map(Some)
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapState {
    pub session: Option<Value>,
    pub settings: Value,
    pub draft: Option<Value>,
    pub script_draft: Option<Value>,
    pub scripts: Vec<SavedScript>,
    pub workspace: Option<String>,
    pub recents: Vec<Recent>,
    pub migration_applied: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScriptInput {
    pub id: String,
    pub name: String,
    pub code: String,
    pub cwd: Option<String>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedScript {
    pub id: String,
    pub name: String,
    pub code: String,
    pub cwd: Option<String>,
    pub updated_at: i64,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Recent {
    pub path: String,
    pub name: String,
    #[serde(default)]
    pub visited_at: i64,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Revision {
    pub id: i64,
    pub document_key: String,
    pub name: String,
    pub path: Option<String>,
    pub created_at: i64,
    pub reason: String,
    pub preview: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptRun {
    pub id: String,
    pub script_id: Option<String>,
    pub started_at: i64,
    pub finished_at: i64,
    pub ok: bool,
    pub error: Option<String>,
    pub result: Value,
    pub logs: Value,
}

impl Database {
    pub fn open(path: &Path) -> Result<Self, String> {
        let parent = path
            .parent()
            .ok_or("Database path needs a parent directory.")?;
        fs::create_dir_all(parent).map_err(database_error)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
            fs::set_permissions(parent, fs::Permissions::from_mode(0o700))
                .map_err(database_error)?;
            let mut options = fs::OpenOptions::new();
            options.write(true).create_new(true).mode(0o600);
            match options.open(path) {
                Ok(_) => (),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    let metadata = fs::symlink_metadata(path).map_err(database_error)?;
                    if !metadata.is_file() || metadata.is_symlink() {
                        return Err(
                            "Local database must be a regular file, not a symbolic link.".into(),
                        );
                    }
                }
                Err(error) => return Err(database_error(error)),
            }
            fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(database_error)?;
        }
        let mut connection = Connection::open(path).map_err(database_error)?;
        connection
            .busy_timeout(std::time::Duration::from_secs(5))
            .map_err(database_error)?;
        let version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(database_error)?;
        if version > SCHEMA_VERSION {
            return Err(
                "Local database was created by a newer Notation version. Original data was kept."
                    .into(),
            );
        }
        connection
            .execute_batch(
                "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;",
            )
            .map_err(database_error)?;
        if version < 1 {
            let tx = connection.transaction().map_err(database_error)?;
            tx.execute_batch(r#"
CREATE TABLE app_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE settings(id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL);
CREATE TABLE drafts(id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL);
CREATE TABLE script_drafts(id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL);
CREATE TABLE scripts(id TEXT PRIMARY KEY, name TEXT NOT NULL, code TEXT NOT NULL, cwd TEXT, updated_at INTEGER NOT NULL);
CREATE TABLE script_runs(id TEXT PRIMARY KEY, script_id TEXT, started_at INTEGER NOT NULL, finished_at INTEGER NOT NULL, ok INTEGER NOT NULL, error TEXT, result TEXT NOT NULL, logs TEXT NOT NULL);
CREATE TABLE revisions(id INTEGER PRIMARY KEY AUTOINCREMENT, document_key TEXT NOT NULL, name TEXT NOT NULL, path TEXT, created_at INTEGER NOT NULL, reason TEXT NOT NULL, content TEXT NOT NULL);
CREATE INDEX revisions_document ON revisions(document_key,id DESC);
CREATE TABLE recents(path TEXT PRIMARY KEY, name TEXT NOT NULL, visited_at INTEGER NOT NULL);
CREATE TABLE workspaces(id INTEGER PRIMARY KEY CHECK(id=1), path TEXT NOT NULL);
PRAGMA user_version=1;
"#).map_err(database_error)?;
            tx.commit().map_err(database_error)?;
        }
        if version < 2 {
            let tx = connection.transaction().map_err(database_error)?;
            tx.execute_batch(r#"
CREATE TABLE cache_files(path TEXT PRIMARY KEY, name TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL);
CREATE VIRTUAL TABLE cache_fts USING fts5(path UNINDEXED,title,body,tokenize='unicode61');
CREATE TABLE cache_links(source_path TEXT NOT NULL,line INTEGER NOT NULL,text TEXT NOT NULL,target_path TEXT NOT NULL);
CREATE INDEX cache_links_target ON cache_links(target_path);
CREATE TABLE cache_tags(path TEXT NOT NULL,line INTEGER NOT NULL,tag TEXT NOT NULL);
CREATE TABLE cache_tasks(path TEXT NOT NULL,line INTEGER NOT NULL,text TEXT NOT NULL,checked INTEGER NOT NULL);
PRAGMA user_version=2;
"#).map_err(database_error)?;
            tx.commit().map_err(database_error)?;
        }
        if version < 3 {
            let tx = connection.transaction().map_err(database_error)?;
            tx.execute_batch("CREATE TABLE sessions(id INTEGER PRIMARY KEY CHECK(id=1),json TEXT NOT NULL); PRAGMA user_version=3;").map_err(database_error)?;
            tx.commit().map_err(database_error)?;
        }
        if version < 4 {
            let tx = connection.transaction().map_err(database_error)?;
            tx.execute_batch("CREATE TABLE cache_frontmatter(path TEXT PRIMARY KEY,json TEXT NOT NULL); CREATE TABLE cache_properties(path TEXT NOT NULL,key TEXT NOT NULL,kind TEXT NOT NULL,json_value TEXT NOT NULL); CREATE INDEX cache_properties_lookup ON cache_properties(key,kind,json_value); CREATE TABLE cache_headings(path TEXT NOT NULL,text TEXT NOT NULL,line INTEGER NOT NULL,level INTEGER NOT NULL); PRAGMA user_version=4;").map_err(database_error)?;
            tx.commit().map_err(database_error)?;
        }
        if version < 5 {
            let tx = connection.transaction().map_err(database_error)?;
            tx.execute_batch("CREATE TABLE cache_blocks(path TEXT NOT NULL,id TEXT NOT NULL,line INTEGER NOT NULL); CREATE TABLE cache_graph_links(source_path TEXT NOT NULL,line INTEGER NOT NULL,raw_target TEXT NOT NULL,kind TEXT NOT NULL,target_path TEXT,status TEXT NOT NULL,candidates_json TEXT NOT NULL,heading TEXT,alias TEXT); CREATE INDEX cache_graph_source ON cache_graph_links(source_path); INSERT INTO cache_graph_links(source_path,line,raw_target,kind,target_path,status,candidates_json) SELECT source_path,line,target_path,'markdown',target_path,'resolved','[]' FROM cache_links; PRAGMA user_version=5;").map_err(database_error)?;
            tx.commit().map_err(database_error)?;
        }
        Ok(Self {
            connection: Arc::new(Mutex::new(connection)),
            path: path.to_path_buf(),
        })
    }

    pub(crate) fn lock(&self) -> Result<MutexGuard<'_, Connection>, String> {
        self.connection.lock().map_err(|_| {
            "Local database is unavailable after an internal error. Original data was kept.".into()
        })
    }

    pub fn bootstrap(&self, legacy: Option<LegacyState>) -> Result<BootstrapState, String> {
        let mut connection = self.lock()?;
        let tx = connection.transaction().map_err(database_error)?;
        let migrated: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM app_meta WHERE key='legacy_migrated')",
                [],
                |row| row.get(0),
            )
            .map_err(database_error)?;
        let mut migration_applied = false;
        if !migrated {
            let has_state: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM settings UNION ALL SELECT 1 FROM sessions UNION ALL SELECT 1 FROM drafts UNION ALL SELECT 1 FROM script_drafts UNION ALL SELECT 1 FROM scripts UNION ALL SELECT 1 FROM revisions UNION ALL SELECT 1 FROM script_runs UNION ALL SELECT 1 FROM recents UNION ALL SELECT 1 FROM workspaces)",[],|row|row.get(0)).map_err(database_error)?;
            if !has_state {
                if let Some(legacy) = legacy {
                    persist(
                        &tx,
                        &StateUpdate {
                            session: legacy.session,
                            settings: legacy.settings,
                            draft: legacy.draft,
                            script_draft: legacy.script_draft,
                        },
                    )?;
                    for script in legacy.scripts {
                        save_script(&tx, &script)?;
                    }
                    for recent in legacy.recents.into_iter().take(20) {
                        touch_recent(&tx, &recent.path, &recent.name)?;
                    }
                    migration_applied = true;
                }
            }
            tx.execute(
                "INSERT INTO app_meta(key,value) VALUES('legacy_migrated','1')",
                [],
            )
            .map_err(database_error)?;
        }
        tx.commit().map_err(database_error)?;
        drop(connection);
        Ok(BootstrapState {
            session: self.json_value("sessions")?,
            settings: self.json_value("settings")?.unwrap_or_else(|| json!({})),
            draft: self.json_value("drafts")?,
            script_draft: self.json_value("script_drafts")?,
            scripts: self.list_scripts()?,
            workspace: self.workspace()?,
            recents: self.recents()?,
            migration_applied,
        })
    }

    pub(crate) fn json_value(&self, table: &str) -> Result<Option<Value>, String> {
        let connection = self.lock()?;
        let text: Option<String> = connection
            .query_row(&format!("SELECT json FROM {table} WHERE id=1"), [], |row| {
                row.get(0)
            })
            .optional()
            .map_err(database_error)?;
        text.map(|text| serde_json::from_str(&text).map_err(database_error))
            .transpose()
    }
    pub fn persist(&self, state: StateUpdate) -> Result<(), String> {
        let mut connection = self.lock()?;
        let tx = connection.transaction().map_err(database_error)?;
        persist(&tx, &state)?;
        tx.commit().map_err(database_error)
    }
    pub fn save_script(&self, script: ScriptInput) -> Result<SavedScript, String> {
        let connection = self.lock()?;
        save_script(&connection, &script)?;
        connection
            .query_row(
                "SELECT id,name,code,cwd,updated_at FROM scripts WHERE id=?1",
                [&script.id],
                script_row,
            )
            .map_err(database_error)
    }
    pub fn delete_script(&self, id: &str) -> Result<bool, String> {
        Ok(self
            .lock()?
            .execute("DELETE FROM scripts WHERE id=?1", [id])
            .map_err(database_error)?
            > 0)
    }
    pub fn list_scripts(&self) -> Result<Vec<SavedScript>, String> {
        let connection = self.lock()?;
        let mut statement = connection
            .prepare("SELECT id,name,code,cwd,updated_at FROM scripts ORDER BY updated_at DESC,id")
            .map_err(database_error)?;
        let rows = statement
            .query_map([], script_row)
            .map_err(database_error)?;
        rows.collect::<Result<_, _>>().map_err(database_error)
    }
    pub fn record_run(
        &self,
        request: &ScriptRequest,
        response: &ScriptResponse,
        started_at: i64,
    ) -> Result<(), String> {
        let mut connection = self.lock()?;
        let tx = connection.transaction().map_err(database_error)?;
        tx.execute("INSERT OR REPLACE INTO script_runs(id,script_id,started_at,finished_at,ok,error,result,logs) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",params![response.id,request.script_id,started_at,now(),response.ok,response.error,response.result.to_string(),serde_json::to_string(&response.logs).map_err(database_error)?]).map_err(database_error)?;
        tx.execute("DELETE FROM script_runs WHERE id NOT IN(SELECT id FROM script_runs ORDER BY finished_at DESC,rowid DESC LIMIT ?1)",[RUN_LIMIT as i64]).map_err(database_error)?;
        tx.commit().map_err(database_error)
    }
    pub fn list_script_runs(&self, script_id: Option<&str>) -> Result<Vec<ScriptRun>, String> {
        let connection = self.lock()?;
        let mut statement = connection.prepare("SELECT id,script_id,started_at,finished_at,ok,error,result,logs FROM script_runs WHERE (?1 IS NULL OR script_id=?1) ORDER BY finished_at DESC,rowid DESC LIMIT 200").map_err(database_error)?;
        let rows = statement
            .query_map([script_id], |row| {
                let result: String = row.get(6)?;
                let logs: String = row.get(7)?;
                Ok(ScriptRun {
                    id: row.get(0)?,
                    script_id: row.get(1)?,
                    started_at: row.get(2)?,
                    finished_at: row.get(3)?,
                    ok: row.get(4)?,
                    error: row.get(5)?,
                    result: serde_json::from_str(&result).unwrap_or(Value::Null),
                    logs: serde_json::from_str(&logs).unwrap_or_else(|_| json!([])),
                })
            })
            .map_err(database_error)?;
        rows.collect::<Result<_, _>>().map_err(database_error)
    }
    pub fn record_document(&self, path: &str, content: &str, save: bool) -> Result<(), String> {
        self.record_document_with_baseline(path, content, save, None)
    }
    fn record_document_with_baseline(
        &self,
        path: &str,
        content: &str,
        save: bool,
        baseline: Option<&str>,
    ) -> Result<(), String> {
        let name = Path::new(path)
            .file_name()
            .unwrap_or_default()
            .to_string_lossy();
        let mut connection = self.lock()?;
        let tx = connection.transaction().map_err(database_error)?;
        touch_recent(&tx, path, &name)?;
        if save {
            if let Some(previous) = baseline {
                snapshot(&tx, path, &name, Some(path), "before-save", previous)?;
            }
            snapshot(&tx, path, &name, Some(path), "save", content)?;
        }
        tx.commit().map_err(database_error)
    }
    pub fn recents(&self) -> Result<Vec<Recent>, String> {
        let connection = self.lock()?;
        let mut statement=connection.prepare("SELECT path,name,visited_at FROM recents ORDER BY visited_at DESC,rowid DESC LIMIT 20").map_err(database_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok(Recent {
                    path: row.get(0)?,
                    name: row.get(1)?,
                    visited_at: row.get(2)?,
                })
            })
            .map_err(database_error)?;
        rows.collect::<Result<_, _>>().map_err(database_error)
    }
    pub fn list_revisions(&self, key: &str) -> Result<Vec<Revision>, String> {
        let connection = self.lock()?;
        let mut statement=connection.prepare("SELECT id,document_key,name,path,created_at,reason,substr(content,1,160) FROM revisions WHERE document_key=?1 ORDER BY id DESC LIMIT 50").map_err(database_error)?;
        let rows = statement
            .query_map([key], |row| revision_row(row, false))
            .map_err(database_error)?;
        rows.collect::<Result<_, _>>().map_err(database_error)
    }
    pub fn get_revision(&self, id: i64) -> Result<Revision, String> {
        self.lock()?.query_row("SELECT id,document_key,name,path,created_at,reason,content FROM revisions WHERE id=?1",[id],|row|revision_row(row,true)).map_err(database_error)
    }
    pub fn workspace(&self) -> Result<Option<String>, String> {
        self.lock()?
            .query_row("SELECT path FROM workspaces WHERE id=1", [], |row| {
                row.get(0)
            })
            .optional()
            .map_err(database_error)
    }
    pub fn set_workspace(&self, path: &str) -> Result<Value, String> {
        let path = Path::new(path)
            .canonicalize()
            .map_err(|error| format!("Could not open workspace: {error}"))?;
        if !path.is_dir() {
            return Err("Choose a directory for the workspace.".into());
        }
        let path = path.to_str().ok_or("Workspace path must be valid UTF-8.")?;
        let mut connection = self.lock()?;
        let tx = connection.transaction().map_err(database_error)?;
        let previous: Option<String> = tx
            .query_row("SELECT path FROM workspaces WHERE id=1", [], |row| {
                row.get(0)
            })
            .optional()
            .map_err(database_error)?;
        if previous.as_deref() != Some(path) {
            clear_cache(&tx)?;
        }
        tx.execute("INSERT INTO workspaces(id,path) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET path=excluded.path",[path]).map_err(database_error)?;
        tx.commit().map_err(database_error)?;
        Ok(json!({"path":path}))
    }
}

pub(crate) fn clear_cache(connection: &Connection) -> Result<(), String> {
    connection.execute_batch("DELETE FROM cache_blocks; DELETE FROM cache_graph_links; DELETE FROM cache_frontmatter; DELETE FROM cache_properties; DELETE FROM cache_headings; DELETE FROM cache_fts; DELETE FROM cache_links; DELETE FROM cache_tags; DELETE FROM cache_tasks; DELETE FROM cache_files;").map_err(database_error)
}
fn script_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SavedScript> {
    Ok(SavedScript {
        id: row.get(0)?,
        name: row.get(1)?,
        code: row.get(2)?,
        cwd: row.get(3)?,
        updated_at: row.get(4)?,
    })
}
fn revision_row(row: &rusqlite::Row<'_>, full: bool) -> rusqlite::Result<Revision> {
    let content: String = row.get(6)?;
    Ok(Revision {
        id: row.get(0)?,
        document_key: row.get(1)?,
        name: row.get(2)?,
        path: row.get(3)?,
        created_at: row.get(4)?,
        reason: row.get(5)?,
        preview: content.chars().take(160).collect(),
        content: full.then_some(content),
    })
}
fn save_script(connection: &Connection, script: &ScriptInput) -> Result<(), String> {
    if script.id.is_empty()
        || script.id.len() > 128
        || script.name.trim().is_empty()
        || script.name.len() > 256
        || script.code.len() > 128 * 1024
    {
        return Err(
            "Script needs an ID, a name up to 256 characters, and code up to 128 KiB.".into(),
        );
    }
    connection.execute("INSERT INTO scripts(id,name,code,cwd,updated_at) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(id) DO UPDATE SET name=excluded.name,code=excluded.code,cwd=excluded.cwd,updated_at=excluded.updated_at",params![script.id,script.name,script.code,script.cwd,now()]).map_err(database_error)?;
    Ok(())
}
fn persist(connection: &Connection, state: &StateUpdate) -> Result<(), String> {
    if let Some(session) = &state.session {
        persist_session(connection, session)?;
    }
    if let Some(settings) = &state.settings {
        if !settings.is_object() || settings.to_string().len() > 64 * 1024 {
            return Err("Settings must be a small JSON object.".into());
        }
        let previous: Option<String> = connection
            .query_row("SELECT json FROM settings WHERE id=1", [], |row| row.get(0))
            .optional()
            .map_err(database_error)?;
        let mut merged = previous
            .map(|value| serde_json::from_str::<Value>(&value).map_err(database_error))
            .transpose()?
            .unwrap_or_else(|| json!({}));
        let object = merged
            .as_object_mut()
            .ok_or("Stored settings are invalid. Original data was kept.")?;
        object.extend(settings.as_object().unwrap().clone());
        connection.execute("INSERT INTO settings(id,json) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET json=excluded.json",[merged.to_string()]).map_err(database_error)?;
    }
    if let Some(draft) = &state.draft {
        if draft.is_null() {
            connection
                .execute("DELETE FROM drafts WHERE id=1", [])
                .map_err(database_error)?;
        } else {
            let content = draft
                .get("content")
                .and_then(Value::as_str)
                .ok_or("Draft content must be text.")?;
            let name = draft
                .get("name")
                .and_then(Value::as_str)
                .ok_or("Draft needs a name.")?;
            if content.len() > MAX_CONTENT || draft.to_string().len() > MAX_CONTENT * 3 {
                return Err("Draft exceeds the 4 MiB text limit.".into());
            }
            let path = draft.get("path").and_then(Value::as_str);
            let key = path
                .or_else(|| draft.get("id").and_then(Value::as_str))
                .unwrap_or("untitled");
            // Save old draft revisions at most once per 30 seconds; snapshot the
            // outgoing draft on document switches. The current draft itself is
            // always committed, even when revision creation is throttled.
            let previous: Option<String> = connection
                .query_row("SELECT json FROM drafts WHERE id=1", [], |row| row.get(0))
                .optional()
                .map_err(database_error)?;
            if let Some(previous) =
                previous.and_then(|value| serde_json::from_str::<Value>(&value).ok())
            {
                let old_content = previous
                    .get("content")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let old_path = previous.get("path").and_then(Value::as_str);
                let old_key = old_path
                    .or_else(|| previous.get("id").and_then(Value::as_str))
                    .unwrap_or("untitled");
                let last:Option<i64>=connection.query_row("SELECT created_at FROM revisions WHERE document_key=?1 ORDER BY id DESC LIMIT 1",[old_key],|row|row.get(0)).optional().map_err(database_error)?;
                if old_content != content
                    && (old_key != key || last.is_none_or(|last| now() - last >= 30_000))
                {
                    snapshot(
                        connection,
                        old_key,
                        previous
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or("untitled.md"),
                        old_path,
                        "draft",
                        old_content,
                    )?;
                }
            } else {
                snapshot(connection, key, name, path, "draft", content)?;
            }
            connection.execute("INSERT INTO drafts(id,json) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET json=excluded.json",[draft.to_string()]).map_err(database_error)?;
        }
    }
    if let Some(draft) = &state.script_draft {
        if draft.is_null() {
            connection
                .execute("DELETE FROM script_drafts WHERE id=1", [])
                .map_err(database_error)?;
        } else {
            if !draft.is_object()
                || draft
                    .get("code")
                    .and_then(Value::as_str)
                    .is_none_or(|code| code.len() > 128 * 1024)
                || draft.to_string().len() > 256 * 1024
            {
                return Err("Script draft must contain code up to 128 KiB.".into());
            }
            connection.execute("INSERT INTO script_drafts(id,json) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET json=excluded.json",[draft.to_string()]).map_err(database_error)?;
        }
    }
    Ok(())
}
fn persist_session(connection: &Connection, session: &Value) -> Result<(), String> {
    if session.is_null() {
        connection
            .execute("DELETE FROM sessions WHERE id=1", [])
            .map_err(database_error)?;
        return Ok(());
    }
    let tabs = session
        .get("tabs")
        .and_then(Value::as_array)
        .ok_or("Session tabs must be an array.")?;
    let active = session
        .get("activeTabId")
        .and_then(Value::as_str)
        .ok_or("Session needs an activeTabId.")?;
    if session.to_string().len() > 32 * 1024 * 1024 {
        return Err(
            "Session exceeds the 32 MiB recovery limit. No tabs were dropped or replaced.".into(),
        );
    }
    let mut ids = std::collections::HashSet::new();
    for tab in tabs {
        let id = tab
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty() && id.len() <= 128)
            .ok_or("Every session tab needs an ID of 1–128 characters.")?;
        if !ids.insert(id) {
            return Err("Session contains duplicate tab IDs.".into());
        }
        if tab.get("name").and_then(Value::as_str).is_none() {
            return Err("Every session tab needs a name.".into());
        }
        for field in ["content", "savedContent"] {
            if tab
                .get(field)
                .and_then(Value::as_str)
                .is_none_or(|content| content.len() > MAX_CONTENT)
            {
                return Err("Session tab text exceeds the 4 MiB limit or is invalid. No tabs were dropped or replaced.".into());
            }
        }
    }
    if !tabs.is_empty() && !ids.contains(active) {
        return Err("Session active tab is missing from its tabs.".into());
    }
    let previous: Option<String> = connection
        .query_row("SELECT json FROM sessions WHERE id=1", [], |row| row.get(0))
        .optional()
        .map_err(database_error)?;
    let previous: Value = previous
        .map(|value| serde_json::from_str(&value).map_err(database_error))
        .transpose()?
        .unwrap_or_else(|| json!({"tabs":[]}));
    let old_tabs = previous["tabs"]
        .as_array()
        .ok_or("Stored session is invalid. Original data was kept.")?;
    for old in old_tabs {
        let replacement = tabs.iter().find(|tab| tab["id"] == old["id"]);
        if replacement.is_none_or(|tab| tab["content"] != old["content"]) {
            let path = old.get("path").and_then(Value::as_str);
            let key = path.or_else(|| old["id"].as_str()).unwrap_or("untitled");
            let last:Option<i64>=connection.query_row("SELECT created_at FROM revisions WHERE document_key=?1 ORDER BY id DESC LIMIT 1",[key],|row|row.get(0)).optional().map_err(database_error)?;
            if replacement.is_none() || last.is_none_or(|last| now() - last >= 30_000) {
                snapshot(
                    connection,
                    key,
                    old["name"].as_str().unwrap_or("untitled.md"),
                    path,
                    "draft",
                    old["content"].as_str().unwrap_or(""),
                )?;
            }
        }
    }
    for tab in tabs {
        if !old_tabs.iter().any(|old| old["id"] == tab["id"]) {
            let path = tab.get("path").and_then(Value::as_str);
            snapshot(
                connection,
                path.unwrap_or(tab["id"].as_str().unwrap()),
                tab["name"].as_str().unwrap(),
                path,
                "draft",
                tab["content"].as_str().unwrap(),
            )?;
        }
    }
    connection.execute("INSERT INTO sessions(id,json) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET json=excluded.json",[session.to_string()]).map_err(database_error)?;
    Ok(())
}
fn snapshot(
    connection: &Connection,
    key: &str,
    name: &str,
    path: Option<&str>,
    reason: &str,
    content: &str,
) -> Result<(), String> {
    if content.len() > MAX_CONTENT {
        return Err("Revision exceeds the 4 MiB limit.".into());
    }
    let last: Option<String> = connection
        .query_row(
            "SELECT content FROM revisions WHERE document_key=?1 ORDER BY id DESC LIMIT 1",
            [key],
            |row| row.get(0),
        )
        .optional()
        .map_err(database_error)?;
    if last.as_deref() == Some(content) {
        return Ok(());
    }
    connection.execute("INSERT INTO revisions(document_key,name,path,created_at,reason,content) VALUES(?1,?2,?3,?4,?5,?6)",params![key,name,path,now(),reason,content]).map_err(database_error)?;
    connection.execute("DELETE FROM revisions WHERE document_key=?1 AND id NOT IN(SELECT id FROM revisions WHERE document_key=?1 ORDER BY id DESC LIMIT ?2)",params![key,REVISION_LIMIT as i64]).map_err(database_error)?;
    Ok(())
}
fn touch_recent(connection: &Connection, path: &str, name: &str) -> Result<(), String> {
    connection.execute("INSERT INTO recents(path,name,visited_at) VALUES(?1,?2,?3) ON CONFLICT(path) DO UPDATE SET name=excluded.name,visited_at=excluded.visited_at",params![path,name,now()]).map_err(database_error)?;
    connection.execute("DELETE FROM recents WHERE path NOT IN(SELECT path FROM recents ORDER BY visited_at DESC,rowid DESC LIMIT 20)",[]).map_err(database_error)?;
    Ok(())
}

/// Files remain usable when optional application metadata cannot be opened.
pub fn read_with_metadata(
    path: &str,
    database: &Result<Database, String>,
) -> Result<crate::documents::Document, String> {
    let mut document = crate::documents::read_document(path)?;
    if let Err(error) = database
        .as_ref()
        .map_err(Clone::clone)
        .and_then(|database| database.record_document(&document.path, &document.content, false))
    {
        document.warning = Some(format!(
            "File opened, but local history could not be updated: {error}"
        ));
    }
    Ok(document)
}
pub fn write_with_metadata(
    path: &str,
    content: &str,
    database: &Result<Database, String>,
) -> Result<crate::documents::Document, String> {
    use std::io::Read;
    // Capture the disk baseline before the atomic replacement. It is added to
    // history only after the file save succeeds, including external edits that
    // were made since the last editor session.
    let previous = if database.is_ok() {
        match fs::File::open(path) {
            Ok(file) => {
                let mut bytes = Vec::new();
                match file.take((MAX_CONTENT+1) as u64).read_to_end(&mut bytes){
                    Ok(_) if bytes.len()<=MAX_CONTENT=>String::from_utf8(bytes).map(Some).map_err(|_|"Previous disk content was not valid UTF-8 and could not be added to history.".to_string()),
                    Ok(_)=>Err("Previous disk content exceeded the 4 MiB history limit.".into()),
                    Err(error)=>Err(format!("Previous disk content could not be read for history: {error}")),
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(format!(
                "Previous disk content could not be read for history: {error}"
            )),
        }
    } else {
        Ok(None)
    };
    let mut document = crate::documents::write_document(path, content)?;
    if let Err(error) = database
        .as_ref()
        .map_err(Clone::clone)
        .and_then(|database| {
            database.record_document_with_baseline(
                &document.path,
                content,
                true,
                previous
                    .as_ref()
                    .ok()
                    .and_then(|content| content.as_deref()),
            )
        })
    {
        document.warning = Some(format!(
            "File saved, but local history could not be updated: {error}"
        ));
    }
    if let Err(error) = previous {
        let warning = format!("File saved. {error}");
        document.warning = Some(match document.warning {
            Some(existing) => format!("{existing} {warning}"),
            None => warning,
        });
    }
    if let Ok(database) = database {
        refresh_after_write(database, &mut document);
    }
    Ok(document)
}
pub fn record_run_optional(
    database: &Result<Database, String>,
    request: &ScriptRequest,
    response: &mut ScriptResponse,
    started_at: i64,
) {
    if let Err(error) = database
        .as_ref()
        .map_err(Clone::clone)
        .and_then(|database| database.record_run(request, response, started_at))
    {
        response.logs.push(crate::automation::ScriptLog {
            level: "warn".into(),
            message: format!("Script finished, but run history could not be saved: {error}"),
        });
    }
}

pub(crate) fn refresh_after_write(database: &Database, document: &mut crate::documents::Document) {
    let refresh = (|| -> Result<(), String> {
        let Some(root) = database.workspace()? else {
            return Ok(());
        };
        let path = Path::new(&document.path);
        if !path.starts_with(root)
            || !matches!(
                path.extension()
                    .and_then(|value| value.to_str())
                    .map(str::to_ascii_lowercase)
                    .as_deref(),
                Some("md" | "markdown" | "mmd")
            )
        {
            return Ok(());
        }
        let report = database.index_workspace()?;
        if !report.errors.is_empty() {
            return Err(report.errors.join("\n"));
        }
        Ok(())
    })();
    if let Err(error) = refresh {
        let warning = format!("File saved, but the workspace index reported: {error}");
        document.warning = Some(match document.warning.take() {
            Some(existing) => format!("{existing}\n{warning}"),
            None => warning,
        });
    }
}
