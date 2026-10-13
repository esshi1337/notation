use notation_lib::{
    search_graph::{GraphRequest, SearchRequest},
    storage::{write_with_metadata, Database, StateUpdate},
};
use serde_json::json;
use std::{fs, path::Path};
fn setup(directory: &Path) -> (Database, std::path::PathBuf) {
    let root = directory.join("notes");
    fs::create_dir_all(root.join("folder")).unwrap();
    let database = Database::open(&directory.join("app/state.sqlite3")).unwrap();
    database.set_workspace(root.to_str().unwrap()).unwrap();
    (database, root)
}
fn request(value: serde_json::Value) -> SearchRequest {
    serde_json::from_value(value).unwrap()
}
fn seed(root: &Path) {
    fs::write(root.join("folder/Alpha.md"),"---\ntitle: Alpha\npriority: 2\narchived: false\nowner: Anna\nstatus: active\ncreated: 2026-01-02\npeople: [Anna, Bob]\nnested: {ready: true}\noptional: null\ntags: [project, work]\n---\n# Alpha\nUnique nebula content. #focus\n").unwrap();
    fs::write(root.join("folder/Beta.md"),"---\ntitle: Beta\npriority: 10\narchived: true\nowner: Bob\nstatus: paused\ncreated: 2025-01-01\npeople: [Bob]\ntags: [project]\n---\n# Beta\nNebula content.\n").unwrap();
    fs::write(root.join("Gamma.md"),"---\npriority: '20'\narchived: 'false'\nowner: Annabelle\ntags: [personal]\n---\n# Gamma\nNebula content.\n").unwrap();
    fs::write(root.join("Delta.md"), "# Delta\nNebula.\n").unwrap();
}
#[test]
fn combines_full_text_folder_tags_and_typed_property_filters() {
    let temporary = tempfile::tempdir().unwrap();
    let (database, root) = setup(temporary.path());
    seed(&root);
    database.index_workspace().unwrap();
    let page=database.search_workspace_advanced(request(json!({"text":"nebu","folder":"folder","tags":["#project","focus"],"tagMode":"all","properties":[{"key":"archived","op":"eq","value":false},{"key":"priority","op":"gte","value":2}]}))).unwrap();
    assert_eq!(page.total, 1);
    assert!(page.results[0].path.ends_with("Alpha.md"));
    assert_eq!(page.results[0].properties["priority"], 2);
    assert!(page.results[0].tags.contains(&"focus".to_string()));
    assert_eq!(
        database
            .search_workspace_advanced(request(
                json!({"tags":["focus","personal"],"tagMode":"any"})
            ))
            .unwrap()
            .total,
        2
    );
    assert_eq!(
        database
            .search_workspace_advanced(request(
                json!({"properties":[{"key":"archived","value":"false"}]})
            ))
            .unwrap()
            .results[0]
            .name,
        "Gamma.md"
    );
    assert_eq!(
        database
            .search_workspace_advanced(request(
                json!({"properties":[{"key":"priority","op":"gt","value":3}]})
            ))
            .unwrap()
            .results[0]
            .name,
        "Beta.md"
    );
    assert_eq!(
        database
            .search_workspace_advanced(request(
                json!({"properties":[{"key":"priority","op":"eq","value":2.0}]})
            ))
            .unwrap()
            .total,
        1
    );
    assert_eq!(
        database
            .search_workspace_advanced(request(
                json!({"properties":[{"key":"owner","op":"contains","value":"Anna"}]})
            ))
            .unwrap()
            .total,
        2
    );
    assert_eq!(
        database
            .search_workspace_advanced(request(
                json!({"properties":[{"key":"people","op":"contains","value":"Anna"}]})
            ))
            .unwrap()
            .total,
        1
    );
    assert_eq!(
        database
            .search_workspace_advanced(request(
                json!({"properties":[{"key":"optional","value":null}]})
            ))
            .unwrap()
            .total,
        1
    );
    assert_eq!(
        database
            .search_workspace_advanced(request(
                json!({"properties":[{"key":"nested","value":{"ready":true}}]})
            ))
            .unwrap()
            .total,
        1
    );
    assert_eq!(
        database
            .search_workspace_advanced(request(
                json!({"properties":[{"key":"archived","op":"ne","value":false}]})
            ))
            .unwrap()
            .total,
        2
    );
    assert_eq!(
        database
            .search_workspace_advanced(request(
                json!({"properties":[{"key":"created","op":"gt","value":"2026-01-01"}]})
            ))
            .unwrap()
            .total,
        1
    );
    assert_eq!(
        database
            .search_workspace_advanced(request(json!({"text":"Alpha.md"})))
            .unwrap()
            .total,
        1
    );
    assert_eq!(
        database
            .search_workspace_advanced(request(json!({"text":"Annabelle"})))
            .unwrap()
            .total,
        1
    );
}
#[test]
fn metadata_sort_is_typed_stable_before_pagination_and_missing_values_stay_last() {
    let temporary = tempfile::tempdir().unwrap();
    let (database, root) = setup(temporary.path());
    seed(&root);
    fs::write(root.join("Null.md"), "---\npriority: null\n---\n# Null\n").unwrap();
    database.index_workspace().unwrap();
    let page = database
        .search_workspace_advanced(request(
            json!({"sortProperty":"priority","descending":true,"limit":2}),
        ))
        .unwrap();
    assert_eq!(
        page.results
            .iter()
            .map(|row| row.name.as_str())
            .collect::<Vec<_>>(),
        ["Beta.md", "Alpha.md"]
    );
    assert_eq!(page.total, 5);
    assert!(page.has_more);
    assert_eq!(page.next_offset, 2);
    let next = database
        .search_workspace_advanced(request(
            json!({"sortProperty":"priority","descending":true,"offset":2,"limit":3}),
        ))
        .unwrap();
    assert_eq!(
        next.results
            .iter()
            .map(|row| row.name.as_str())
            .collect::<Vec<_>>(),
        ["Gamma.md", "Null.md", "Delta.md"]
    );
    assert!(!next.has_more);
    let exists = database
        .search_workspace_advanced(request(
            json!({"properties":[{"key":"priority","op":"exists"}],"sort":"path"}),
        ))
        .unwrap();
    assert_eq!(exists.total, 4);
    assert!(database
        .search_workspace_advanced(request(
            json!({"properties":[{"key":"priority","op":"gt","value":true}]})
        ))
        .is_err());
    assert!(database
        .search_workspace_advanced(request(json!({"folder":"../app"})))
        .is_err());
    assert!(database
        .search_workspace_advanced(request(
            json!({"properties":[{"key":"owner","op":"contains"}]})
        ))
        .is_err());
    assert!(database
        .search_workspace_advanced(request(json!({"text":"\" OR *"})))
        .is_ok());
}
#[test]
fn graph_resolves_alias_headings_blocks_and_reports_ambiguity_missing_without_external_nodes() {
    let temporary = tempfile::tempdir().unwrap();
    let (database, root) = setup(temporary.path());
    for directory in ["a", "b"] {
        fs::create_dir(root.join(directory)).unwrap();
    }
    fs::write(
        root.join("Target.md"),
        "---\naliases: [Shortcut]\ntags: [hub]\n---\n# Target\n## Section\nA block. ^one\n",
    )
    .unwrap();
    fs::write(root.join("a/Same.md"), "# A\n").unwrap();
    fs::write(root.join("b/Same.md"), "# B\n").unwrap();
    fs::write(root.join("Source.md"),"# Source\n[[Shortcut#Section|Label]]\n![[Target#^one]]\n[Target](Target.md#Section)\n[[Same]]\n[[Missing]]\n[[../../outside]]\n[Outside](../../outside.md)\n[Web](https://example.com/)\n").unwrap();
    database.index_workspace().unwrap();
    let graph = database.graph_workspace(GraphRequest::default()).unwrap();
    assert_eq!(graph.nodes.len(), 4);
    assert_eq!(graph.totals.edges, 3);
    assert_eq!(graph.unresolved.len(), 2);
    assert!(graph
        .edges
        .iter()
        .all(|edge| edge.target.ends_with("Target.md")));
    assert!(graph
        .edges
        .iter()
        .any(|edge| edge.alias.as_deref() == Some("Label")
            && edge.heading.as_deref() == Some("Section")));
    assert!(graph
        .edges
        .iter()
        .any(|edge| edge.heading.as_deref() == Some("^one")));
    let ambiguous = graph
        .unresolved
        .iter()
        .find(|link| link.status == "ambiguous")
        .unwrap();
    assert_eq!(ambiguous.target, "Same");
    assert_eq!(ambiguous.candidates.len(), 2);
    assert!(graph
        .unresolved
        .iter()
        .any(|link| link.status == "missing" && link.target == "Missing"));
    assert!(graph
        .nodes
        .iter()
        .all(|node| Path::new(&node.path).starts_with(&root)));
    assert!(!graph
        .unresolved
        .iter()
        .any(|link| link.target.contains("outside")));
    let local = database
        .graph_workspace(GraphRequest {
            focus: Some(root.join("Target.md").to_string_lossy().into()),
            depth: Some(1),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(local.nodes.len(), 2);
    assert_eq!(local.edges.len(), 3);
    let truncated = database
        .graph_workspace(GraphRequest {
            max_nodes: Some(1),
            max_edges: Some(1),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(truncated.nodes.len(), 1);
    assert!(truncated.truncated.nodes);
    assert!(truncated.truncated.edges);
    assert!(truncated.edges.iter().all(|edge| truncated
        .nodes
        .iter()
        .any(|node| node.id == edge.source)
        && truncated.nodes.iter().any(|node| node.id == edge.target)));
}
#[test]
fn search_and_graph_revalidate_cache_paths_and_rebuild_preserves_appdata() {
    let temporary = tempfile::tempdir().unwrap();
    let (database, root) = setup(temporary.path());
    fs::write(root.join("A.md"), "# A\n[[B]]\n").unwrap();
    fs::write(root.join("B.md"), "# B\n").unwrap();
    database
        .persist(StateUpdate {
            settings: Some(json!({"theme":"light"})),
            draft: Some(json!({"id":"draft","name":"draft.md","content":"unsaved","path":null})),
            ..Default::default()
        })
        .unwrap();
    database.index_workspace().unwrap();
    let outside = temporary.path().join("outside.md");
    fs::write(&outside, "outside secret").unwrap();
    let connection = rusqlite::Connection::open(&database.path).unwrap();
    connection.execute("INSERT INTO cache_files(path,name,title,content) VALUES(?1,'outside.md','secret','outside secret')",[outside.to_str().unwrap()]).unwrap();
    connection.execute("INSERT INTO cache_graph_links(source_path,line,raw_target,kind,target_path,status,candidates_json) VALUES(?1,1,'outside','wiki',?2,'resolved','[]')",[root.join("A.md").to_str().unwrap(),outside.to_str().unwrap()]).unwrap();
    assert_eq!(
        database
            .search_workspace_advanced(request(json!({})))
            .unwrap()
            .total,
        2
    );
    assert_eq!(
        database
            .graph_workspace(GraphRequest::default())
            .unwrap()
            .nodes
            .len(),
        2
    );
    #[cfg(unix)]
    {
        fs::remove_file(root.join("B.md")).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("B.md")).unwrap();
        let page = database
            .search_workspace_advanced(request(json!({})))
            .unwrap();
        assert_eq!(page.total, 1);
        let graph = database.graph_workspace(GraphRequest::default()).unwrap();
        assert_eq!(graph.nodes.len(), 1);
        assert!(graph.edges.is_empty());
        assert!(notation_lib::explorer::read_workspace_file(&database, "B.md").is_err());
    }
    database.index_workspace().unwrap();
    let state = database.bootstrap(None).unwrap();
    assert_eq!(state.settings["theme"], "light");
    assert_eq!(state.draft.unwrap()["content"], "unsaved");
    write_with_metadata(
        root.join("A.md").to_str().unwrap(),
        "# A\n[[Missing]]\n",
        &Ok(database.clone()),
    )
    .unwrap();
    let graph = database.graph_workspace(GraphRequest::default()).unwrap();
    assert!(graph.unresolved.iter().any(|link| link.target == "Missing"));
    assert_eq!(
        database
            .list_revisions(root.join("A.md").to_str().unwrap())
            .unwrap()
            .len(),
        2
    );
}
#[test]
fn block_candidates_match_reference_syntax_exclusions_duplicate_ids_and_crlf_locations() {
    let temporary = tempfile::tempdir().unwrap();
    let (database, root) = setup(temporary.path());
    let source="---\r\ncustom: '^yaml'\r\n---\r\n# Note\r\nParagraph. ^one\r\n\r\n> Quoted block\r\n\r\n^quoted\r\n\r\n```md\r\ninside ^ignored\r\n```\r\n^code\r\n\r\n<div>\r\ninside ^html\r\n</div>\r\n\r\n$math ^math$\r\n\r\nOther. ^one\r\n";
    fs::write(root.join("Note.md"), source).unwrap();
    database.index_workspace().unwrap();
    let candidates = database.wiki_candidates("Note#^", None, None).unwrap();
    assert!(candidates[0].headings.is_empty());
    let blocks = &candidates[0].blocks;
    assert_eq!(
        blocks
            .iter()
            .map(|block| block.id.as_str())
            .collect::<Vec<_>>(),
        ["one", "quoted", "code", "one"]
    );
    assert_eq!(blocks[0].line, 5);
    assert_eq!(blocks[1].line, 7);
    assert_eq!(blocks[2].line, 11);
    assert_eq!(
        database
            .resolve_wiki_link("Note#^one", None)
            .unwrap()
            .heading
            .as_deref(),
        Some("^one")
    );
}
