use notation_lib::automation::{ScriptDocument, ScriptRequest, ScriptResponse};
use notation_lib::storage::{Database, LegacyState, ScriptInput, StateUpdate};
use serde_json::{json, Value};
use std::fs;

fn draft(content: &str) -> Value {
    json!({"id":"draft-1","content":content,"name":"draft.md","path":null,"savedContent":"","savedName":"draft.md"})
}

#[test]
fn schema_seven_stickies_migrate_to_eight_without_touching_titles_or_maximum_plain_text() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("state.sqlite3");
    let db = Database::open(&path).unwrap();
    db.persist(StateUpdate { settings: Some(json!({"fontSize": 17})), draft: Some(draft("ordinary")), ..Default::default() }).unwrap();
    drop(db);
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection.execute_batch("DROP TABLE sticky_notes; CREATE TABLE sticky_notes(id TEXT PRIMARY KEY, title TEXT NOT NULL CHECK(length(CAST(title AS BLOB))<=256), text TEXT NOT NULL CHECK(length(CAST(text AS BLOB))<=65536), updated_at INTEGER NOT NULL); PRAGMA user_version=7;").unwrap();
    let id = "0123456789abcdef0123456789abcdef";
    let body = "é".repeat(32768);
    connection.execute("INSERT INTO sticky_notes(id,title,text,updated_at) VALUES(?1,?2,?3,42)", rusqlite::params![id, "<b>literal title</b>", body]).unwrap();
    drop(connection);
    let db = Database::open(&path).unwrap();
    let note = db.read_sticky(id).unwrap();
    assert_eq!(note.title, "<b>literal title</b>");
    assert_eq!(note.text, body);
    assert_eq!(note.color, "yellow");
    assert!(note.html.is_none());
    assert_eq!(db.list_stickies().unwrap()[0].updated_at, 42);
    let state = db.bootstrap(None).unwrap();
    assert_eq!(state.settings["fontSize"], 17);
    assert_eq!(state.draft.unwrap()["content"], "ordinary");
    drop(db);
    let connection = rusqlite::Connection::open(&path).unwrap();
    assert_eq!(connection.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0)).unwrap(), 13);
    // SQLite also rejects invalid color/markup if a future caller misses validation.
    assert!(connection.execute("UPDATE sticky_notes SET color='red' WHERE id=?1", [id]).is_err());
    assert!(connection.execute("UPDATE sticky_notes SET html=?2 WHERE id=?1", rusqlite::params![id, "x".repeat(131073)]).is_err());
}
fn script() -> ScriptInput {
    ScriptInput {
        id: "script-1".into(),
        name: "My script".into(),
        code: "return 42;".into(),
        cwd: None,
    }
}
fn request(id: &str) -> ScriptRequest {
    ScriptRequest {
        id: id.into(),
        code: "return 42;".into(),
        cwd: None,
        script_id: Some("script-1".into()),
        document: ScriptDocument {
            name: "draft.md".into(),
            path: None,
            text: "content".into(),
            selection: String::new(),
            from: 0,
            to: 0,
        },
    }
}
fn response(id: &str) -> ScriptResponse {
    ScriptResponse {
        id: id.into(),
        ok: true,
        logs: vec![],
        result: json!(42),
        error: None,
    }
}

#[test]
fn migrates_legacy_once_and_restores_metadata_across_reopening() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("data/state.sqlite3");
    let database = Database::open(&path).unwrap();
    let legacy = LegacyState {
        session: None,
        settings: Some(json!({"theme":"light","fontSize":16})),
        draft: Some(draft("original")),
        script_draft: Some(json!({"name":"working","code":"return 'draft';","cwd":null})),
        scripts: vec![script()],
        recents: vec![],
    };
    let state = database.bootstrap(Some(legacy)).unwrap();
    assert!(state.migration_applied);
    assert_eq!(state.draft.unwrap()["content"], "original");
    assert_eq!(state.scripts.len(), 1);
    assert_eq!(state.script_draft.unwrap()["name"], "working");
    database
        .persist(StateUpdate {
            session: None,
            settings: Some(json!({"activeScriptId":"script-1"})),
            draft: Some(draft("edited")),
            script_draft: None,
        })
        .unwrap();
    drop(database);
    let database = Database::open(&path).unwrap();
    let legacy = LegacyState {
        session: None,
        settings: Some(json!({"theme":"dark"})),
        draft: Some(draft("stale")),
        ..Default::default()
    };
    let state = database.bootstrap(Some(legacy)).unwrap();
    assert!(!state.migration_applied);
    assert_eq!(state.draft.unwrap()["content"], "edited");
    assert_eq!(state.settings["theme"], "light");
    assert_eq!(state.settings["activeScriptId"], "script-1");
    assert_eq!(database.list_revisions("draft-1").unwrap().len(), 1);
}

#[test]
fn legacy_migration_skips_oversized_scripts_and_still_commits_the_marker() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("db/state.sqlite3");
    let database = Database::open(&path).unwrap();
    let legacy_scripts = || {
        vec![
            ScriptInput {
                id: "script-oversized".into(),
                name: "Oversized".into(),
                code: "x".repeat(128 * 1024 + 1),
                cwd: None,
            },
            script(),
        ]
    };
    let state = database
        .bootstrap(Some(LegacyState {
            session: None,
            settings: None,
            draft: None,
            script_draft: None,
            scripts: legacy_scripts(),
            recents: vec![],
        }))
        .unwrap();
    assert!(state.migration_applied);
    assert_eq!(state.skipped_legacy_items, vec!["scripts"]);
    assert_eq!(state.scripts.len(), 1);
    assert_eq!(state.scripts[0].id, "script-1");
    let scripts = database.list_scripts().unwrap();
    assert_eq!(scripts.len(), 1);
    assert!(scripts.iter().all(|script| script.id != "script-oversized"));
    drop(database);
    let database = Database::open(&path).unwrap();
    let state = database
        .bootstrap(Some(LegacyState {
            session: None,
            settings: None,
            draft: None,
            script_draft: None,
            scripts: legacy_scripts(),
            recents: vec![],
        }))
        .unwrap();
    assert!(
        !state.migration_applied,
        "committed migration marker must survive the skipped script"
    );
    assert!(state.skipped_legacy_items.is_empty());
    assert_eq!(state.scripts.len(), 1);
}

