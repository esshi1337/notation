use notation_lib::{
    explorer, git, mcp,
    storage::{Database, StateUpdate},
};
use serde_json::{json, Value};
use std::fs;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

fn database(directory: &Path) -> Database {
    Database::open(&directory.join("app/state.sqlite3")).unwrap()
}
fn run_git(root: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .args(args)
        .current_dir(root)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{:?}: {}",
        args,
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().into()
}
fn modern(method: &str, params: Value) -> Value {
    let mut params = params;
    params["_meta"] = json!({"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}});
    json!({"jsonrpc":"2.0","id":7,"method":method,"params":params})
}

#[test]
fn lazy_explorer_is_rooted_sorted_and_does_not_follow_symlink_escapes() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("notes");
    fs::create_dir_all(root.join("folder/deep")).unwrap();
    fs::write(root.join("z.md"), "note").unwrap();
    fs::write(root.join("a.png"), [0, 1]).unwrap();
    fs::create_dir(root.join(".private")).unwrap();
    fs::create_dir(root.join("node_modules")).unwrap();
    fs::write(root.join("folder/deep/nested.md"), "nested").unwrap();
    let db = database(temporary.path());
    db.set_workspace(root.to_str().unwrap()).unwrap();
    let listing = explorer::list_directory(&db, None).unwrap();
    assert_eq!(listing.entries.len(), 3);
    assert!(listing.entries[0].is_dir);
    assert!(
        listing
            .entries
            .iter()
            .find(|entry| entry.name == "z.md")
            .unwrap()
            .editable
    );
    assert!(
        !listing
            .entries
            .iter()
            .find(|entry| entry.name == "a.png")
            .unwrap()
            .editable
    );
    assert!(listing.parent.is_none());
    let nested = explorer::list_directory(&db, Some("folder")).unwrap();
    assert_eq!(nested.entries.len(), 1);
    assert!(nested.parent.is_some());
    assert!(explorer::list_directory(&db, Some("../app")).is_err());
    assert!(explorer::read_workspace_file(&db, "../app/state.sqlite3").is_err());
    assert_eq!(
        explorer::read_workspace_file(&db, "folder/deep/nested.md")
            .unwrap()
            .content,
        "nested"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        fs::write(temporary.path().join("outside.md"), "secret").unwrap();
        symlink(temporary.path().join("outside.md"), root.join("escape.md")).unwrap();
        symlink(temporary.path(), root.join("escape-dir")).unwrap();
        assert_eq!(
            explorer::list_directory(&db, None).unwrap().entries.len(),
            3
        );
        assert!(explorer::read_workspace_file(&db, "escape.md").is_err());
        assert!(explorer::list_directory(&db, Some("escape-dir")).is_err());
    }
}

#[test]
fn actual_git_queries_show_status_graph_and_all_diff_cases_without_mutation() {
    let temporary = tempfile::tempdir().unwrap();
    let repo = temporary.path().join("repo");
    fs::create_dir_all(repo.join("notes/deleted")).unwrap();
    run_git(&repo, &["init", "-b", "main"]);
    run_git(&repo, &["config", "user.name", "Notation tests"]);
    run_git(&repo, &["config", "user.email", "notation@example.invalid"]);
    fs::write(repo.join("notes/tracked.md"), "baseline\n").unwrap();
    fs::write(repo.join("notes/deleted/old.md"), "old\n").unwrap();
    fs::write(repo.join("outside.md"), "outside baseline\n").unwrap();
    run_git(&repo, &["add", "."]);
    run_git(&repo, &["commit", "-m", "Initial notes"]);
    run_git(&repo, &["branch", "feature"]);
    fs::write(repo.join("notes/tracked.md"), "changed\n").unwrap();
    fs::remove_dir_all(repo.join("notes/deleted")).unwrap();
    fs::write(repo.join("notes/new.md"), "untracked text\n").unwrap();
    fs::write(repo.join("notes/binary.bin"), [0, 255, 1, 2]).unwrap();
    fs::write(repo.join("outside.md"), "outside changed\n").unwrap();
    let db = database(temporary.path());
    db.set_workspace(repo.join("notes").to_str().unwrap())
        .unwrap();
    let head = run_git(&repo, &["rev-parse", "HEAD"]);
    let index = fs::read(repo.join(".git/index")).unwrap();
    let status = git::status(&db);
    assert!(status.available, "{:?}", status.error);
    assert_eq!(status.branch.as_deref(), Some("main"));
    assert_eq!(status.branches.len(), 2);
    assert!(status
        .changes
        .iter()
        .any(|change| change.path.ends_with("tracked.md")));
    assert!(status
        .changes
        .iter()
        .all(|change| Path::new(&change.path).starts_with(repo.join("notes"))));
    assert!(!status
        .changes
        .iter()
        .any(|change| change.path.ends_with("outside.md")));
    let history = git::history(&db, None).unwrap();
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].hash, head);
    assert!(history[0].parents.is_empty());
    assert_eq!(history[0].subject, "Initial notes");
    assert!(
        git::diff(&db, repo.join("notes/tracked.md").to_str().unwrap(), false)
            .unwrap()
            .diff
            .contains("+changed")
    );
    assert!(git::diff(
        &db,
        repo.join("notes/deleted/old.md").to_str().unwrap(),
        false
    )
    .unwrap()
    .diff
    .contains("-old"));
    assert!(
        git::diff(&db, repo.join("notes/new.md").to_str().unwrap(), false)
            .unwrap()
            .diff
            .contains("+untracked text")
    );
    assert!(
        git::diff(&db, repo.join("notes/binary.bin").to_str().unwrap(), false)
            .unwrap()
            .diff
            .contains("Binary files")
    );
    assert!(git::diff(&db, repo.join("outside.md").to_str().unwrap(), false).is_err());
    assert_eq!(run_git(&repo, &["rev-parse", "HEAD"]), head);
    assert_eq!(fs::read(repo.join(".git/index")).unwrap(), index);
    run_git(&repo, &["add", "notes/tracked.md"]);
    assert!(
        git::diff(&db, repo.join("notes/tracked.md").to_str().unwrap(), true)
            .unwrap()
            .diff
            .contains("+changed")
    );
}

