use notation_lib::{
    frontmatter,
    storage::{write_with_metadata, Database, StateUpdate},
    wiki::PropertyQuery,
};
use serde_json::json;
use std::fs;
use std::path::Path;
use std::time::{Duration, Instant};
fn setup(directory: &Path) -> (Database, std::path::PathBuf) {
    let root = directory.join("notes");
    fs::create_dir_all(&root).unwrap();
    let database = Database::open(&directory.join("app/state.sqlite3")).unwrap();
    database.set_workspace(root.to_str().unwrap()).unwrap();
    (database, root)
}

#[test]
fn parses_typed_flexible_yaml_without_touching_comments_unknown_fields_or_dates() {
    let source="\u{feff}---\r\n# retained comment\r\ntitle: 'A: note'\r\narchived: false\r\ncapital: TRUE\r\nquoted: 'false'\r\nyesWord: yes\r\ncreated: 2026-10-12\r\ncount: 12\r\nratio: 1.5\r\ncustom:\r\n  nested: [one, 2, true, null]\r\ntags: [project, 'two words']\r\naliases:\r\n  - Short name\r\n...\r\n# Body 日本語\r\n";
    let parsed = frontmatter::parse(source);
    assert!(parsed.present && parsed.closed, "{:?}", parsed.error);
    assert!(parsed.error.is_none(), "{:?}", parsed.error);
    assert_eq!(parsed.properties["archived"], false);
    assert_eq!(parsed.properties["capital"], true);
    assert_eq!(parsed.properties["quoted"], "false");
    assert_eq!(parsed.properties["yesWord"], "yes");
    assert_eq!(parsed.properties["created"], "2026-10-12");
    assert_eq!(parsed.properties["count"], 12);
    assert_eq!(parsed.properties["ratio"], 1.5);
    assert_eq!(
        parsed.properties["custom"]["nested"],
        json!(["one", 2, true, null])
    );
    let offset = source[..source.find("# Body").unwrap()]
        .encode_utf16()
        .count();
    assert_eq!(parsed.body_offset, offset);
    assert!(source.contains("# retained comment\r\n"));
    assert!(!frontmatter::parse("```yaml\n---\nfoo: bar\n---\n```").present);
}

#[test]
fn yaml_errors_are_located_and_depth_alias_expansion_are_bounded() {
    for source in [
        "---\nfoo: [one\n---\nBody",
        "---\nfoo: 1\nfoo: 2\n---\nBody",
        "---\n- list root\n---\nBody",
    ] {
        let result = frontmatter::parse(source);
        assert!(result.error.is_some());
        assert!(result.error.unwrap().line.unwrap_or(2) >= 2);
        assert!(result.properties.as_object().unwrap().is_empty());
    }
    let unclosed = frontmatter::parse("---\nfoo: bar\n# still Markdown\n");
    assert!(unclosed.present && !unclosed.closed);
    assert_eq!(unclosed.body_offset, 0);
    assert!(unclosed.error.is_some());
    let aliases = format!(
        "---\na: &anchor [one]\nvalues: [{}]\n---\n",
        std::iter::repeat_n("*anchor", 101)
            .collect::<Vec<_>>()
            .join(",")
    );
    let began = Instant::now();
    assert!(frontmatter::parse(&aliases).error.is_some());
    let deep = format!("---\nvalue: {}0{}\n---\n", "[".repeat(70), "]".repeat(70));
    assert!(frontmatter::parse(&deep).error.is_some());
    assert!(began.elapsed() < Duration::from_secs(2));
}

#[test]
fn indexed_yaml_properties_are_typed_queryable_and_errors_do_not_discard_notes() {
    let temporary = tempfile::tempdir().unwrap();
    let (database, root) = setup(temporary.path());
    fs::write(root.join("typed.md"),"---\ntitle: Typed title\narchived: false\ncreated: 2026-10-12\nnested: {number: 3, words: [a, b]}\ntags:\n - alpha\n - '#beta'\naliases: [Shortcut]\n---\n# Body\n").unwrap();
    fs::write(
        root.join("string.md"),
        "---\narchived: 'false'\n---\n# String\n",
    )
    .unwrap();
    fs::write(
        root.join("bad.md"),
        "---\nfoo: [broken\n---\n# Bad but searchable\n",
    )
    .unwrap();
    let report = database.index_workspace().unwrap();
    assert_eq!(report.indexed, 3);
    assert!(report.errors.iter().any(|error| error.contains("YAML")));
    let metadata = database.get_frontmatter(None).unwrap();
    assert_eq!(metadata.len(), 3);
    assert!(metadata
        .iter()
        .any(|note| note.path.ends_with("bad.md") && note.error.is_some()));
    let selected = database
        .query_properties(PropertyQuery {
            key: "archived".into(),
            value: Some(json!(false)),
            limit: None,
        })
        .unwrap();
    assert_eq!(selected.len(), 1);
    assert_eq!(selected[0].properties["created"], "2026-10-12");
    assert_eq!(
        database
            .query_properties(PropertyQuery {
                key: "archived".into(),
                value: Some(json!("false")),
                limit: None
            })
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        database
            .query_properties(PropertyQuery {
                key: "nested".into(),
                value: Some(json!({"number":3,"words":["a","b"]})),
                limit: None
            })
            .unwrap()
            .len(),
        1
    );
    let tags = database.get_tags().unwrap();
    assert_eq!(
        tags.iter().map(|tag| tag.tag.as_str()).collect::<Vec<_>>(),
        ["alpha", "beta"]
    );
    assert_eq!(
        database.search_workspace("Typed", None).unwrap()[0].title,
        "Typed title"
    );
}