#[test]
fn legacy_migration_skips_invalid_fields_and_reports_them_once() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("db/state.sqlite3");
    let database = Database::open(&path).unwrap();
    let legacy = || LegacyState {
        session: Some(json!({
            "activeTabId": "draft-1",
            "tabs": [{"id": "draft-1", "name": "draft.md", "content": "ok", "savedContent": "ok"}],
            "updatedAt": 1
        })),
        settings: Some(json!({"theme": "light"})),
        draft: Some(draft("original")),
        script_draft: Some(json!({
            "name": "working",
            "code": "x".repeat(128 * 1024 + 1),
            "cwd": null
        })),
        scripts: vec![script()],
        recents: vec![],
    };
    let state = database.bootstrap(Some(legacy())).unwrap();
    assert!(state.migration_applied);
    assert_eq!(state.skipped_legacy_items, vec!["script draft"]);
    assert_eq!(state.scripts.len(), 1);
    assert_eq!(state.scripts[0].id, "script-1");
    assert_eq!(state.draft.unwrap()["content"], "original");
    assert_eq!(state.settings["theme"], "light");
    assert_eq!(state.session.unwrap()["activeTabId"], "draft-1");
    assert!(
        state.script_draft.is_none(),
        "only the oversized script draft is skipped"
    );
    drop(database);

    let database = Database::open(&path).unwrap();
    let state = database.bootstrap(Some(legacy())).unwrap();
    assert!(
        !state.migration_applied,
        "committed migration marker must survive skipped fields"
    );
    assert!(
        state.skipped_legacy_items.is_empty(),
        "a committed migration must not re-report skips on reopen"
    );
    assert_eq!(database.list_scripts().unwrap().len(), 1);
}

#[test]
fn legacy_migration_reports_each_skipped_field_and_keeps_valid_ones() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("db/state.sqlite3");
    let database = Database::open(&path).unwrap();
    let state = database
        .bootstrap(Some(LegacyState {
            session: Some(json!({"tabs": "not-an-array"})),
            settings: Some(json!({"blob": "x".repeat(64 * 1024)})),
            draft: Some(draft("kept")),
            script_draft: Some(json!({"name": "working", "code": "return 1;", "cwd": null})),
            scripts: vec![],
            recents: vec![],
        }))
        .unwrap();
    assert_eq!(state.skipped_legacy_items, vec!["session", "settings"]);
    assert!(state.session.is_none());
    assert_eq!(state.settings, json!({}));
    assert_eq!(state.draft.unwrap()["content"], "kept");
    assert_eq!(state.script_draft.unwrap()["name"], "working");
    assert!(state.migration_applied);
    drop(database);

    let database = Database::open(&path).unwrap();
    let state = database.bootstrap(Some(LegacyState::default())).unwrap();
    assert!(!state.migration_applied);
    assert!(state.skipped_legacy_items.is_empty());
    assert_eq!(state.draft.unwrap()["content"], "kept");
}

#[test]
fn existing_user_state_wins_over_legacy_and_bad_updates_are_atomic() {
    let directory = tempfile::tempdir().unwrap();
    let database = Database::open(&directory.path().join("db/state.sqlite3")).unwrap();
    database.save_script(script()).unwrap();
    let state = database
        .bootstrap(Some(LegacyState {
            session: None,
            settings: Some(json!({"theme":"light"})),
            ..Default::default()
        }))
        .unwrap();
    assert!(!state.migration_applied);
    assert_eq!(state.settings, json!({}));
    let result = database.persist(StateUpdate {
        session: None,
        settings: Some(json!({"theme":"dark"})),
        draft: Some(json!({"content":42})),
        script_draft: None,
    });
    assert!(result.is_err());
    assert_eq!(database.bootstrap(None).unwrap().settings, json!({}));
}

#[test]
fn revisions_are_bounded_and_restore_reads_never_replace_source_files() {
    let directory = tempfile::tempdir().unwrap();
    let database = Database::open(&directory.path().join("db/state.sqlite3")).unwrap();
    let file = directory.path().join("note.md");
    fs::write(&file, "source remains authoritative").unwrap();
    let path = file.to_str().unwrap();
    for version in 0..60 {
        database
            .record_document(path, &format!("version {version}"), true)
            .unwrap();
    }
    database.record_document(path, "version 59", true).unwrap();
    let revisions = database.list_revisions(path).unwrap();
    assert_eq!(revisions.len(), 50);
    let oldest = database.get_revision(revisions.last().unwrap().id).unwrap();
    assert_eq!(oldest.content.as_deref(), Some("version 10"));
    assert_eq!(
        database
            .get_revision(revisions[0].id)
            .unwrap()
            .content
            .as_deref(),
        Some("version 59")
    );
    assert_eq!(
        fs::read_to_string(&file).unwrap(),
        "source remains authoritative"
    );
    assert_eq!(database.recents().unwrap().len(), 1);
    let update: StateUpdate = serde_json::from_value(json!({"draft":null})).unwrap();
    database.persist(update).unwrap();
    assert!(database.bootstrap(None).unwrap().draft.is_none());
    assert_eq!(database.list_revisions(path).unwrap().len(), 50);
}