#[test]
fn git_non_repo_and_unborn_repository_are_explicit() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("notes");
    fs::create_dir(&root).unwrap();
    let db = database(temporary.path());
    db.set_workspace(root.to_str().unwrap()).unwrap();
    let status = git::status(&db);
    assert!(!status.available);
    assert!(status.error.is_some());
    run_git(&root, &["init", "-b", "main"]);
    assert!(git::status(&db).available);
    assert!(git::history(&db, None).unwrap().is_empty());
}

#[test]
fn mcp_modern_and_legacy_protocols_validate_requests_and_tool_shapes() {
    let mut protocol = mcp::Protocol::default();
    let discovery = protocol
        .handle(modern("server/discover", json!({})), |_, _| unreachable!())
        .unwrap();
    assert_eq!(discovery["result"]["resultType"], "complete");
    assert_eq!(discovery["result"]["supportedVersions"][0], "2026-07-28");
    assert!(discovery["result"]["_meta"]["io.modelcontextprotocol/serverInfo"].is_object());
    let list = protocol
        .handle(modern("tools/list", json!({})), |_, _| unreachable!())
        .unwrap();
    assert!(list["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .any(|tool| tool["name"] == "edit_document"));
    let call = protocol
        .handle(
            modern(
                "tools/call",
                json!({"name":"read_tab","arguments":{"tabId":"one"}}),
            ),
            |name, args| {
                assert_eq!(name, "read_tab");
                assert_eq!(args["tabId"], "one");
                Ok(json!({"content":"unsaved"}))
            },
        )
        .unwrap();
    assert_eq!(call["result"]["structuredContent"]["content"], "unsaved");
    assert_eq!(call["result"]["resultType"], "complete");
    let invalid = protocol
        .handle(
            modern(
                "tools/call",
                json!({"name":"edit_document","arguments":{"tabId":"one","content":"replacement"}}),
            ),
            |_, _| unreachable!(),
        )
        .unwrap();
    assert_eq!(invalid["error"]["code"], -32602);
    let mut unsupported = modern("ping", json!({}));
    unsupported["params"]["_meta"]["io.modelcontextprotocol/protocolVersion"] = json!("1900-01-01");
    let response = protocol.handle(unsupported, |_, _| unreachable!()).unwrap();
    assert_eq!(response["error"]["code"], -32022);
    assert_eq!(response["error"]["data"]["requested"], "1900-01-01");
    let missing = json!({"jsonrpc":"2.0","id":1,"method":"server/discover","params":{}});
    assert_eq!(
        protocol.handle(missing, |_, _| unreachable!()).unwrap()["error"]["code"],
        -32602
    );
    let init=protocol.handle(json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}),|_,_|unreachable!()).unwrap();
    assert_eq!(init["result"]["protocolVersion"], "2025-11-25");
    assert!(init["result"].get("resultType").is_none());
    assert!(protocol
        .handle(
            json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
            |_, _| unreachable!()
        )
        .is_none());
    let legacy = protocol
        .handle(
            json!({"jsonrpc":"2.0","id":3,"method":"tools/list"}),
            |_, _| unreachable!(),
        )
        .unwrap();
    assert!(legacy["result"]["tools"].is_array());
}

