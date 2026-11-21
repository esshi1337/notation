//! Single-note index updates must leave exactly what a full rebuild leaves.
use notation_lib::storage::{write_with_metadata, Database};
use std::fs;
use std::path::{Path, PathBuf};

const TABLES: [&str; 10] = [
    "cache_files",
    "cache_fts",
    "cache_frontmatter",
    "cache_properties",
    "cache_headings",
    "cache_blocks",
    "cache_graph_links",
    "cache_links",
    "cache_tags",
    "cache_tasks",
];

fn setup(directory: &Path) -> (Database, PathBuf) {
    let root = directory.join("notes");
    fs::create_dir_all(root.join("a")).unwrap();
    fs::create_dir_all(root.join("b")).unwrap();
    let database = Database::open(&directory.join("app/state.sqlite3")).unwrap();
    database.set_workspace(root.to_str().unwrap()).unwrap();
    (database, root)
}

fn seed(root: &Path) {
    for index in 0..12 {
        let folder = ["", "a", "b"][index % 3];
        let body = format!(
            "---\ntitle: Note {index}\naliases: [alias{index}, shared]\nrank: {index}\n---\n# Note {index}\n\n[[note{next}]] [[alias{other}]] [doc](../a/note1.md) [[missing]] [[shared]] #tag{index} #common\n\n## Section\n- [ ] open task {index}\n- [x] done task {index}\n\nA block of text ^block{index}\n",
            next = (index + 1) % 12,
            other = (index + 5) % 12,
        );
        fs::write(root.join(folder).join(format!("note{index}.md")), body).unwrap();
    }
    fs::write(root.join("a/Same.md"), "# Same in a\n").unwrap();
    fs::write(root.join("b/Same.md"), "# Same in b\n[[Same]]\n").unwrap();
    fs::write(root.join("diagram.mmd"), "flowchart LR\n  A --> B\n").unwrap();
}

/// Every cache table as sorted rows. Row order inside a table is not part of
/// the comparison. `scan_order` also compares the note order of `cache_files`
/// and, with it, the candidate order of ambiguous links. A rebuild takes that
/// order from the directory listing, which an atomic save (write a temporary
/// file, rename it over the note) may reshuffle, so it is only comparable
/// when the test rewrites notes in place.
fn dump(database: &Database, scan_order: bool) -> Vec<(String, Vec<String>)> {
    let connection = rusqlite::Connection::open(&database.path).unwrap();
    let mut tables = Vec::new();
    for table in TABLES {
        let columns = if table == "cache_fts" { "path,title,body" } else { "*" };
        let mut statement = connection
            .prepare(&format!("SELECT {columns} FROM {table}"))
            .unwrap();
        let width = statement.column_count();
        let mut rows = statement
            .query_map([], |row| {
                Ok((0..width)
                    .map(|index| match row.get_ref(index).unwrap() {
                        rusqlite::types::ValueRef::Text(text) => {
                            let text = String::from_utf8_lossy(text).into_owned();
                            if !scan_order && table == "cache_graph_links" && index == 6 {
                                let mut candidates: Vec<String> = serde_json::from_str(&text).unwrap();
                                candidates.sort();
                                serde_json::to_string(&candidates).unwrap()
                            } else {
                                text
                            }
                        }
                        other => format!("{other:?}"),
                    })
                    .collect::<Vec<_>>()
                    .join(" | "))
            })
            .unwrap()
            .map(Result::unwrap)
            .collect::<Vec<_>>();
        rows.sort();
        tables.push((table.to_string(), rows));
    }
    if scan_order {
        let mut statement = connection
            .prepare("SELECT path FROM cache_files ORDER BY rowid")
            .unwrap();
        let order = statement
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        tables.push(("cache_files order".into(), order));
    }
    tables
}

fn assert_matches_full_rebuild(database: &Database, context: &str, scan_order: bool) {
    let incremental = dump(database, scan_order);
    let report = database.index_workspace().unwrap();
    assert!(report.errors.is_empty(), "{context}: {:?}", report.errors);
    let rebuilt = dump(database, scan_order);
    for ((table, left), (_, right)) in incremental.iter().zip(&rebuilt) {
        let only_incremental = left.iter().filter(|row| !right.contains(row)).collect::<Vec<_>>();
        let only_rebuilt = right.iter().filter(|row| !left.contains(row)).collect::<Vec<_>>();
        assert!(
            left == right,
            "{context}: {table} differs from a full rebuild\nonly after the single-note update: {only_incremental:#?}\nonly after the rebuild: {only_rebuilt:#?}"
        );
    }
}