#[test]
fn saved_scripts_working_drafts_and_bounded_run_history_are_independent() {
    let directory = tempfile::tempdir().unwrap();
    let database = Database::open(&directory.path().join("db/state.sqlite3")).unwrap();
    database.save_script(script()).unwrap();
    database
        .persist(StateUpdate {
            session: None,
            script_draft: Some(
                json!({"id":"script-1","name":"Unsaved edit","code":"return 7;","cwd":null}),
            ),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(database.list_scripts().unwrap()[0].code, "return 42;");
    for run in 0..205 {
        let id = format!("run-{run}");
        database
            .record_run(&request(&id), &response(&id), run)
            .unwrap();
    }
    assert_eq!(database.list_script_runs(None).unwrap().len(), 200);
    assert_eq!(
        database.list_script_runs(Some("script-1")).unwrap().len(),
        200
    );
    assert_eq!(database.list_script_runs(None).unwrap()[0].result, 42);
    database.delete_script("script-1").unwrap();
    assert!(database.list_scripts().unwrap().is_empty());
    assert_eq!(database.list_script_runs(None).unwrap().len(), 200);
    assert!(database.bootstrap(None).unwrap().script_draft.is_some());
}

#[test]
fn fts_tags_tasks_and_backlinks_exclude_code_and_math_metadata() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("notes");
    fs::create_dir_all(root.join("folder")).unwrap();
    fs::write(root.join("alpha.md"),"---\ntags: [project, alpha]\n---\n# Alpha\nUnique nebula word. #focus\n- [ ] First task\n[x] Bare finished\n[] Bare empty\n> - [ ] Quoted task\n> > 1. [X] Nested completed\n- []\n[ ]\n[]not a task\n> [xx] not a task\n[Beta](folder/beta.md)\n[[folder/beta|Alias]]\n`#inline-code [[ghost]]`\n```md\n#fake\n- [ ] fake task\n> - [] fake quoted task\n[[ghost]]\n```\n$$\n#math\n[ ] equation\n$$\n").unwrap();
    fs::write(
        root.join("folder/beta.md"),
        "# Beta\nSecond nebula #focus\n",
    )
    .unwrap();
    fs::write(
        root.join("graph.mmd"),
        "flowchart LR\n A[Start] --> B[End]\n%% #not-a-tag\n",
    )
    .unwrap();
    let database = Database::open(&directory.path().join("db/state.sqlite3")).unwrap();
    database.set_workspace(root.to_str().unwrap()).unwrap();
    let report = database.index_workspace().unwrap();
    assert_eq!(report.indexed, 3);
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    assert_eq!(database.search_workspace("nebula", None).unwrap().len(), 2);
    assert_eq!(database.search_workspace("", None).unwrap().len(), 3);
    assert_eq!(
        database.search_workspace("uni", None).unwrap()[0].title,
        "Alpha"
    );
    assert!(database.search_workspace("\" OR *", None).is_ok());
    let tags = database.get_tags().unwrap();
    assert_eq!(
        tags.iter().map(|tag| tag.tag.as_str()).collect::<Vec<_>>(),
        ["alpha", "focus", "project"]
    );
    assert_eq!(tags.iter().find(|tag| tag.tag == "focus").unwrap().count, 2);
    let tasks = database.get_tasks(None).unwrap();
    assert_eq!(tasks.len(), 7);
    assert_eq!(tasks.iter().filter(|task| task.checked).count(), 2);
    for expected in ["Bare empty", "Quoted task", "Nested completed"] {
        assert!(tasks.iter().any(|task| task.text == expected));
    }
    assert_eq!(tasks.iter().filter(|task| task.text.is_empty()).count(), 2);
    assert_eq!(
        database.get_tasks(Some(false)).unwrap()[0].text,
        "First task"
    );
    assert_eq!(
        database.get_tasks(Some(true)).unwrap()[0].text,
        "Bare finished"
    );
    let backlinks = database
        .get_backlinks(root.join("folder/beta.md").to_str().unwrap())
        .unwrap();
    assert_eq!(backlinks.len(), 2);
    assert!(backlinks.iter().all(|link| link.path.ends_with("alpha.md")));
}

#[test]
fn reindex_reflects_external_changes_and_preserves_all_application_state() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("notes");
    fs::create_dir(&root).unwrap();
    let note = root.join("note.md");
    fs::write(&note, "# Old\noldphrase #oldtag\n- [ ] old task\n").unwrap();
    let database = Database::open(&directory.path().join("db/state.sqlite3")).unwrap();
    database
        .persist(StateUpdate {
            session: None,
            settings: Some(json!({"theme":"light"})),
            draft: Some(draft("unsaved")),
            script_draft: Some(json!({"code":"return 99;"})),
        })
        .unwrap();
    database.save_script(script()).unwrap();
    database
        .record_run(&request("run"), &response("run"), 1)
        .unwrap();
    database
        .record_document(note.to_str().unwrap(), "revision", true)
        .unwrap();
    database.set_workspace(root.to_str().unwrap()).unwrap();
    database.index_workspace().unwrap();
    fs::write(&note, "# Changed\nnewphrase #newtag\n- [x] new task\n").unwrap();
    database.index_workspace().unwrap();
    assert!(database
        .search_workspace("oldphrase", None)
        .unwrap()
        .is_empty());
    assert_eq!(
        database.search_workspace("newphrase", None).unwrap().len(),
        1
    );
    assert_eq!(database.get_tags().unwrap()[0].tag, "newtag");
    assert_eq!(database.get_tasks(Some(true)).unwrap()[0].text, "new task");
    let state = database.bootstrap(None).unwrap();
    assert_eq!(state.settings["theme"], "light");
    assert_eq!(state.draft.unwrap()["content"], "unsaved");
    assert!(state.script_draft.is_some());
    assert_eq!(state.scripts.len(), 1);
    assert_eq!(state.workspace.as_deref(), root.to_str());
    assert_eq!(database.list_script_runs(None).unwrap().len(), 1);
    assert_eq!(
        database
            .list_revisions(note.to_str().unwrap())
            .unwrap()
            .len(),
        1
    );
    fs::remove_file(&note).unwrap();
    database.index_workspace().unwrap();
    assert!(database.search_workspace("", None).unwrap().is_empty());
    assert_eq!(
        database
            .list_revisions(note.to_str().unwrap())
            .unwrap()
            .len(),
        1
    );
}

