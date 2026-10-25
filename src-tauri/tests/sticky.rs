use notation_lib::sticky::{
    authorize_main, authorize_note, valid_id, Admission, StickyManager, MAX_NOTES, MAX_TEXT,
    MAX_TITLE,
};
use notation_lib::storage::{Database, StateUpdate};
use serde_json::json;
use std::sync::{Arc, Barrier};

const ID: &str = "0123456789abcdef0123456789abcdef";

#[test]
fn migration_seven_preserves_ordinary_state_and_independent_notes() {
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
    drop(db);
    let db = Database::open(&path).unwrap();
    assert_eq!(
        db.read_sticky(&a.id).unwrap().text,
        "<script>plain text</script>"
    );
    let metadata = serde_json::to_value(db.list_stickies().unwrap()).unwrap();
    assert!(metadata[0].get("text").is_none());
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