#[test]
fn wiki_resolution_prefers_current_folder_then_unique_match_and_never_guesses_ambiguity() {
    let temporary = tempfile::tempdir().unwrap();
    let (database, root) = setup(temporary.path());
    for folder in ["a", "b", "source"] {
        fs::create_dir(root.join(folder)).unwrap();
    }
    let source = root.join("source/Current.md");
    fs::write(&source, "# Current\n").unwrap();
    fs::write(
        root.join("a/Note.md"),
        "---\naliases: [Shortcut]\n---\n# Note\n## Section one\n",
    )
    .unwrap();
    fs::write(root.join("b/Note.md"), "# Other note\n").unwrap();
    fs::write(root.join("Foo.md"), "# Foo\n").unwrap();
    fs::write(root.join("foo.md"), "# foo\n").unwrap();
    database.index_workspace().unwrap();
    let from = source.to_str();
    let ambiguous = database.resolve_wiki_link("Note", from).unwrap();
    assert_eq!(ambiguous.status, "ambiguous");
    assert_eq!(ambiguous.candidates.len(), 2);
    assert!(ambiguous.path.is_none());
    assert!(ambiguous.create_path.is_none());
    let alias = database
        .resolve_wiki_link("Shortcut#Section one|Custom label", from)
        .unwrap();
    assert_eq!(alias.status, "resolved");
    assert_eq!(alias.heading.as_deref(), Some("Section one"));
    assert_eq!(alias.alias.as_deref(), Some("Custom label"));
    assert!(alias.path.unwrap().ends_with("a/Note.md"));
    assert_eq!(alias.candidates[0].headings[1].line, 5);
    let rooted = database.resolve_wiki_link("a/Note", from).unwrap();
    assert_eq!(rooted.status, "resolved");
    write_with_metadata(
        root.join("source/Note.md").to_str().unwrap(),
        "# Local Note\n",
        &Ok(database.clone()),
    )
    .unwrap();
    let local = database.resolve_wiki_link("Note", from).unwrap();
    assert_eq!(local.status, "resolved");
    assert!(local.path.unwrap().ends_with("source/Note.md"));
    assert!(database
        .resolve_wiki_link("Foo", from)
        .unwrap()
        .path
        .unwrap()
        .ends_with("Foo.md"));
    assert!(database
        .resolve_wiki_link("foo", from)
        .unwrap()
        .path
        .unwrap()
        .ends_with("foo.md"));
    assert_eq!(
        database.resolve_wiki_link("FOO", from).unwrap().status,
        "missing"
    );
    let completions = database.wiki_candidates("fOo", from, None).unwrap();
    assert_eq!(completions.len(), 2);
    assert_eq!(
        database
            .wiki_candidates("Shortcut#Section", from, None)
            .unwrap()[0]
            .headings
            .len(),
        1
    );
}

#[test]
fn explicit_creation_is_current_folder_atomic_no_clobber_and_refreshes_backlinks() {
    let temporary = tempfile::tempdir().unwrap();
    let (database, root) = setup(temporary.path());
    fs::create_dir(root.join("folder")).unwrap();
    let source = root.join("folder/Source.md");
    fs::write(&source, "# Source\n[[New Note]]\n").unwrap();
    database.index_workspace().unwrap();
    let target = root.join("folder/New Note.md");
    let missing = database
        .resolve_wiki_link("New Note", source.to_str())
        .unwrap();
    assert_eq!(missing.status, "missing");
    assert_eq!(missing.create_path.as_deref(), target.to_str());
    assert!(!target.exists());
    let result = database
        .create_wiki_note(
            "New Note#Start|label",
            source.to_str(),
            Some("# New Note\n\noriginal\n"),
        )
        .unwrap();
    assert_eq!(result.path, target.to_str().unwrap());
    assert_eq!(
        fs::read_to_string(&target).unwrap(),
        "# New Note\n\noriginal\n"
    );
    assert_eq!(
        database
            .get_backlinks(target.to_str().unwrap())
            .unwrap()
            .len(),
        1
    );
    assert!(database
        .create_wiki_note("New Note", source.to_str(), Some("overwrite"))
        .is_err());
    assert!(fs::read_to_string(&target).unwrap().contains("original"));
    assert_eq!(
        database
            .list_revisions(target.to_str().unwrap())
            .unwrap()
            .len(),
        1
    );
    let one = database.clone();
    let two = database.clone();
    let from = source.to_string_lossy().into_owned();
    let from_two = from.clone();
    let first =
        std::thread::spawn(move || one.create_wiki_note("Race", Some(&from), Some("first")));
    let second =
        std::thread::spawn(move || two.create_wiki_note("Race", Some(&from_two), Some("second")));
    let results = [first.join().unwrap(), second.join().unwrap()];
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    let saved = fs::read_to_string(root.join("folder/Race.md")).unwrap();
    assert!(saved == "first" || saved == "second");
}

