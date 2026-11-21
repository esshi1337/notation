use notation_lib::sticky::{
    authorize_main, authorize_note, valid_id, Admission, StickyManager, MAX_NOTES, MAX_TEXT,
    MAX_TITLE, MAX_HTML, COLORS,
};
use notation_lib::storage::{Database, StateUpdate};
use serde_json::json;
use std::sync::{Arc, Barrier};

const ID: &str = "0123456789abcdef0123456789abcdef";

#[test]
fn migration_six_to_nine_preserves_ordinary_state_and_independent_notes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.sqlite3");
    let db = Database::open(&path).unwrap();
    db.persist(StateUpdate {
        settings: Some(json!({"fontSize":19})),
        draft: Some(json!({"id":"draft","name":"draft.md","content":"ordinary"})),
        ..Default::default()
    })
    .unwrap();
    drop(db);
    // Simulate the exact previous schema, retaining its ordinary tables/data.
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection
        .execute_batch("DROP TABLE sticky_notes; PRAGMA user_version=6;")
        .unwrap();
    drop(connection);
    let db = Database::open(&path).unwrap();
    assert!(db.list_stickies().unwrap().is_empty());
    let a = db.create_sticky().unwrap();
    let b = db.create_sticky().unwrap();
    assert_ne!(a.id, b.id);
    db.update_sticky(&a.id, "<b>plain title</b>", "<script>plain text</script>")
        .unwrap();
    assert_eq!(db.read_sticky(&b.id).unwrap().text, "");
    assert_eq!(db.read_sticky(&b.id).unwrap().color, "black");
    assert!(db.read_sticky(&b.id).unwrap().html.is_none());
    drop(db);
    let db = Database::open(&path).unwrap();
    assert_eq!(
        db.read_sticky(&a.id).unwrap().text,
        "<script>plain text</script>"
    );
    let metadata = serde_json::to_value(db.list_stickies().unwrap()).unwrap();
    assert!(metadata[0].get("text").is_none());
    assert!(metadata[0].get("html").is_none());
    let state = db.bootstrap(None).unwrap();
    assert_eq!(state.settings["fontSize"], 19);
    assert_eq!(state.draft.unwrap()["content"], "ordinary");
    db.delete_sticky(&a.id).unwrap();
    assert!(db.read_sticky(&a.id).is_err());
    assert!(db.update_sticky(&a.id, "", "").is_err());
    assert!(db.delete_sticky(&a.id).is_err());
    assert_eq!(db.list_stickies().unwrap().len(), 1);
}

#[test]
fn formatted_snapshots_validate_all_fields_before_atomic_update_and_survive_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.sqlite3");
    let db = Database::open(&path).unwrap();
    let id = db.create_sticky().unwrap().id;
    let boundary = "x".repeat(MAX_HTML);
    for color in COLORS {
        db.update_sticky_content(&id, "title", "fallback", Some(color), Some(&boundary)).unwrap();
        let note = db.read_sticky(&id).unwrap();
        assert_eq!(note.color, color);
        assert_eq!(note.html.as_deref(), Some(boundary.as_str()));
    }
    let before = serde_json::to_value(db.read_sticky(&id).unwrap()).unwrap();
    let metadata = serde_json::to_value(db.list_stickies().unwrap()).unwrap();
    for (title, text, color, html) in [
        ("changed".into(), "changed".into(), "red", "<b>changed</b>".into()),
        ("changed".into(), "changed".into(), "Yellow", "<b>changed</b>".into()),
        ("changed".into(), "changed".into(), "blue", "é".repeat(MAX_HTML / 2 + 1)),
        ("t".repeat(MAX_TITLE + 1), "changed".into(), "blue", "ok".into()),
        ("changed".into(), "x".repeat(MAX_TEXT + 1), "blue", "ok".into()),
    ] {
        assert!(db.update_sticky_content(&id, &title, &text, Some(color), Some(&html)).is_err());
        assert_eq!(serde_json::to_value(db.read_sticky(&id).unwrap()).unwrap(), before);
        assert_eq!(serde_json::to_value(db.list_stickies().unwrap()).unwrap(), metadata);
    }
    // Storage is bounded data, not trusted HTML: the UI must sanitize every read.
    let untrusted = "<img src=https://invalid.example onerror=alert(1)>";
    db.update_sticky_content(&id, "kept", "literal fallback", Some("purple"), Some(untrusted)).unwrap();
    drop(db);
    let db = Database::open(&path).unwrap();
    let note = db.read_sticky(&id).unwrap();
    assert_eq!(note.html.as_deref(), Some(untrusted));
    assert_eq!(note.color, "purple");
    assert_eq!(note.text, "literal fallback");
    // Old plain-text callers preserve color but never retain stale formatting.
    db.update_sticky(&id, "old API", "replacement").unwrap();
    let note = db.read_sticky(&id).unwrap();
    assert_eq!(note.color, "purple");
    assert!(note.html.is_none());
}