fn text(path: &Path) -> String {
    path.to_str().unwrap().to_string()
}

#[test]
fn body_edits_update_one_note_and_match_a_full_rebuild() {
    let temporary = tempfile::tempdir().unwrap();
    let (database, root) = setup(temporary.path());
    seed(&root);
    assert!(database.index_workspace().unwrap().errors.is_empty());
    let note = root.join("a/note4.md");
    let edits = [
        // Different links, tags, tasks, headings and block ids.
        "---\ntitle: Note 4\naliases: [alias4, shared]\nrank: 4\n---\n# Renamed heading\n\n[[note7]] [[b/Same]] [[Same]] [text](../note0.md#Section) #newtag\n\n- [x] replaced task\n\nOther block ^other\n".to_string(),
        // Changed title and properties, same aliases in another notation.
        "---\ntitle: A new title\naliases:\n  - shared\n  - alias4\nstatus: draft\ncount: 3\n---\nNo headings, [[alias9]] and [[missing-too]]\n".to_string(),
        // Emptied body.
        "---\naliases: [alias4, shared]\n---\n".to_string(),
        // Dense note.
        format!(
            "---\naliases: [alias4, shared]\n---\n{}",
            (0..200)
                .map(|index| format!("## H{index}\n[[note{}]] #t{index} ^b{index}\n- [ ] task {index}\n", index % 12))
                .collect::<String>()
        ),
    ];
    for (index, content) in edits.iter().enumerate() {
        fs::write(&note, content).unwrap();
        let report = database
            .index_saved_file(&text(&note), content)
            .unwrap()
            .unwrap_or_else(|| panic!("edit {index} should update in place"));
        assert_eq!((report.files, report.indexed, report.skipped), (15, 15, 0));
        assert!(report.errors.is_empty());
        assert_matches_full_rebuild(&database, &format!("edit {index}"), true);
    }
    // A standalone diagram file keeps empty metadata either way.
    let diagram = root.join("diagram.mmd");
    fs::write(&diagram, "flowchart TD\n  X --> Y\n[[note1]] #not-a-tag\n").unwrap();
    assert!(database
        .index_saved_file(&text(&diagram), &fs::read_to_string(&diagram).unwrap())
        .unwrap()
        .is_some());
    assert_matches_full_rebuild(&database, "diagram", true);
}

#[test]
fn saves_through_the_document_path_stay_equivalent_and_searchable() {
    let temporary = tempfile::tempdir().unwrap();
    let (database, root) = setup(temporary.path());
    seed(&root);
    database.index_workspace().unwrap();
    let note = root.join("note0.md");
    let content = "---\ntitle: Note 0\naliases: [alias0, shared]\n---\n# Zero\n[[note3]] unmistakablezebra #stripes\n- [ ] feed the zebra\n";
    let saved = write_with_metadata(&text(&note), content, &Ok(database.clone())).unwrap();
    assert!(saved.warning.is_none(), "{:?}", saved.warning);
    assert_eq!(database.search_workspace("unmistakablezebra", Some(5)).unwrap()[0].path, text(&note));
    assert!(database.get_tags().unwrap().iter().any(|tag| tag.tag == "stripes"));
    assert!(database.get_tasks(None).unwrap().iter().any(|task| task.text == "feed the zebra"));
    assert_eq!(
        database.get_backlinks(&text(&root.join("note3.md"))).unwrap().iter().filter(|link| link.path == text(&note)).count(),
        1
    );
    assert_matches_full_rebuild(&database, "document save", false);
}

