use notation_lib::automation::{ScriptDocument, ScriptRequest, ScriptResponse};
use notation_lib::storage::{Database, LegacyState, ScriptInput, StateUpdate};
use serde_json::{json, Value};
use std::fs;

fn draft(content: &str) -> Value {
    json!({"id":"draft-1","content":content,"name":"draft.md","path":null,"savedContent":"","savedName":"draft.md"})
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
        .execute_batch("DROP TABLE sessions; DROP TABLE cache_blocks; DROP TABLE cache_graph_links; DROP TABLE cache_frontmatter; DROP TABLE cache_properties; DROP TABLE cache_headings; PRAGMA user_version=2;")
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