#[test]
fn rejects_byte_and_count_limits_without_truncation_or_partial_updates() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("state.sqlite3")).unwrap();
    let a = db.create_sticky().unwrap();
    db.update_sticky(&a.id, &"t".repeat(MAX_TITLE), &"x".repeat(MAX_TEXT))
        .unwrap();
    for (title, text) in [
        ("ü".repeat(MAX_TITLE), "small".into()),
        ("small".into(), "é".repeat(MAX_TEXT)),
    ] {
        assert!(db.update_sticky(&a.id, &title, &text).is_err());
        let note = db.read_sticky(&a.id).unwrap();
        assert_eq!(note.title.len(), MAX_TITLE);
        assert_eq!(note.text.len(), MAX_TEXT);
    }
    for _ in 1..MAX_NOTES {
        db.create_sticky().unwrap();
    }
    assert!(db.create_sticky().is_err());
    assert_eq!(db.list_stickies().unwrap().len(), MAX_NOTES);
    db.delete_sticky(&a.id).unwrap();
    db.create_sticky().unwrap();
    assert!(db.read_sticky("../../bad").is_err());
}

#[test]
fn ids_and_window_authorization_are_strict() {
    valid_id(ID).unwrap();
    authorize_main("main").unwrap();
    authorize_note(&format!("sticky-{ID}"), ID).unwrap();
    for bad in [
        "",
        "../foo",
        "0123456789ABCDEF0123456789ABCDEF",
        "0123456789abcdef0123456789abcdef?x=1",
    ] {
        assert!(valid_id(bad).is_err());
    }
    for label in ["main", "sticky-", "sticky-other", "other"] {
        assert!(authorize_note(label, ID).is_err());
    }
    assert!(authorize_main(&format!("sticky-{ID}")).is_err());
}

#[test]
fn reservations_block_exit_delete_and_duplicate_builds_and_cleanup_is_bounded() {
    let mut manager = Admission::default();
    assert!(manager.reserve(ID).unwrap());
    assert!(!manager.reserve(ID).unwrap());
    assert!(manager.check_delete(ID).is_err());
    assert!(manager
        .set_closing(true)
        .unwrap_err()
        .contains("Close sticky windows first"));
    manager.release(ID); // build failure or Destroyed
    manager.check_delete(ID).unwrap();
    manager.set_closing(true).unwrap();
    assert!(manager.reserve(ID).is_err());
    manager.set_closing(false).unwrap();
    for n in 0..1000 {
        let id = format!("{n:032x}");
        assert!(manager.reserve(&id).unwrap());
        manager.release(&id);
    }
    manager.set_closing(true).unwrap();
}

#[test]
fn close_gate_rolls_back_launch_failure_and_reopens_both() {
    let mut manager = Admission::default();
    assert!(manager
        .close_with(true, || Err("launch failed".into()))
        .is_err());
    manager.reserve(ID).unwrap();
    let mut called = false;
    assert!(manager
        .close_with(true, || {
            called = true;
            Ok(())
        })
        .is_err());
    assert!(!called);
    manager.release(ID);
    manager.close_with(true, || Ok(())).unwrap();
    assert!(manager.reserve(ID).is_err());
    manager.close_with(false, || Ok(())).unwrap();
    assert!(manager.reserve(ID).unwrap());
}

#[test]
fn simultaneous_reservation_and_main_close_cannot_both_win() {
    for _ in 0..100 {
        let manager = Arc::new(StickyManager::default());
        let barrier = Arc::new(Barrier::new(2));
        let other = manager.clone();
        let start = barrier.clone();
        let open = std::thread::spawn(move || {
            start.wait();
            other.lock().unwrap().reserve(ID).is_ok()
        });
        barrier.wait();
        let closed = manager.lock().unwrap().close_with(true, || Ok(())).is_ok();
        assert_ne!(closed, open.join().unwrap());
    }
}

