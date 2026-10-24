use notation_lib::{
    assets, explorer, git, mcp,
    search_graph::{GraphRequest, SearchRequest},
    storage::{Database, StateUpdate},
};
use serde_json::json;
use std::{fs, path::Path};

fn text(path: &Path) -> String {
    path.to_str().unwrap().into()
}
fn create(db: &Database, name: &str) -> String {
    db.create_workspace(name).unwrap().active_id.unwrap()
}

#[test]
fn named_references_share_content_across_disjoint_directories_and_persist_without_moving_files() {
    let temp = tempfile::tempdir().unwrap();
    let a = temp.path().join("a/Alpha.md");
    let b = temp.path().join("b/Beta.md");
    fs::create_dir(a.parent().unwrap()).unwrap();
    fs::create_dir(b.parent().unwrap()).unwrap();
    fs::write(&a, "# Alpha\n[[Beta]]").unwrap();
    fs::write(&b, "---\naliases: [Other]\n---\n# Beta\nshared nebula").unwrap();
    let path = temp.path().join("state/db.sqlite");
    let db = Database::open(&path).unwrap();
    assert_eq!(
        db.bootstrap(None).unwrap().workspace_catalog.active_id,
        None
    );
    let first = create(&db, "First");
    db.add_workspace_files(&first, &[text(&a), text(&b), text(&a)])
        .unwrap();
    assert_eq!(db.list_workspaces().unwrap().workspaces[0].files.len(), 2);
    let report = db.index_workspace().unwrap();
    assert_eq!(report.indexed, 2);
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    assert_eq!(
        db.resolve_wiki_link("Beta", Some(&text(&a))).unwrap().path,
        Some(text(&b))
    );
    assert_eq!(
        db.resolve_wiki_link("Other", Some(&text(&a))).unwrap().path,
        Some(text(&b))
    );
    assert_eq!(
        db.resolve_wiki_link("../b/Beta", Some(&text(&a)))
            .unwrap()
            .path,
        Some(text(&b))
    );
    let candidates = db.wiki_candidates("Bet", Some(&text(&a)), None).unwrap();
    assert_eq!(candidates.len(), 1);
    assert_eq!(
        db.resolve_wiki_link(&candidates[0].link, Some(&text(&a)))
            .unwrap()
            .path,
        Some(text(&b))
    );
    let graph = db.graph_workspace(GraphRequest::default()).unwrap();
    assert_eq!(graph.nodes.len(), 2);
    assert_eq!(graph.edges.len(), 1);
    assert_eq!(graph.root, first);
    assert_eq!(db.get_backlinks(&text(&b)).unwrap().len(), 1);
    let second = create(&db, "Second");
    assert!(db.search_workspace("", None).unwrap().is_empty());
    db.add_workspace_files(&second, &[text(&b)]).unwrap();
    assert_eq!(db.index_workspace().unwrap().indexed, 1);
    assert_eq!(db.search_workspace("Alpha", None).unwrap().len(), 0);
    assert_eq!(
        db.search_workspace_advanced(serde_json::from_value::<SearchRequest>(json!({})).unwrap())
            .unwrap()
            .total,
        1
    );
    assert!(explorer::read_workspace_file(&db, &text(&a)).is_err());
    assert_eq!(
        explorer::read_workspace_file(&db, &text(&b))
            .unwrap()
            .content,
        fs::read_to_string(&b).unwrap()
    );
    fs::write(&b, "changed shared content").unwrap();
    db.select_workspace(&first).unwrap();
    assert!(db.search_workspace("", None).unwrap().is_empty());
    assert_eq!(
        explorer::read_workspace_file(&db, &text(&b))
            .unwrap()
            .content,
        "changed shared content"
    );
    db.rename_workspace(&first, "Renamed").unwrap();
    let session = json!({"activeTabId":"","tabs":[],"activeWorkspaceId":first,"workspaceViews":{"arbitrary":{"scroll":12}},"future":{"preserve":true}});
    db.persist(StateUpdate {
        session: Some(session.clone()),
        ..Default::default()
    })
    .unwrap();
    let expected = db.list_workspaces().unwrap();
    drop(db);
    let db = Database::open(&path).unwrap();
    assert_eq!(db.list_workspaces().unwrap(), expected);
    assert_eq!(db.bootstrap(None).unwrap().session, Some(session));
    db.remove_workspace_file(&first, &text(&b)).unwrap();
    assert!(b.exists());
    assert_eq!(
        db.list_workspaces().unwrap().workspaces[1].files,
        vec![text(&b)]
    );
    let remaining = db.delete_workspace(&first).unwrap();
    assert_eq!(remaining.active_id, Some(second.clone()));
    assert!(a.exists() && b.exists());
    assert_eq!(db.delete_workspace(&second).unwrap().active_id, None);
    assert_eq!(fs::read_to_string(a).unwrap(), "# Alpha\n[[Beta]]");
    assert_eq!(fs::read_to_string(b).unwrap(), "changed shared content");
}