#[test]
fn changes_other_notes_depend_on_fall_back_to_a_full_rebuild() {
    let temporary = tempfile::tempdir().unwrap();
    let (database, root) = setup(temporary.path());
    seed(&root);
    database.index_workspace().unwrap();
    let saved = |path: &Path, content: &str| {
        fs::write(path, content).unwrap();
        database.index_saved_file(&text(path), content).unwrap().is_some()
    };
    // A changed alias set can change how other notes' links resolve.
    assert!(!saved(&root.join("note0.md"), "---\naliases: [fresh]\n---\n# Zero\n"));
    // A note the index has not seen.
    assert!(!saved(&root.join("brand-new.md"), "# New\n"));
    // A YAML error must be reported exactly as a rebuild reports it.
    assert!(!saved(&root.join("note1.md"), "---\naliases: [alias1, shared\n---\n# Broken\n"));
    // Each of those saves still indexes correctly through the document path.
    let renamed = "---\naliases: [fresh]\n---\n# Zero\n[[note2]]\n";
    let document = write_with_metadata(&text(&root.join("note0.md")), renamed, &Ok(database.clone())).unwrap();
    assert!(document.warning.as_deref().is_some_and(|warning| warning.contains("YAML")), "{:?}", document.warning);
    assert_eq!(database.resolve_wiki_link("fresh", Some(&text(&root.join("note2.md")))).unwrap().status, "resolved");
    assert_eq!(database.resolve_wiki_link("alias0", Some(&text(&root.join("note2.md")))).unwrap().status, "missing");
    // While a note has a YAML error the rebuild's warning is kept on every
    // save, and a note whose previous version had the error is rebuilt.
    let body = "---\naliases: [alias5, shared]\n---\n# Five\nedited\n";
    let document = write_with_metadata(&text(&root.join("b/note5.md")), body, &Ok(database.clone())).unwrap();
    assert!(document.warning.as_deref().is_some_and(|warning| warning.contains("note1.md")), "{:?}", document.warning);
    assert!(!saved(&root.join("note1.md"), "---\naliases: [alias1, shared]\n---\n# Fixed\n"));
    let fixed = write_with_metadata(&text(&root.join("note1.md")), "---\naliases: [alias1, shared]\n---\n# Fixed\n", &Ok(database.clone())).unwrap();
    assert!(fixed.warning.is_none(), "{:?}", fixed.warning);
    assert!(saved(&root.join("b/note5.md"), body));
    assert_matches_full_rebuild(&database, "after fallbacks", false);
}

#[test]
fn an_incomplete_or_foreign_baseline_is_never_built_on() {
    let temporary = tempfile::tempdir().unwrap();
    let (database, root) = setup(temporary.path());
    seed(&root);
    let note = root.join("note0.md");
    let content = "---\naliases: [alias0, shared]\n---\n# Zero\n";
    fs::write(&note, content).unwrap();
    // No index yet.
    assert!(database.index_saved_file(&text(&note), content).unwrap().is_none());
    // A rebuild that skipped something (a symbolic link) is not a baseline.
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&note, root.join("link.md")).unwrap();
        let report = database.index_workspace().unwrap();
        assert_eq!(report.skipped, 1);
        assert!(database.index_saved_file(&text(&note), content).unwrap().is_none());
        fs::remove_file(root.join("link.md")).unwrap();
    }
    database.index_workspace().unwrap();
    assert!(database.index_saved_file(&text(&note), content).unwrap().is_some());
    // Selecting another workspace empties the index and its baseline.
    let other = temporary.path().join("other");
    fs::create_dir_all(&other).unwrap();
    database.set_workspace(other.to_str().unwrap()).unwrap();
    assert!(database.index_saved_file(&text(&note), content).unwrap().is_none());
    database.set_workspace(root.to_str().unwrap()).unwrap();
    assert!(database.index_saved_file(&text(&note), content).unwrap().is_none());
    database.index_workspace().unwrap();
    assert!(database.index_saved_file(&text(&note), content).unwrap().is_some());
    // Oversized content is left to the rebuild, which skips it with an error.
    let huge = "x".repeat(4 * 1024 * 1024 + 1);
    assert!(database.index_saved_file(&text(&note), &huge).unwrap().is_none());
}

#[test]
fn a_full_rebuild_does_not_leave_an_index_sized_write_ahead_log() {
    let temporary = tempfile::tempdir().unwrap();
    let (database, root) = setup(temporary.path());
    // About 4 MiB of notes: the rebuild writes well over the log size limit.
    let filler = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(350);
    for index in 0..200 {
        fs::write(root.join(format!("big{index}.md")), format!("# Big {index}\n[[big{}]] #tag{index}\n{filler}\n", (index + 1) % 200)).unwrap();
    }
    let wal = database.path.with_extension("sqlite3-wal");
    for _ in 0..2 {
        assert_eq!(database.index_workspace().unwrap().indexed, 200);
        let size = fs::metadata(&wal).map(|metadata| metadata.len()).unwrap_or(0);
        assert!(size <= 4 * 1024 * 1024, "write-ahead log is {size} bytes after a rebuild");
    }
    let connection = rusqlite::Connection::open(&database.path).unwrap();
    // The limit is per connection; the application sets it when it opens.
    drop(connection);
    assert!(fs::metadata(&database.path).unwrap().len() > 4 * 1024 * 1024);
    // The index is intact after the checkpoint.
    assert_eq!(database.search_workspace("Lorem", Some(5)).unwrap().len(), 5);
}