#[test]
fn delete_holds_admission_until_database_deletion_is_complete() {
    let manager = Arc::new(StickyManager::default());
    let mut deleting = manager.lock().unwrap();
    deleting.check_delete(ID).unwrap();
    let barrier = Arc::new(Barrier::new(2));
    let other = manager.clone();
    let start = barrier.clone();
    let pending = std::thread::spawn(move || {
        start.wait();
        other.lock().unwrap().reserve(ID).is_err()
    });
    barrier.wait();
    // A concurrent opener cannot reserve until deletion's guard is dropped.
    assert!(!pending.is_finished());
    deleting.set_closing(true).unwrap();
    drop(deleting);
    // The opener now sees the updated gate rather than stale admission.
    assert!(pending.join().unwrap());
}

#[test]
fn storage_errors_are_reported_not_replaced() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.sqlite3");
    let db = Database::open(&path).unwrap();
    rusqlite::Connection::open(&path)
        .unwrap()
        .execute_batch("DROP TABLE sticky_notes;")
        .unwrap();
    assert!(db.list_stickies().unwrap_err().contains("database"));
    assert!(db.create_sticky().is_err());
    assert!(db.read_sticky(ID).is_err());
}

#[test]
fn schema_eight_preserves_every_color_and_snapshot_while_new_notes_default_black() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.sqlite3");
    drop(Database::open(&path).unwrap());
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection.execute_batch("DROP TABLE sticky_notes;
CREATE TABLE sticky_notes(id TEXT PRIMARY KEY, title TEXT NOT NULL CHECK(length(CAST(title AS BLOB))<=256), text TEXT NOT NULL CHECK(length(CAST(text AS BLOB))<=65536), updated_at INTEGER NOT NULL, color TEXT NOT NULL DEFAULT 'yellow' CHECK(color IN ('yellow','green','blue','pink','purple','gray')), html TEXT CHECK(html IS NULL OR length(CAST(html AS BLOB))<=131072));
PRAGMA user_version=8;").unwrap();
    let colors = ["yellow", "green", "blue", "pink", "purple", "gray"];
    for (n, color) in colors.iter().enumerate() {
        connection.execute("INSERT INTO sticky_notes VALUES(?1,?2,?3,?4,?5,?6)",
            rusqlite::params![format!("{n:032x}"), "old title", "é".repeat(MAX_TEXT / 2), n as i64, color, "<u>keep</u><strike>this</strike>"]).unwrap();
    }
    drop(connection);
    let db = Database::open(&path).unwrap();
    for (n, color) in colors.iter().enumerate() {
        let note = db.read_sticky(&format!("{n:032x}")).unwrap();
        assert_eq!(&note.color, color);
        assert_eq!(note.title, "old title");
        assert_eq!(note.text, "é".repeat(MAX_TEXT / 2));
        assert_eq!(note.html.as_deref(), Some("<u>keep</u><strike>this</strike>"));
    }
    let new = db.create_sticky().unwrap();
    assert_eq!(db.read_sticky(&new.id).unwrap().color, "black");
    drop(db);
    let connection = rusqlite::Connection::open(&path).unwrap();
    assert_eq!(connection.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0)).unwrap(), 12);
    assert!(connection.execute("UPDATE sticky_notes SET color='red'", []).is_err());
    assert!(connection.execute("UPDATE sticky_notes SET text=?1", ["x".repeat(MAX_TEXT + 1)]).is_err());
    assert!(connection.execute("UPDATE sticky_notes SET title=?1", ["x".repeat(MAX_TITLE + 1)]).is_err());
    assert!(connection.execute("UPDATE sticky_notes SET html=?1", ["x".repeat(MAX_HTML + 1)]).is_err());
    drop(connection);
    assert_eq!(Database::open(&path).unwrap().read_sticky(&new.id).unwrap().color, "black");
}