#[cfg(unix)]
#[test]
fn skips_symlink_escapes_hidden_and_build_directories_and_reports_bad_files() {
    use std::os::unix::fs::symlink;
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("notes");
    fs::create_dir(&root).unwrap();
    let outside = directory.path().join("outside");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("secret.md"), "outside secret").unwrap();
    symlink(&outside, root.join("escape")).unwrap();
    symlink(outside.join("secret.md"), root.join("link.md")).unwrap();
    for hidden in [".private", "node_modules", "target"] {
        fs::create_dir(root.join(hidden)).unwrap();
        fs::write(root.join(hidden).join("ignored.md"), "ignored").unwrap();
    }
    fs::write(root.join("good.md"), "# Good\ninside").unwrap();
    fs::write(root.join("bad.md"), [0xff]).unwrap();
    let database = Database::open(&directory.path().join("db/state.sqlite3")).unwrap();
    database.set_workspace(root.to_str().unwrap()).unwrap();
    let report = database.index_workspace().unwrap();
    assert_eq!(report.indexed, 1);
    assert!(report.skipped >= 6);
    assert!(report.errors.iter().any(|error| error.contains("UTF-8")));
    assert!(database
        .search_workspace("secret", None)
        .unwrap()
        .is_empty());
}

#[cfg(unix)]
#[test]
fn database_is_private_and_failed_initialization_preserves_original_bytes() {
    use std::os::unix::fs::PermissionsExt;
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("data/state.sqlite3");
    let database = Database::open(&path).unwrap();
    database
        .persist(StateUpdate {
            session: None,
            settings: Some(json!({"theme":"dark"})),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(
        fs::metadata(path.parent().unwrap())
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    assert_eq!(
        fs::metadata(format!("{}-wal", path.display()))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    drop(database);
    let bad = directory.path().join("broken/state.sqlite3");
    fs::create_dir_all(bad.parent().unwrap()).unwrap();
    fs::write(&bad, b"original invalid sqlite data").unwrap();
    assert!(Database::open(&bad).is_err());
    assert_eq!(fs::read(&bad).unwrap(), b"original invalid sqlite data");
}

#[test]
fn file_io_and_script_results_survive_database_initialization_failure_with_warnings() {
    use notation_lib::storage::{read_with_metadata, record_run_optional, write_with_metadata};
    let directory = tempfile::tempdir().unwrap();
    let bad = directory.path().join("data/state.sqlite3");
    fs::create_dir_all(bad.parent().unwrap()).unwrap();
    fs::write(&bad, b"original broken sqlite").unwrap();
    let database = Database::open(&bad);
    assert!(database.is_err());
    let file = directory.path().join("important.md");
    let path = file.to_str().unwrap();
    let saved = write_with_metadata(path, "important source content", &database).unwrap();
    assert_eq!(saved.content, "important source content");
    assert!(saved.warning.unwrap().contains("File saved"));
    let opened = read_with_metadata(path, &database).unwrap();
    assert_eq!(opened.content, "important source content");
    assert!(opened.warning.is_some());
    assert_eq!(fs::read(&bad).unwrap(), b"original broken sqlite");
    let mut result = response("completed");
    record_run_optional(&database, &request("completed"), &mut result, 1);
    assert!(result.ok);
    assert_eq!(result.result, 42);
    assert_eq!(result.logs[0].level, "warn");
    assert!(result.logs[0].message.contains("history"));
}

#[test]
fn first_overwrite_retains_old_disk_baseline_and_new_saved_text() {
    use notation_lib::storage::write_with_metadata;
    let directory = tempfile::tempdir().unwrap();
    let database = Database::open(&directory.path().join("db/state.sqlite3")).unwrap();
    let file = directory.path().join("existing.md");
    fs::write(&file, "old disk baseline").unwrap();
    let path = file.to_str().unwrap();
    let saved = write_with_metadata(path, "new saved text", &Ok(database.clone())).unwrap();
    assert!(saved.warning.is_none());
    assert_eq!(fs::read_to_string(&file).unwrap(), "new saved text");
    let revisions = database.list_revisions(path).unwrap();
    assert_eq!(revisions.len(), 2);
    assert_eq!(revisions[0].reason, "save");
    assert_eq!(
        database
            .get_revision(revisions[0].id)
            .unwrap()
            .content
            .as_deref(),
        Some("new saved text")
    );
    assert_eq!(revisions[1].reason, "before-save");
    assert_eq!(
        database
            .get_revision(revisions[1].id)
            .unwrap()
            .content
            .as_deref(),
        Some("old disk baseline")
    );
    fs::write(&file, "external edit").unwrap();
    write_with_metadata(path, "next save", &Ok(database.clone())).unwrap();
    let revisions = database.list_revisions(path).unwrap();
    assert_eq!(revisions.len(), 4);
    assert_eq!(
        database
            .get_revision(revisions[1].id)
            .unwrap()
            .content
            .as_deref(),
        Some("external edit")
    );
}

#[test]
fn session_preserves_per_tab_hemingway_through_legacy_import_updates_and_reopening() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("data/state.sqlite3");
    let database = Database::open(&path).unwrap();
    let mut locked = draft("Keep every word.");
    locked["id"] = json!("locked");
    locked["hemingway"] = json!(true);
    let mut unlocked = draft("Editable text.");
    unlocked["id"] = json!("unlocked");
    unlocked["hemingway"] = json!(false);
    let mut legacy = draft("Older session without a mode field.");
    legacy["id"] = json!("legacy");
    let mut session = json!({"activeTabId":"locked","tabs":[locked,unlocked,legacy],"updatedAt":1});
    let imported = database
        .bootstrap(Some(LegacyState {
            session: Some(session.clone()),
            ..Default::default()
        }))
        .unwrap();
    assert!(imported.migration_applied);
    assert_eq!(imported.session.as_ref(), Some(&session));
    drop(database);

    let reopened = Database::open(&path).unwrap();
    let restored = reopened.bootstrap(None).unwrap().session.unwrap();
    assert_eq!(restored["tabs"][0]["hemingway"], true);
    assert_eq!(restored["tabs"][1]["hemingway"], false);
    // Older tabs remain valid; the frontend interprets an absent flag as false.
    assert!(restored["tabs"][2].get("hemingway").is_none());
    session["tabs"][0]["hemingway"] = json!(false);
    session["tabs"][1]["hemingway"] = json!(true);
    reopened
        .persist(StateUpdate {
            session: Some(session.clone()),
            ..Default::default()
        })
        .unwrap();
    drop(reopened);
    assert_eq!(
        Database::open(&path)
            .unwrap()
            .bootstrap(None)
            .unwrap()
            .session,
        Some(session)
    );
}

#[test]
fn session_migration_restores_all_tabs_and_rejects_oversized_or_invalid_updates_atomically() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("data/state.sqlite3");
    let database = Database::open(&path).unwrap();
    database
        .persist(StateUpdate {
            settings: Some(json!({"theme":"light"})),
            ..Default::default()
        })
        .unwrap();
    drop(database);
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection
        .execute_batch("DROP TABLE sessions; PRAGMA user_version=2;")
        .unwrap();
    drop(connection);
    let database = Database::open(&path).unwrap();
    let tab = |id: &str, content: &str| json!({"id":id,"name":format!("{id}.md"),"path":null,"content":content,"savedContent":"","savedName":format!("{id}.md"),"selection":{"anchor":1,"head":2}});
    let session = json!({"activeTabId":"two","tabs":[tab("one","active"),tab("two","inactive unsaved")],"updatedAt":7});
    database
        .persist(StateUpdate {
            session: Some(session.clone()),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(
        database.bootstrap(None).unwrap().session.as_ref(),
        Some(&session)
    );
    assert_eq!(database.list_revisions("two").unwrap().len(), 1);
    let mut oversized = session.clone();
    oversized["tabs"][1]["content"] = json!("x".repeat(4 * 1024 * 1024 + 1));
    assert!(database
        .persist(StateUpdate {
            session: Some(oversized),
            settings: Some(json!({"theme":"dark"})),
            ..Default::default()
        })
        .is_err());
    assert_eq!(
        database.bootstrap(None).unwrap().session.as_ref(),
        Some(&session)
    );
    assert_eq!(database.bootstrap(None).unwrap().settings["theme"], "light");
    let mut invalid = session.clone();
    invalid["activeTabId"] = json!("missing");
    assert!(database
        .persist(StateUpdate {
            session: Some(invalid),
            ..Default::default()
        })
        .is_err());
    drop(database);
    let reopened = Database::open(&path).unwrap();
    assert_eq!(
        reopened.bootstrap(None).unwrap().session.as_ref(),
        Some(&session)
    );
}

#[test]
fn navigation_summary_excludes_document_payloads_and_does_not_parse_them() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("state.sqlite3");
    let database = Database::open(&path).unwrap();
    database.bootstrap(None).unwrap();
    database
        .persist(StateUpdate {
            draft: Some(draft(&"large buffer".repeat(100_000))),
            ..Default::default()
        })
        .unwrap();
    let expected = database.bootstrap(None).unwrap();
    let summary = serde_json::to_value(database.metadata_summary().unwrap()).unwrap();
    assert_eq!(summary.as_object().unwrap().len(), 3);
    assert_eq!(
        summary["workspace"],
        serde_json::to_value(expected.workspace).unwrap()
    );
    assert_eq!(
        summary["workspaceCatalog"],
        serde_json::to_value(expected.workspace_catalog).unwrap()
    );
    assert_eq!(
        summary["recents"],
        serde_json::to_value(expected.recents).unwrap()
    );

    // A navigation refresh must neither parse nor repair unrelated snapshots.
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection
        .execute(
            "UPDATE drafts SET json='invalid preserved snapshot' WHERE id=1",
            [],
        )
        .unwrap();
    assert!(database.bootstrap(None).is_err());
    assert_eq!(
        serde_json::to_value(database.metadata_summary().unwrap()).unwrap(),
        summary
    );
    let retained: String = connection
        .query_row("SELECT json FROM drafts WHERE id=1", [], |row| row.get(0))
        .unwrap();
    assert_eq!(retained, "invalid preserved snapshot");
}

#[test]
fn encoded_session_limit_accepts_exact_boundary_and_rejects_one_more_byte_atomically() {
    let directory = tempfile::tempdir().unwrap();
    let database = Database::open(&directory.path().join("state.sqlite3")).unwrap();
    let text = "Unicode café 日本語, quote \" and backslash \\ and control \u{0001}";
    let mut session =
        json!({"activeTabId":"draft-1", "tabs":[draft(text)], "updatedAt":1, "padding":""});
    let limit = 32 * 1024 * 1024;
    let padding = limit - serde_json::to_vec(&session).unwrap().len();
    session["padding"] = json!("x".repeat(padding));
    assert_eq!(serde_json::to_vec(&session).unwrap().len(), limit);
    database
        .persist(StateUpdate {
            session: Some(session.clone()),
            settings: Some(json!({"theme":"light"})),
            ..Default::default()
        })
        .unwrap();
    let revisions = database.list_revisions("draft-1").unwrap().len();
    session["padding"] = json!("x".repeat(padding + 1));
    let error = database
        .persist(StateUpdate {
            session: Some(session),
            settings: Some(json!({"theme":"dark"})),
            ..Default::default()
        })
        .unwrap_err();
    assert!(error.contains("32 MiB recovery limit"));
    let restored = database.bootstrap(None).unwrap();
    assert_eq!(restored.settings["theme"], "light");
    let restored = restored.session.unwrap();
    assert_eq!(restored["tabs"][0]["content"], text);
    assert_eq!(restored["padding"].as_str().unwrap().len(), padding);
    assert_eq!(database.list_revisions("draft-1").unwrap().len(), revisions);
}

#[test]
fn escaped_draft_limits_rollback_session_and_settings_and_preserve_explicit_nulls() {
    let directory = tempfile::tempdir().unwrap();
    let database = Database::open(&directory.path().join("state.sqlite3")).unwrap();
    let session = json!({"activeTabId":"draft-1", "tabs":[draft("original")], "updatedAt":1});
    database
        .persist(StateUpdate {
            session: Some(session.clone()),
            draft: Some(draft("original")),
            settings: Some(json!({"theme":"light"})),
            ..Default::default()
        })
        .unwrap();
    let mut changed = session.clone();
    changed["tabs"][0]["content"] = json!("new content that must roll back");
    let revisions = database.list_revisions("draft-1").unwrap().len();
    // Within the raw text limit but beyond the JSON draft limit after escaping.
    let error = database
        .persist(StateUpdate {
            session: Some(changed),
            draft: Some(draft(&"\u{0001}".repeat(3 * 1024 * 1024))),
            settings: Some(json!({"theme":"dark"})),
            ..Default::default()
        })
        .unwrap_err();
    assert!(error.contains("Draft exceeds"));
    let restored = database.bootstrap(None).unwrap();
    assert_eq!(restored.session, Some(session));
    assert_eq!(restored.draft.unwrap()["content"], "original");
    assert_eq!(restored.settings["theme"], "light");
    assert_eq!(database.list_revisions("draft-1").unwrap().len(), revisions);
    let error = database
        .persist(StateUpdate {
            script_draft: Some(json!({"code":"\u{0001}".repeat(128 * 1024)})),
            ..Default::default()
        })
        .unwrap_err();
    assert!(error.contains("Script draft must contain"));
    let clear: StateUpdate =
        serde_json::from_value(json!({"session":null,"draft":null,"scriptDraft":null})).unwrap();
    database.persist(clear).unwrap();
    let cleared = database.bootstrap(None).unwrap();
    assert!(cleared.session.is_none() && cleared.draft.is_none() && cleared.script_draft.is_none());
}

/// The index tables as schema versions 2 to 11 kept them in the state database.
const LEGACY_INDEX: &str = "
CREATE TABLE cache_files(path TEXT PRIMARY KEY, name TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL);
CREATE VIRTUAL TABLE cache_fts USING fts5(path UNINDEXED,title,body,tokenize='unicode61');
CREATE TABLE cache_links(source_path TEXT NOT NULL,line INTEGER NOT NULL,text TEXT NOT NULL,target_path TEXT NOT NULL);
CREATE INDEX cache_links_target ON cache_links(target_path);
CREATE TABLE cache_tags(path TEXT NOT NULL,line INTEGER NOT NULL,tag TEXT NOT NULL);
CREATE TABLE cache_tasks(path TEXT NOT NULL,line INTEGER NOT NULL,text TEXT NOT NULL,checked INTEGER NOT NULL);
CREATE TABLE cache_frontmatter(path TEXT PRIMARY KEY,json TEXT NOT NULL);
CREATE TABLE cache_properties(path TEXT NOT NULL,key TEXT NOT NULL,kind TEXT NOT NULL,json_value TEXT NOT NULL);
CREATE INDEX cache_properties_lookup ON cache_properties(key,kind,json_value);
CREATE TABLE cache_headings(path TEXT NOT NULL,text TEXT NOT NULL,line INTEGER NOT NULL,level INTEGER NOT NULL);
CREATE TABLE cache_blocks(path TEXT NOT NULL,id TEXT NOT NULL,line INTEGER NOT NULL);
CREATE TABLE cache_graph_links(source_path TEXT NOT NULL,line INTEGER NOT NULL,raw_target TEXT NOT NULL,kind TEXT NOT NULL,target_path TEXT,status TEXT NOT NULL,candidates_json TEXT NOT NULL,heading TEXT,alias TEXT);
CREATE INDEX cache_graph_source ON cache_graph_links(source_path);
";

fn legacy_database(directory: &std::path::Path, version: i64, baseline: bool) -> std::path::PathBuf {
    let path = directory.join("state.sqlite3");
    let database = Database::open(&path).unwrap();
    database.persist(StateUpdate { settings: Some(json!({"theme":"light"})), ..Default::default() }).unwrap();
    let index = database.index_path();
    drop(database);
    for suffix in ["", "-wal", "-shm"] {
        let _ = fs::remove_file(format!("{}{suffix}", index.display()));
    }
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection.execute_batch(LEGACY_INDEX).unwrap();
    connection.execute_batch("
INSERT INTO cache_files(rowid,path,name,title,content) VALUES(7,'/notes/kept.md','kept.md','Kept','zebra crossing'),(9,'/notes/other.md','other.md','Other','plain');
INSERT INTO cache_fts(rowid,path,title,body) VALUES(7,'/notes/kept.md','Kept','zebra crossing'),(9,'/notes/other.md','Other','plain');
INSERT INTO cache_frontmatter(path,json) VALUES('/notes/kept.md','{}');
INSERT INTO cache_tags(path,line,tag) VALUES('/notes/kept.md',1,'kept');
INSERT INTO cache_tasks(path,line,text,checked) VALUES('/notes/kept.md',2,'kept task',0);
INSERT INTO cache_headings(path,text,line,level) VALUES('/notes/kept.md','Kept',1,1);
INSERT INTO cache_blocks(path,id,line) VALUES('/notes/kept.md','b1',3);
INSERT INTO cache_properties(path,key,kind,json_value) VALUES('/notes/kept.md','rank','number','1');
INSERT INTO cache_links(source_path,line,text,target_path) VALUES('/notes/kept.md',4,'[[other]]','/notes/other.md');
INSERT INTO cache_graph_links(source_path,line,raw_target,kind,target_path,status,candidates_json) VALUES('/notes/kept.md',4,'other','wiki','/notes/other.md','resolved','[]');
").unwrap();
    if baseline {
        connection.execute("INSERT INTO app_meta(key,value) VALUES('index_baseline','{\"marker\":true}')", []).unwrap();
    }
    connection.execute_batch(&format!("PRAGMA user_version={version};")).unwrap();
    path
}

fn count(connection: &rusqlite::Connection, sql: &str) -> i64 {
    connection.query_row(sql, [], |row| row.get(0)).unwrap()
}

#[test]
fn the_index_moves_to_its_own_database_with_every_row_and_its_lookup_indexes() {
    for (version, baseline_kept) in [(9, false), (10, false), (11, true)] {
        let directory = tempfile::tempdir().unwrap();
        let path = legacy_database(directory.path(), version, true);
        let database = Database::open(&path).unwrap();
        assert_eq!(database.bootstrap(None).unwrap().settings["theme"], "light");
        let index_path = database.index_path();
        assert_ne!(index_path, path);
        drop(database);

        // The state database keeps user data and no longer holds the index.
        let state = rusqlite::Connection::open(&path).unwrap();
        assert_eq!(count(&state, "PRAGMA user_version"), 13, "from {version}");
        assert_eq!(count(&state, "SELECT count(*) FROM sqlite_master WHERE name LIKE 'cache_%'"), 0);
        assert_eq!(count(&state, "SELECT count(*) FROM app_meta WHERE key='index_baseline'"), 0);
        assert_eq!(count(&state, "SELECT count(*) FROM settings"), 1);

        // Every row arrived, with the note row ids the full-text rows share.
        let index = rusqlite::Connection::open(&index_path).unwrap();
        for (table, rows) in [("cache_files", 2), ("cache_frontmatter", 1), ("cache_tags", 1), ("cache_tasks", 1), ("cache_headings", 1), ("cache_blocks", 1), ("cache_properties", 1), ("cache_links", 1), ("cache_graph_links", 1)] {
            assert_eq!(count(&index, &format!("SELECT count(*) FROM {table}")), rows, "{table} from {version}");
        }
        assert_eq!(count(&index, "SELECT rowid FROM cache_files WHERE path='/notes/kept.md'"), 7);
        assert_eq!(count(&index, "SELECT rowid FROM cache_fts WHERE cache_fts MATCH 'zebra'"), 7);
        // Only a version that wrote real baselines keeps one.
        assert_eq!(count(&index, "SELECT count(*) FROM index_meta WHERE key='index_baseline'"), i64::from(baseline_kept), "from {version}");
        assert_eq!(count(&index, "SELECT count(*) FROM index_meta WHERE key='index_scope'"), 1);

        let plan = |sql: &str| -> String {
            let mut statement = index.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
            let rows = statement.query_map([], |row| row.get::<_, String>(3)).unwrap();
            rows.map(Result::unwrap).collect::<Vec<_>>().join("\n")
        };
        let tags = plan("SELECT f.path FROM cache_files f WHERE EXISTS(SELECT 1 FROM cache_tags t WHERE t.path=f.path AND t.tag='x')");
        assert!(tags.contains("cache_tags_path"), "{tags}");
        let properties = plan("SELECT f.path FROM cache_files f WHERE EXISTS(SELECT 1 FROM cache_properties p WHERE p.path=f.path AND p.key='x')");
        assert!(properties.contains("cache_properties_path"), "{properties}");
        for (table, column, name) in [("cache_headings", "path", "cache_headings_path"), ("cache_blocks", "path", "cache_blocks_path"), ("cache_tasks", "path", "cache_tasks_path"), ("cache_links", "source_path", "cache_links_source")] {
            let plan = plan(&format!("DELETE FROM {table} WHERE {column}='x'"));
            assert!(plan.contains(name), "{table}: {plan}");
        }
        drop((state, index));

        // Reopening keeps the moved index (it still matches the selection).
        let database = Database::open(&path).unwrap();
        drop(database);
        let index = rusqlite::Connection::open(&index_path).unwrap();
        assert_eq!(count(&index, "SELECT count(*) FROM cache_files"), 2);
    }
}

#[test]
fn an_unusable_or_mismatched_index_file_is_replaced_without_touching_state() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("state.sqlite3");
    let database = Database::open(&path).unwrap();
    database.persist(StateUpdate { settings: Some(json!({"theme":"light"})), ..Default::default() }).unwrap();
    let index_path = database.index_path();
    drop(database);
    // Garbage in place of the index.
    for suffix in ["-wal", "-shm"] {
        let _ = fs::remove_file(format!("{}{suffix}", index_path.display()));
    }
    fs::write(&index_path, b"this is not a database").unwrap();
    let database = Database::open(&path).unwrap();
    assert_eq!(database.bootstrap(None).unwrap().settings["theme"], "light");
    assert!(database.get_tags().unwrap().is_empty());
    drop(database);
    // An index recorded for another workspace selection is emptied on open.
    let index = rusqlite::Connection::open(&index_path).unwrap();
    index.execute_batch("INSERT INTO cache_tags(path,line,tag) VALUES('/stale.md',1,'stale'); INSERT OR REPLACE INTO index_meta(key,value) VALUES('index_scope','someone-else:41');").unwrap();
    drop(index);
    let database = Database::open(&path).unwrap();
    assert!(database.get_tags().unwrap().is_empty());
    assert_eq!(database.bootstrap(None).unwrap().settings["theme"], "light");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(fs::metadata(&index_path).unwrap().permissions().mode() & 0o777, 0o600);
    }
}

fn session_tab(id: &str, content: &str) -> Value {
    json!({"id":id,"name":format!("{id}.md"),"path":null,"content":content,"savedContent":"saved","savedName":format!("{id}.md"),"selection":{"anchor":1,"head":2}})
}

#[test]
fn unchanged_tab_markers_keep_stored_tabs_and_only_changed_tabs_are_rewritten() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("state.sqlite3");
    let database = Database::open(&path).unwrap();
    let full = json!({"activeTabId":"b","updatedAt":1,"workspaceViews":{"x":{"layout":"split"}},"tabs":[session_tab("a","alpha"),session_tab("b","beta"),session_tab("c","gamma")]});
    database.persist(StateUpdate { session: Some(full.clone()), ..Default::default() }).unwrap();
    assert_eq!(database.bootstrap(None).unwrap().session.as_ref(), Some(&full));

    // One tab edited, order changed, envelope changed; the others are markers.
    let delta = json!({"activeTabId":"c","updatedAt":2,"workspaceViews":{"x":{"layout":"live"}},"tabs":[{"id":"c","unchanged":true},session_tab("b","beta edited"),{"id":"a","unchanged":true}]});
    let rowids = |database: &Database| -> Vec<(String, String)> {
        let connection = rusqlite::Connection::open(&database.path).unwrap();
        let mut statement = connection.prepare("SELECT id, json FROM session_tabs ORDER BY id").unwrap();
        let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?))).unwrap();
        rows.map(Result::unwrap).collect()
    };
    let before = rowids(&database);
    database.persist(StateUpdate { session: Some(delta), ..Default::default() }).unwrap();
    let expected = json!({"activeTabId":"c","updatedAt":2,"workspaceViews":{"x":{"layout":"live"}},"tabs":[session_tab("c","gamma"),session_tab("b","beta edited"),session_tab("a","alpha")]});
    assert_eq!(database.bootstrap(None).unwrap().session.as_ref(), Some(&expected));
    let after = rowids(&database);
    assert_eq!((&before[0], &before[2]), (&after[0], &after[2]), "unchanged tabs keep their rows");
    assert_ne!(before[1], after[1]);
    // The replaced text of the edited tab is kept as a revision; untouched tabs gain none.
    let revisions = |key: &str| database.list_revisions(key).unwrap().len();
    assert_eq!((revisions("a"), revisions("b"), revisions("c")), (1, 1, 1));

    // A marker for a tab that is not stored is refused and changes nothing.
    let unknown = json!({"activeTabId":"a","updatedAt":3,"tabs":[{"id":"a","unchanged":true},{"id":"ghost","unchanged":true}]});
    let error = database.persist(StateUpdate { session: Some(unknown), settings: Some(json!({"theme":"dark"})), ..Default::default() }).unwrap_err();
    assert_eq!(error, notation_lib::storage::UNKNOWN_UNCHANGED_TAB);
    assert_eq!(database.bootstrap(None).unwrap().session.as_ref(), Some(&expected));
    assert!(database.bootstrap(None).unwrap().settings.get("theme").is_none());

    // Removing a tab drops its row and snapshots it; markers still validate
    // the active tab, duplicates and the size limit.
    let fewer = json!({"activeTabId":"a","updatedAt":4,"tabs":[{"id":"a","unchanged":true},{"id":"c","unchanged":true}]});
    database.persist(StateUpdate { session: Some(fewer), ..Default::default() }).unwrap();
    assert_eq!(database.bootstrap(None).unwrap().session.unwrap()["tabs"], json!([session_tab("a","alpha"),session_tab("c","gamma")]));
    assert_eq!(rowids(&database).len(), 2);
    assert_eq!(revisions("b"), 2);
    for invalid in [
        json!({"activeTabId":"missing","updatedAt":5,"tabs":[{"id":"a","unchanged":true}]}),
        json!({"activeTabId":"a","updatedAt":5,"tabs":[{"id":"a","unchanged":true},{"id":"a","unchanged":true}]}),
    ] {
        assert!(database.persist(StateUpdate { session: Some(invalid), ..Default::default() }).is_err());
    }
    // Eight tabs of two 4 MiB texts are within the per-text limit but over the
    // session limit; the ninth save is refused even though earlier tabs are markers.
    let big = "x".repeat(4 * 1024 * 1024);
    let mut tabs = vec![json!({"id":"a","unchanged":true}), json!({"id":"c","unchanged":true})];
    for index in 0..3 {
        let mut tab = session_tab(&format!("big{index}"), &big);
        tab["savedContent"] = json!(big);
        tabs.push(tab);
        database.persist(StateUpdate { session: Some(json!({"activeTabId":"a","updatedAt":6,"tabs":tabs})), ..Default::default() }).unwrap();
        let id = format!("big{index}");
        *tabs.last_mut().unwrap() = json!({"id":id,"unchanged":true});
    }
    let mut over = session_tab("big3", &big);
    over["savedContent"] = json!(big);
    tabs.push(over);
    let error = database.persist(StateUpdate { session: Some(json!({"activeTabId":"a","updatedAt":7,"tabs":tabs})), ..Default::default() }).unwrap_err();
    assert!(error.contains("32 MiB"), "{error}");
    assert_eq!(database.bootstrap(None).unwrap().session.unwrap()["tabs"].as_array().unwrap().len(), 5);

    // Clearing the session clears the tab rows too.
    database.persist(StateUpdate { session: Some(Value::Null), ..Default::default() }).unwrap();
    assert!(database.bootstrap(None).unwrap().session.is_none());
    assert_eq!(rowids(&database).len(), 0);
}