#[test]
fn references_enforce_membership_missing_files_and_symlink_boundaries() {
    let temp = tempfile::tempdir().unwrap();
    let a = temp.path().join("member.md");
    let outside = temp.path().join("sibling.md");
    fs::write(&a, "member").unwrap();
    fs::write(&outside, "secret").unwrap();
    let db = Database::open(&temp.path().join("app/db.sqlite")).unwrap();
    let id = create(&db, "References");
    assert!(db.create_workspace("  ").is_err());
    assert!(db.create_workspace(&"a".repeat(121)).is_err());
    assert!(db.select_workspace("missing").is_err());
    assert!(db.rename_workspace("missing", "name").is_err());
    assert!(db.delete_workspace("missing").is_err());
    assert!(db
        .add_workspace_files(&id, &[text(&a), text(&temp.path().join("absent.md"))])
        .is_err());
    assert!(db.list_workspaces().unwrap().workspaces[0].files.is_empty());
    assert!(db.add_workspace_files(&id, &[text(temp.path())]).is_err());
    db.add_workspace_files(&id, &[text(&a)]).unwrap();
    let listing = explorer::list_directory(&db, None).unwrap();
    assert_eq!(listing.entries.len(), 1);
    assert!(listing.parent.is_none());
    assert!(explorer::list_directory(&db, Some(temp.path().to_str().unwrap())).is_err());
    assert!(explorer::read_workspace_file(&db, &text(&outside)).is_err());
    assert!(db.wiki_candidates("", Some(&text(&outside)), None).is_err());
    assert!(assets::read(&db, &text(&outside), Some(&text(&a))).is_err());
    assert!(git::status(&db)
        .error
        .unwrap()
        .contains("Select a file/repository"));
    let bridge = mcp::AgentBridge::default();
    bridge.set_ready(true);
    let backend = mcp::Backend {
        database: Ok(db.clone()),
        bridge,
        emit: std::sync::Arc::new(|_| Ok(())),
    };
    assert!(backend.call("read_file", &json!({"path":outside})).is_err());
    assert!(backend
        .call("open_document", &json!({"path":outside}))
        .is_err());
    assert_eq!(
        backend.call("workspace_info", &json!({})).unwrap()["workspaceCatalog"]["activeId"],
        id
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        let link = temp.path().join("link.md");
        symlink(&outside, &link).unwrap();
        assert!(db.add_workspace_files(&id, &[text(&link)]).is_err());
        let dir = temp.path().join("link-dir");
        symlink(temp.path(), &dir).unwrap();
        assert!(db
            .add_workspace_files(&id, &[text(&dir.join("sibling.md"))])
            .is_err());
        fs::remove_file(&a).unwrap();
        symlink(&outside, &a).unwrap();
        assert!(explorer::read_workspace_file(&db, &text(&a)).is_err());
        let report = db.index_workspace().unwrap();
        assert_eq!(report.indexed, 0);
        assert!(!report.errors.is_empty());
        fs::remove_file(&a).unwrap();
    }
    #[cfg(not(unix))]
    fs::remove_file(&a).unwrap();
    let report = db.index_workspace().unwrap();
    assert_eq!(report.indexed, 0);
    assert!(!report.errors.is_empty());
    assert_eq!(
        db.list_workspaces().unwrap().workspaces[0].files,
        vec![text(&a)]
    );
    assert!(explorer::read_workspace_file(&db, &text(&a)).is_err());
    assert_eq!(
        explorer::list_directory(&db, None).unwrap().entries.len(),
        1
    );
    db.remove_workspace_file(&id, &text(&a)).unwrap();
    assert!(outside.exists());
}