#[test]
fn plus_admission_and_failed_construction_preserve_existing_notes_and_release_reservations() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("state.sqlite3")).unwrap();
    let original = db.create_sticky().unwrap();
    db.update_sticky(&original.id, "keep", "precious text").unwrap();
    let mut admission = Admission::default();
    admission.reserve(&original.id).unwrap();
    admission.failed_open(&db, &original.id, false).unwrap();
    assert_eq!(db.read_sticky(&original.id).unwrap().text, "precious text");
    admission.check_delete(&original.id).unwrap();
    for _ in 0..100 {
        let new = admission.reserve_new(&db).unwrap();
        assert!(admission.check_delete(&new.id).is_err());
        admission.failed_open(&db, &new.id, true).unwrap();
        admission.check_delete(&new.id).unwrap();
        assert_eq!(db.list_stickies().unwrap().len(), 1);
    }
    admission.set_closing(true).unwrap();
    assert!(admission.reserve_new(&db).is_err());
    admission.set_closing(false).unwrap();
    for n in 0..MAX_NOTES { admission.reserve(&format!("{n:032x}")).unwrap(); }
    assert!(admission.reserve_new(&db).is_err());
    assert_eq!(db.list_stickies().unwrap().len(), 1);
    for n in 0..MAX_NOTES { admission.release(&format!("{n:032x}")); }
    // The database limit is independent of window admission.
    for _ in 1..MAX_NOTES { db.create_sticky().unwrap(); }
    assert!(admission.reserve_new(&db).is_err());
    admission.set_closing(true).unwrap();
}

#[test]
fn rollback_storage_failure_is_reported_and_does_not_leak_window_admission() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.sqlite3");
    let db = Database::open(&path).unwrap();
    let mut admission = Admission::default();
    let note = admission.reserve_new(&db).unwrap();
    rusqlite::Connection::open(&path).unwrap().execute_batch("CREATE TRIGGER fail_delete BEFORE DELETE ON sticky_notes BEGIN SELECT RAISE(FAIL,'disk unavailable'); END;").unwrap();
    let error = admission.failed_open(&db, &note.id, true).unwrap_err();
    assert!(error.contains("disk unavailable"));
    assert!(error.contains(&note.id));
    assert!(error.contains("saved notes list"));
    admission.check_delete(&note.id).unwrap();
    assert_eq!(db.list_stickies().unwrap().len(), 1);
    admission.set_closing(true).unwrap();
}

#[test]
fn sticky_dispatch_only_allows_own_note_operations_and_new_note_creation() {
    use notation_lib::sticky::authorize_command;
    let label = format!("sticky-{ID}");
    for command in ["read_sticky_note", "update_sticky_note", "close_sticky_note", "drag_sticky_note", "new_sticky_note"] {
        authorize_command(&label, command).unwrap();
        authorize_note(&label, ID).unwrap();
        assert!(authorize_note(&label, "abcdef0123456789abcdef0123456789").is_err());
        assert!(authorize_note("main", ID).is_err());
    }
    for command in ["create_sticky_note", "open_sticky_note", "delete_sticky_note", "list_sticky_notes", "persist_state", "read_file", "run_script", "launch_ready", "plugin:window|start_dragging"] {
        assert!(authorize_command(&label, command).is_err(), "{command}");
        authorize_command("main", command).unwrap();
    }
}

#[test]
fn window_teardown_never_waits_for_a_busy_admission_lock() {
    use std::sync::{mpsc, Arc};
    use std::time::{Duration, Instant};
    let manager = Arc::new(StickyManager::default());
    let id = "0123456789abcdef0123456789abcdef";
    assert!(manager.lock().unwrap().reserve(id).unwrap());
    // Uncontended: released on the spot.
    assert!(manager.try_release(id));
    assert!(manager.lock().unwrap().reserve(id).unwrap());

    // A sticky command holds the lock while it waits for a busy database.
    let (locked, wait_locked) = mpsc::channel();
    let (finish, wait_finish) = mpsc::channel::<()>();
    let holder = {
        let manager = manager.clone();
        std::thread::spawn(move || {
            let admission = manager.lock().unwrap();
            locked.send(()).unwrap();
            wait_finish.recv().unwrap();
            drop(admission);
        })
    };
    wait_locked.recv().unwrap();
    let started = Instant::now();
    assert!(!manager.try_release(id), "a busy lock must be reported, not waited for");
    assert!(started.elapsed() < Duration::from_millis(50), "{:?}", started.elapsed());

    // The deferred release (what the Destroyed handler hands to a worker)
    // completes once the command lets go.
    let deferred = {
        let manager = manager.clone();
        std::thread::spawn(move || manager.lock().unwrap().release(id))
    };
    std::thread::sleep(Duration::from_millis(20));
    assert!(!deferred.is_finished());
    finish.send(()).unwrap();
    holder.join().unwrap();
    deferred.join().unwrap();
    // Released: the same note can be reserved again.
    assert!(manager.lock().unwrap().reserve(id).unwrap());
}