#[test]
fn schema_twelve_session_blob_is_split_into_tab_rows_without_changing_the_session() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("state.sqlite3");
    drop(Database::open(&path).unwrap());
    let session = json!({"activeTabId":"two","updatedAt":9,"activeWorkspaceId":null,"tabs":[session_tab("one","first ünï"),session_tab("two","second")]});
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection.execute_batch("DROP TABLE session_tabs; PRAGMA user_version=12;").unwrap();
    connection.execute("INSERT INTO sessions(id,json) VALUES(1,?1)", [session.to_string()]).unwrap();
    drop(connection);
    let database = Database::open(&path).unwrap();
    assert_eq!(database.bootstrap(None).unwrap().session.as_ref(), Some(&session));
    let connection = rusqlite::Connection::open(&path).unwrap();
    assert_eq!(connection.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0)).unwrap(), 13);
    assert_eq!(connection.query_row("SELECT count(*) FROM session_tabs", [], |row| row.get::<_, i64>(0)).unwrap(), 2);
    let envelope: String = connection.query_row("SELECT json FROM sessions WHERE id=1", [], |row| row.get(0)).unwrap();
    assert!(!envelope.contains("first"), "tab text no longer lives in the session row: {envelope}");
    // A following delta save works against the migrated rows.
    database.persist(StateUpdate { session: Some(json!({"activeTabId":"two","updatedAt":10,"tabs":[{"id":"one","unchanged":true},session_tab("two","second edited")]})), ..Default::default() }).unwrap();
    assert_eq!(database.bootstrap(None).unwrap().session.unwrap()["tabs"], json!([session_tab("one","first ünï"),session_tab("two","second edited")]));
}