#[test]
fn wiki_creation_and_lookup_reject_escape_symlinks_and_missing_workspace_or_parent() {
    let temporary = tempfile::tempdir().unwrap();
    let (database, root) = setup(temporary.path());
    fs::write(root.join("Source.md"), "# Source").unwrap();
    let from = root.join("Source.md");
    assert!(database
        .create_wiki_note("../../outside", from.to_str(), None)
        .is_err());
    assert!(database
        .resolve_wiki_link("../../outside", from.to_str())
        .is_err());
    assert!(database
        .create_wiki_note("missing/folder/Note", from.to_str(), None)
        .is_err());
    assert!(!root.join("missing").exists());
    assert!(database
        .create_wiki_note(".private", from.to_str(), None)
        .is_err());
    let standalone = Database::open(&temporary.path().join("other/state.sqlite3")).unwrap();
    assert!(standalone.resolve_wiki_link("Note", None).is_err());
    assert!(standalone.create_wiki_note("Note", None, None).is_err());
    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        let outside = temporary.path().join("outside");
        fs::create_dir(&outside).unwrap();
        symlink(&outside, root.join("escape")).unwrap();
        symlink(outside.join("not-created.md"), root.join("dangling.md")).unwrap();
        assert!(database
            .create_wiki_note("escape/Note", from.to_str(), None)
            .is_err());
        assert!(database
            .create_wiki_note("dangling", from.to_str(), None)
            .is_err());
        assert!(fs::read_dir(&outside).unwrap().next().is_none());
    }
}

#[test]
fn app_saves_refresh_typed_metadata_and_wiki_backlinks_without_touching_appstate() {
    let temporary = tempfile::tempdir().unwrap();
    let (database, root) = setup(temporary.path());
    let target = root.join("Target.md");
    fs::write(&target, "# Target\n").unwrap();
    let source = root.join("Source.md");
    fs::write(&source, "---\ntags: [old]\n---\n# Source\n").unwrap();
    database
        .persist(StateUpdate {
            settings: Some(json!({"theme":"light"})),
            draft: Some(
                json!({"id":"draft","name":"unsaved.md","path":null,"content":"untouched draft"}),
            ),
            ..Default::default()
        })
        .unwrap();
    database.index_workspace().unwrap();
    assert!(database
        .get_backlinks(target.to_str().unwrap())
        .unwrap()
        .is_empty());
    let result = write_with_metadata(
        source.to_str().unwrap(),
        "---\ntags: [new]\narchived: true\n---\n# Source\n[[Target]]\n",
        &Ok(database.clone()),
    )
    .unwrap();
    assert!(result.warning.is_none(), "{:?}", result.warning);
    assert_eq!(
        database
            .get_backlinks(target.to_str().unwrap())
            .unwrap()
            .len(),
        1
    );
    assert_eq!(database.get_tags().unwrap()[0].tag, "new");
    assert_eq!(
        database.get_frontmatter(source.to_str()).unwrap()[0].properties["archived"],
        true
    );
    let state = database.bootstrap(None).unwrap();
    assert_eq!(state.settings["theme"], "light");
    assert_eq!(state.draft.unwrap()["content"], "untouched draft");
    assert_eq!(
        database
            .list_revisions(source.to_str().unwrap())
            .unwrap()
            .len(),
        2
    );
}

#[test]
fn wiki_index_ignores_escaped_code_math_and_closed_yaml_but_keeps_unclosed_markdown() {
    let temporary = tempfile::tempdir().unwrap();
    let (database, root) = setup(temporary.path());
    let target = root.join("Target.md");
    fs::write(&target, "# Target\n").unwrap();
    fs::write(root.join("Source.md"),"---\ncustom: '[[Target]]'\n---\n# Source\n\\[[Target]]\n`[[Target]]`\n```md\n[[Target]]\n```\n$[[Target]]$\n[[Target|actual]]\n").unwrap();
    fs::write(
        root.join("Unclosed.md"),
        "---\n# Regular Markdown\n[[Target]]\n",
    )
    .unwrap();
    database.index_workspace().unwrap();
    let links = database.get_backlinks(target.to_str().unwrap()).unwrap();
    assert_eq!(links.len(), 2);
    assert!(links.iter().any(|link| link.path.ends_with("Unclosed.md")));
    assert_eq!(
        notation_lib::wiki::parse_target(r"Name\#part#Heading\|part|Shown\|alias")
            .unwrap()
            .note,
        "Name#part"
    );
}