#[test]
fn actual_stdio_handshakes_without_app_or_database_and_reports_missing_live_app() {
    let temporary = tempfile::tempdir().unwrap();
    let data = temporary.path().join("not-created");
    let mut child = Command::new(env!("CARGO_BIN_EXE_notation"))
        .arg("--mcp")
        .env("XDG_DATA_HOME", &data)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    {
        let mut input = child.stdin.take().unwrap();
        for request in [
            json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}),
            json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
            json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}),
            json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_tabs","arguments":{}}}),
        ] {
            writeln!(input, "{request}").unwrap();
        }
    }
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    let stdout = String::from_utf8(output.stdout).unwrap();
    let responses = stdout
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(responses.len(), 3);
    assert_eq!(responses[0]["result"]["protocolVersion"], "2025-11-25");
    assert!(responses[1]["result"]["tools"].is_array());
    assert_eq!(responses[2]["result"]["isError"], true);
    assert!(responses[2]["result"]["content"][0]["text"]
        .as_str()
        .unwrap()
        .contains("Open Notation first"));
    assert!(!data.exists());
}

#[cfg(unix)]
#[test]
fn private_live_socket_forwards_reads_and_guarded_ui_requests_with_edit_permission_gate() {
    use std::os::unix::fs::PermissionsExt;
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("notes");
    fs::create_dir(&root).unwrap();
    fs::write(root.join("note.md"), "disk text").unwrap();
    let db = database(temporary.path());
    db.set_workspace(root.to_str().unwrap()).unwrap();
    let bridge = mcp::AgentBridge::default();
    let reply_bridge = bridge.clone();
    let live = Arc::new(Mutex::new("unsaved text".to_string()));
    let edited = live.clone();
    let backend = mcp::Backend {
        database: Ok(db.clone()),
        bridge: bridge.clone(),
        emit: Arc::new(move |request| {
            let result = if request["operation"] == "edit_document" {
                let mut content = edited.lock().unwrap();
                if request["expectedContent"] != *content {
                    Err("Document changed since it was read.".into())
                } else {
                    *content = request["content"].as_str().unwrap().into();
                    Ok(json!({"id":"one","content":*content,"dirty":true}))
                }
            } else {
                Ok(json!({"id":"one","content":*edited.lock().unwrap(),"dirty":true}))
            };
            match result {
                Ok(result) => {
                    reply_bridge.complete(request["id"].as_str().unwrap(), Some(result), None);
                }
                Err(error) => {
                    reply_bridge.complete(request["id"].as_str().unwrap(), None, Some(error));
                }
            }
            Ok(())
        }),
    };
    let path = temporary.path().join("agent/agent.sock");
    mcp::serve(&path, backend).unwrap();
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert!(mcp::forward(&path, "read_file", &json!({"path":"note.md"})).is_err());
    bridge.set_ready(true);
    assert_eq!(
        mcp::forward(&path, "read_file", &json!({"path":"note.md"})).unwrap()["content"],
        "disk text"
    );
    assert_eq!(
        mcp::forward(&path, "read_tab", &json!({"tabId":"one"})).unwrap()["content"],
        "unsaved text"
    );
    assert!(mcp::forward(
        &path,
        "edit_document",
        &json!({"tabId":"one","expectedContent":"stale","content":"bad"})
    )
    .is_err());
    assert_eq!(*live.lock().unwrap(), "unsaved text");
    let result = mcp::forward(
        &path,
        "edit_document",
        &json!({"tabId":"one","expectedContent":"unsaved text","content":"edited but unsaved"}),
    )
    .unwrap();
    assert_eq!(result["content"], "edited but unsaved");
    assert_eq!(
        fs::read_to_string(root.join("note.md")).unwrap(),
        "disk text"
    );
    db.persist(StateUpdate {
        settings: Some(json!({"agentEditsEnabled":false})),
        ..Default::default()
    })
    .unwrap();
    assert!(mcp::forward(
        &path,
        "edit_document",
        &json!({"tabId":"one","expectedContent":"edited but unsaved","content":"blocked"})
    )
    .unwrap_err()
    .contains("disabled"));
    assert_eq!(*live.lock().unwrap(), "edited but unsaved");
    assert!(mcp::forward(&path, "read_file", &json!({"path":"../app/state.sqlite3"})).is_err());
}

