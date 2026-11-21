//! Bounded sticky snapshots and admission shared by window creation and main exit.
use crate::storage::{now, Database};
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use std::collections::HashSet;
use std::sync::{Mutex, MutexGuard};

pub const MAX_NOTES: usize = 64;
pub const MAX_TEXT: usize = 65536;
pub const MAX_TITLE: usize = 256;
pub const MAX_HTML: usize = 131072;
pub const COLORS: [&str; 7] = ["black", "yellow", "green", "blue", "pink", "purple", "gray"];
pub const CLOSE_MESSAGE: &str =
    "Close sticky windows first, or minimize Notation to keep them visible.";

pub fn valid_id(id: &str) -> Result<(), String> {
    if id.len() == 32
        && id
            .bytes()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
    {
        Ok(())
    } else {
        Err("Invalid sticky note ID.".into())
    }
}
/// Custom commands have no generated ACL. Restrict sticky webviews before
/// dispatch, then bind each allowed operation to the caller's note ID.
pub fn authorize_command(label: &str, command: &str) -> Result<(), String> {
    if label.starts_with("sticky-") && !matches!(command,
        "read_sticky_note" | "update_sticky_note" | "close_sticky_note" |
        "new_sticky_note" | "drag_sticky_note") {
        Err("Sticky windows may only read, update, close or drag their own note and create a new sticky.".into())
    } else {
        Ok(())
    }
}
pub fn authorize_main(label: &str) -> Result<(), String> {
    if label == "main" {
        Ok(())
    } else {
        Err("Only the main window can manage sticky notes.".into())
    }
}
pub fn authorize_note(label: &str, id: &str) -> Result<(), String> {
    valid_id(id)?;
    if label == format!("sticky-{id}") {
        Ok(())
    } else {
        Err("This window cannot access that sticky note.".into())
    }
}