#[test]
fn legacy_v5_selection_migrates_without_creating_the_root_and_set_workspace_remains_compatible() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("app/db.sqlite");
    let root = temp.path().join("missing-old-folder");
    let db = Database::open(&path).unwrap();
    drop(db);
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection.execute_batch("DROP TABLE workspace_members; DROP TABLE named_workspaces; DROP TABLE workspace_selection; PRAGMA user_version=5;").unwrap();
    connection
        .execute(
            "INSERT INTO workspaces(id,path) VALUES(1,?1)",
            [text(&root)],
        )
        .unwrap();
    drop(connection);
    let db = Database::open(&path).unwrap();
    assert!(!root.exists());
    let catalog = db.list_workspaces().unwrap();
    assert_eq!(catalog.workspaces.len(), 1);
    assert_eq!(catalog.workspaces[0].name, "missing-old-folder");
    assert_eq!(catalog.active_id, Some("legacy-1".into()));
    assert_eq!(catalog.workspaces[0].legacy_root, Some(text(&root)));
    assert!(db.index_workspace().is_err());
    fs::create_dir(&root).unwrap();
    fs::write(root.join("old.md"), "old note").unwrap();
    db.set_workspace(&text(&root)).unwrap();
    assert_eq!(db.list_workspaces().unwrap().workspaces.len(), 1);
    assert_eq!(db.index_workspace().unwrap().indexed, 1);
    create(&db, "Virtual");
    assert_eq!(db.workspace().unwrap(), None);
    db.set_workspace(&text(&root)).unwrap();
    assert_eq!(db.workspace().unwrap(), Some(text(&root)));
    assert_eq!(
        db.list_workspaces().unwrap().active_id,
        Some("legacy-1".into())
    );
    assert_eq!(
        explorer::read_workspace_file(&db, "old.md")
            .unwrap()
            .content,
        "old note"
    );
}

#[test]
fn virtual_wiki_creation_uses_explicit_or_source_location_and_never_clobbers() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("Source.md");
    fs::write(&source, "source").unwrap();
    let db = Database::open(&temp.path().join("app/db.sqlite")).unwrap();
    let id = create(&db, "Notes");
    db.add_workspace_files(&id, &[text(&source)]).unwrap();
    db.index_workspace().unwrap();
    assert!(db
        .resolve_wiki_link("No location", None)
        .unwrap()
        .create_path
        .is_none());
    assert!(db.create_wiki_note("No location", None, None).is_err());
    let created = db
        .create_wiki_note("New note", Some(&text(&source)), Some("# New"))
        .unwrap();
    assert_eq!(created.path, text(&temp.path().join("New note.md")));
    assert!(db.list_workspaces().unwrap().workspaces[0]
        .files
        .contains(&created.path));
    assert!(db
        .create_wiki_note("New note", Some(&text(&source)), Some("clobber"))
        .is_err());
    let explicit = text(&temp.path().join("Explicit.md"));
    assert_eq!(
        db.create_wiki_note(&explicit, None, Some("explicit"))
            .unwrap()
            .path,
        explicit
    );
    assert_eq!(fs::read_to_string(&created.path).unwrap(), "# New");
    let other = temp.path().join("other");
    fs::create_dir(&other).unwrap();
    let duplicate = other.join("New note.md");
    fs::write(&duplicate, "duplicate").unwrap();
    db.add_workspace_files(&id, &[text(&duplicate)]).unwrap();
    db.index_workspace().unwrap();
    assert_eq!(
        db.resolve_wiki_link("New note", None).unwrap().status,
        "ambiguous"
    );
}