#[cfg(unix)]
#[test]
fn socket_startup_keeps_unexpected_existing_files_and_duplicate_live_server() {
    let temporary = tempfile::tempdir().unwrap();
    let db = database(temporary.path());
    let backend = mcp::Backend {
        database: Ok(db),
        bridge: mcp::AgentBridge::default(),
        emit: Arc::new(|_| Ok(())),
    };
    let path = temporary.path().join("agent/agent.sock");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, "keep this file").unwrap();
    assert!(mcp::serve(&path, backend.clone()).is_err());
    assert_eq!(fs::read_to_string(&path).unwrap(), "keep this file");
    fs::remove_file(&path).unwrap();
    mcp::serve(&path, backend.clone()).unwrap();
    assert!(mcp::serve(&path, backend).is_err());
}

#[test]
fn canonical_document_identity_is_resolved_before_save_without_creating_files() {
    let temporary = tempfile::tempdir().unwrap();
    fs::create_dir(temporary.path().join("folder")).unwrap();
    let actual = temporary.path().join("note.md");
    fs::write(&actual, "original").unwrap();
    let alias = temporary.path().join("folder/../note.md");
    let resolved = notation_lib::documents::resolve_document_path(alias.to_str().unwrap()).unwrap();
    assert_eq!(resolved, actual.to_str().unwrap());
    assert_eq!(
        notation_lib::documents::read_document(alias.to_str().unwrap())
            .unwrap()
            .path,
        resolved
    );
    let fresh = temporary.path().join("folder/../new.md");
    assert_eq!(
        notation_lib::documents::resolve_document_path(fresh.to_str().unwrap()).unwrap(),
        temporary.path().join("new.md").to_str().unwrap()
    );
    assert!(!fresh.exists());
    assert_eq!(
        notation_lib::documents::write_document(alias.to_str().unwrap(), "saved")
            .unwrap()
            .path,
        resolved
    );
    #[cfg(unix)]
    {
        let link = temporary.path().join("link.md");
        std::os::unix::fs::symlink(&actual, &link).unwrap();
        assert_eq!(
            notation_lib::documents::read_document(link.to_str().unwrap())
                .unwrap()
                .path,
            resolved
        );
        assert!(
            notation_lib::documents::write_document(link.to_str().unwrap(), "blocked").is_err()
        );
    }
}

#[test]
fn mcp_launcher_discovery_preserves_appimage_and_extracted_appdir_environment() {
    let temporary = tempfile::tempdir().unwrap();
    let appdir = temporary.path().join("Notation.AppDir");
    fs::create_dir_all(appdir.join("usr/bin")).unwrap();
    let executable = appdir.join("usr/bin/notation");
    fs::write(&executable, "binary").unwrap();
    let launcher = appdir.join("AppRun");
    fs::write(&launcher, "launcher").unwrap();
    let appimage = temporary.path().join("Notation.AppImage");
    assert_eq!(
        mcp::launch_command_for(Some(&appimage), Some(&appdir), &executable),
        appimage
    );
    assert_eq!(
        mcp::launch_command_for(None, Some(&appdir), &executable),
        launcher
    );
    assert_eq!(mcp::launch_command_for(None, None, &executable), launcher);
    fs::remove_file(&launcher).unwrap();
    assert_eq!(
        mcp::launch_command_for(None, Some(&appdir), &executable),
        executable
    );
    let ordinary = temporary.path().join("target/debug/notation");
    assert_eq!(mcp::launch_command_for(None, None, &ordinary), ordinary);
}