#[derive(Default)]
pub struct Admission {
    closing: bool,
    ids: HashSet<String>,
}
impl Admission {
    /// Reservation remains present through construction and until Destroyed.
    pub fn reserve(&mut self, id: &str) -> Result<bool, String> {
        valid_id(id)?;
        self.check_open()?;
        if self.ids.contains(id) {
            return Ok(false);
        }
        if self.ids.len() >= MAX_NOTES {
            return Err("Too many sticky windows.".into());
        }
        self.ids.insert(id.into());
        Ok(true)
    }
    /// Create and reserve together so failed admission cannot leave an orphan.
    pub fn reserve_new(&mut self, database: &Database) -> Result<Metadata, String> {
        self.check_open()?;
        if self.ids.len() >= MAX_NOTES {
            return Err("Too many sticky windows.".into());
        }
        let note = database.create_sticky()?;
        self.ids.insert(note.id.clone());
        Ok(note)
    }
    /// Called only when native construction failed, before any editor was exposed.
    /// Keep admission locked through rollback, then release even if storage fails.
    pub fn failed_open(&mut self, database: &Database, id: &str, created: bool) -> Result<(), String> {
        let result = if created { database.delete_sticky(id) } else { Ok(()) };
        self.release(id);
        result.map_err(|error| format!("{error} Empty note {id} remains in the saved notes list."))
    }
    pub fn check_open(&self) -> Result<(), String> {
        if self.closing {
            Err("Notation is closing. Try again after closing is cancelled.".into())
        } else {
            Ok(())
        }
    }
    pub fn release(&mut self, id: &str) {
        self.ids.remove(id);
    }
    pub fn check_delete(&self, id: &str) -> Result<(), String> {
        valid_id(id)?;
        self.check_open()?;
        if self.ids.contains(id) {
            Err("Close this sticky window before deleting its note.".into())
        } else {
            Ok(())
        }
    }
    pub fn set_closing(&mut self, closing: bool) -> Result<(), String> {
        if closing && !self.ids.is_empty() {
            return Err(CLOSE_MESSAGE.into());
        }
        self.closing = closing;
        Ok(())
    }
    /// Hold this admission guard across both gates, so rollback cannot admit an open.
    pub fn close_with(
        &mut self,
        closing: bool,
        launch_gate: impl FnOnce() -> Result<(), String>,
    ) -> Result<(), String> {
        let previous = self.closing;
        self.set_closing(closing)?;
        if let Err(error) = launch_gate() {
            self.closing = previous;
            return Err(error);
        }
        Ok(())
    }
}
#[derive(Default)]
pub struct StickyManager(Mutex<Admission>);
impl StickyManager {
    pub fn lock(&self) -> Result<MutexGuard<'_, Admission>, String> {
        self.0
            .lock()
            .map_err(|_| "Sticky window manager unavailable.".into())
    }
    /// Release a reservation only if the admission lock is free right now.
    ///
    /// The UI thread calls this when a sticky window is destroyed. Sticky
    /// commands hold the admission lock across database calls, so waiting for
    /// it there would freeze every window behind a busy database. `false`
    /// means the lock was busy and the caller must release from a thread that
    /// may wait.
    pub fn try_release(&self, id: &str) -> bool {
        match self.0.try_lock() {
            Ok(mut admission) => {
                admission.release(id);
                true
            }
            Err(std::sync::TryLockError::WouldBlock) => false,
            // A poisoned manager admits nothing further; there is no
            // reservation left to keep consistent.
            Err(std::sync::TryLockError::Poisoned(_)) => true,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Metadata {
    pub id: String,
    pub title: String,
    pub updated_at: i64,
}
#[derive(Debug, Serialize)]
pub struct Note {
    pub id: String,
    pub title: String,
    pub text: String,
    pub color: String,
    pub html: Option<String>,
}
fn db_error(error: impl std::fmt::Display) -> String {
    format!("Sticky note database: {error}")
}
impl Database {
    pub fn create_sticky(&self) -> Result<Metadata, String> {
        let mut connection = self.lock()?;
        let tx = connection.transaction().map_err(db_error)?;
        let count: i64 = tx
            .query_row("SELECT count(*) FROM sticky_notes", [], |row| row.get(0))
            .map_err(db_error)?;
        if count >= MAX_NOTES as i64 {
            return Err("Sticky note limit reached (64). Delete a saved note first.".into());
        }
        let id: String = tx
            .query_row("SELECT lower(hex(randomblob(16)))", [], |row| row.get(0))
            .map_err(db_error)?;
        let updated_at = now();
        tx.execute(
            "INSERT INTO sticky_notes(id,title,text,updated_at) VALUES(?1,'Untitled sticky','',?2)",
            params![id, updated_at],
        )
        .map_err(db_error)?;
        tx.commit().map_err(db_error)?;
        Ok(Metadata {
            id,
            title: "Untitled sticky".into(),
            updated_at,
        })
    }
    pub fn list_stickies(&self) -> Result<Vec<Metadata>, String> {
        let connection = self.lock()?;
        let mut statement = connection
            .prepare(
                "SELECT id,title,updated_at FROM sticky_notes ORDER BY updated_at DESC,id LIMIT 64",
            )
            .map_err(db_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok(Metadata {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    updated_at: row.get(2)?,
                })
            })
            .map_err(db_error)?;
        rows.collect::<Result<_, _>>().map_err(db_error)
    }
    pub fn read_sticky(&self, id: &str) -> Result<Note, String> {
        valid_id(id)?;
        self.lock()?
            .query_row(
                "SELECT id,title,text,color,html FROM sticky_notes WHERE id=?1",
                [id],
                |row| {
                    Ok(Note {
                        id: row.get(0)?,
                        title: row.get(1)?,
                        text: row.get(2)?,
                        color: row.get(3)?,
                        html: row.get(4)?,
                    })
                },
            )
            .optional()
            .map_err(db_error)?
            .ok_or_else(|| "Sticky note no longer exists.".into())
    }
    pub fn update_sticky(&self, id: &str, title: &str, text: &str) -> Result<(), String> {
        self.update_sticky_content(id, title, text, None, None)
    }
    /// Validate the complete snapshot before one atomic UPDATE. Legacy callers
    /// retain their color and clear stale formatting when replacing plain text.
    pub fn update_sticky_content(
        &self,
        id: &str,
        title: &str,
        text: &str,
        color: Option<&str>,
        html: Option<&str>,
    ) -> Result<(), String> {
        valid_id(id)?;
        if title.len() > MAX_TITLE || text.len() > MAX_TEXT {
            return Err("Sticky title must be at most 256 UTF-8 bytes and text at most 64 KiB. Nothing was truncated.".into());
        }
        if color.is_some_and(|value| !COLORS.contains(&value)) {
            return Err("Invalid sticky color.".into());
        }
        if html.is_some_and(|value| value.len() > MAX_HTML) {
            return Err("Sticky formatting must be at most 128 KiB. Nothing was truncated.".into());
        }
        if self
            .lock()?
            .execute(
                "UPDATE sticky_notes SET title=?2,text=?3,updated_at=?4,color=COALESCE(?5,color),html=?6 WHERE id=?1",
                params![id, title, text, now(), color, html],
            )
            .map_err(db_error)?
            == 0
        {
            return Err("Sticky note no longer exists.".into());
        }
        Ok(())
    }
    pub fn delete_sticky(&self, id: &str) -> Result<(), String> {
        valid_id(id)?;
        if self
            .lock()?
            .execute("DELETE FROM sticky_notes WHERE id=?1", [id])
            .map_err(db_error)?
            == 0
        {
            return Err("Sticky note no longer exists.".into());
        }
        Ok(())
    }
}