#[test]
fn legacy_roots_and_explicit_outside_members_form_a_union_without_sibling_privileges() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("legacy");
    let other = temp.path().join("other");
    fs::create_dir(&root).unwrap();
    fs::create_dir(&other).unwrap();
    let source = root.join("Source.md");
    let member = other.join("Target.md");
    let sibling = other.join("Unlisted.md");
    fs::write(&source, "# Source\n[[Target]]").unwrap();
    fs::write(&member, "# Target").unwrap();
    fs::write(&sibling, "secret").unwrap();
    let media = other.join("image.png");
    fs::write(&media, b"\x89PNG\r\n\x1a\n").unwrap();
    let db = Database::open(&temp.path().join("app/db.sqlite")).unwrap();
    db.set_workspace(&text(&root)).unwrap();
    let id = db.list_workspaces().unwrap().active_id.unwrap();
    db.add_workspace_files(&id, &[text(&member), text(&media)])
        .unwrap();
    assert_eq!(db.index_workspace().unwrap().indexed, 2);
    assert_eq!(db.search_workspace("", None).unwrap().len(), 2);
    assert_eq!(
        explorer::list_directory(&db, None).unwrap().entries.len(),
        3
    );
    assert!(explorer::read_workspace_file(&db, &text(&member)).is_ok());
    assert!(explorer::read_workspace_file(&db, &text(&sibling)).is_err());
    assert_eq!(
        db.resolve_wiki_link("Target", Some(&text(&source)))
            .unwrap()
            .path,
        Some(text(&member))
    );
    assert_eq!(
        db.wiki_candidates("Target", Some(&text(&source)), None)
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        db.graph_workspace(GraphRequest::default())
            .unwrap()
            .edges
            .len(),
        1
    );
    assert!(assets::read(&db, "../other/image.png", Some(&text(&source))).is_ok());
    assert!(explorer::list_directory(&db, Some(other.to_str().unwrap())).is_err());
    db.remove_workspace_file(&id, &text(&member)).unwrap();
    assert_eq!(db.index_workspace().unwrap().indexed, 1);
    assert!(member.exists());
}

#[test]
fn virtual_folder_filter_is_only_a_prefix_over_member_paths_and_media_normalizes_safely() {
    let temp = tempfile::tempdir().unwrap();
    fs::create_dir(temp.path().join("notes")).unwrap();
    fs::create_dir(temp.path().join("refs")).unwrap();
    let a = temp.path().join("notes/Note.md");
    let b = temp.path().join("refs/Other.md");
    let media = temp.path().join("refs/image.png");
    fs::write(&a, "first").unwrap();
    fs::write(&b, "second").unwrap();
    fs::write(&media, b"\x89PNG\r\n\x1a\n").unwrap();
    let db = Database::open(&temp.path().join("app/db.sqlite")).unwrap();
    let id = create(&db, "Filter");
    db.add_workspace_files(&id, &[text(&a), text(&b), text(&media)])
        .unwrap();
    db.index_workspace().unwrap();
    let page = db
        .search_workspace_advanced(
            serde_json::from_value(json!({"folder":temp.path().join("refs")})).unwrap(),
        )
        .unwrap();
    assert_eq!(page.total, 1);
    assert_eq!(page.results[0].path, text(&b));
    assert_eq!(
        db.search_workspace_advanced(serde_json::from_value(json!({"folder":"/"})).unwrap())
            .unwrap()
            .total,
        2
    );
    assert_eq!(
        db.search_workspace_advanced(
            serde_json::from_value(json!({"folder":temp.path().join("missing")})).unwrap()
        )
        .unwrap()
        .total,
        0
    );
    assert!(assets::read(&db, "../refs/image.png", Some(&text(&a))).is_ok());
    #[cfg(unix)]
    {
        let link = temp.path().join("notes/link");
        std::os::unix::fs::symlink(temp.path(), &link).unwrap();
        assert!(assets::read(&db, "link/../../refs/image.png", Some(&text(&a))).is_err());
    }
}
