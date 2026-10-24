// Compile the module in this test crate so its crate-private descriptor hook is
// available without exposing an arbitrary process launcher in the production API.
#[path = "../src/language_server.rs"]
mod language_server;

use language_server::{
    production_descriptor, typescript_path, Event, ServerKind, ServerSpec, Service,
    MAX_FRAME_BYTES, OUTGOING_QUEUE,
};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::{mpsc, Arc, Barrier, OnceLock},
    thread,
    time::{Duration, Instant},
};

fn fake_executable() -> PathBuf {
    static EXECUTABLE: OnceLock<PathBuf> = OnceLock::new();
    EXECUTABLE
        .get_or_init(|| {
            let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
            let executable = manifest.join("target").join(format!(
                "notation-language-server-fake-{}{}",
                std::process::id(),
                std::env::consts::EXE_SUFFIX
            ));
            let status = Command::new(std::env::var_os("RUSTC").unwrap_or_else(|| "rustc".into()))
                .arg("--edition=2021")
                .arg(manifest.join("tests/support/language_server_fake.rs"))
                .arg("-o")
                .arg(&executable)
                .status()
                .unwrap();
            assert!(status.success(), "could not compile fake language server");
            executable
        })
        .clone()
}

fn fake_spec(mode: &str) -> ServerSpec {
    ServerSpec::new(fake_executable(), &[mode])
}

fn fake_service(mode: &str) -> (Service, mpsc::Receiver<Event>) {
    fake_service_with_spec(fake_spec(mode))
}

fn fake_service_with_spec(spec: ServerSpec) -> (Service, mpsc::Receiver<Event>) {
    let (sender, receiver) = mpsc::channel();
    let service = Service::for_test(
        spec,
        Arc::new(move |event| {
            let _ = sender.send(event);
        }),
    );
    (service, receiver)
}

fn saved_file(path: &Path) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, "saved document").unwrap();
}

fn typescript_document(root: &Path) -> PathBuf {
    saved_file(&root.join("package.json"));
    let file = root.join("src/index.ts");
    saved_file(&file);
    file
}

fn optional_pack(profile: &Path, manifest_version: u64, patches: &[&str]) -> PathBuf {
    let base = profile.join("language-servers");
    fs::create_dir_all(&base).unwrap();
    fs::write(
        base.join("manifest.json"),
        serde_json::json!({
            "manifestVersion": manifest_version,
            "notationPatches": patches,
        })
        .to_string(),
    )
    .unwrap();
    for relative in [
        "node",
        "node_modules/typescript-language-server/lib/cli.mjs",
        "node_modules/svelte-language-server/bin/server.js",
        "node_modules/typescript/lib/tsserver.js",
    ] {
        saved_file(&base.join(relative));
    }
    base
}

fn start(service: &Service, file: &Path) -> language_server::StartInfo {
    service
        .start(file.to_string_lossy().into_owned(), "typescript".into())
        .unwrap()
}

fn wait_exit(receiver: &mpsc::Receiver<Event>) -> (String, String) {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        assert!(!remaining.is_zero(), "timed out waiting for an LSP exit");
        match receiver.recv_timeout(remaining).unwrap() {
            Event::Exit { id, error } => return (id, error),
            Event::Message { .. } => {}
        }
    }
}

fn wait_message(receiver: &mpsc::Receiver<Event>) -> (String, String) {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        assert!(!remaining.is_zero(), "timed out waiting for an LSP message");
        match receiver.recv_timeout(remaining).unwrap() {
            Event::Message { id, message } => return (id, message),
            Event::Exit { error, .. } => panic!("language server exited before replying: {error}"),
        }
    }
}

#[test]
fn absent_optional_pack_has_an_actionable_error_and_no_fallback() {
    let directory = tempfile::tempdir().unwrap();
    for kind in [ServerKind::TypeScript, ServerKind::Svelte] {
        let error = production_descriptor(kind, Some(directory.path())).unwrap_err();
        assert!(error.contains("not installed"), "{error}");
        assert!(error.contains("npm run desktop:languages"), "{error}");
        assert!(error.contains("language-servers"), "{error}");
    }
    let error = typescript_path(Some(directory.path())).unwrap_err();
    assert!(error.contains("not installed"), "{error}");
    assert!(!error.contains("resources"), "{error}");
}

#[test]
fn explicit_valid_pack_drives_server_and_typescript_resolution() {
    let directory = tempfile::tempdir().unwrap();
    let base = optional_pack(directory.path(), 1, &["svelte-untrusted-prettier-config"]);
    for (kind, module) in [
        (
            ServerKind::TypeScript,
            "typescript-language-server/lib/cli.mjs",
        ),
        (ServerKind::Svelte, "svelte-language-server/bin/server.js"),
    ] {
        let spec = production_descriptor(kind, Some(directory.path())).unwrap();
        let script = base.join("node_modules").join(module);
        assert_eq!(spec.program(), base.join("node"));
        assert_eq!(spec.arguments()[0], script.as_os_str());
        assert_eq!(spec.arguments()[1], "--stdio");
    }
    let expected = base.join("node_modules/typescript/lib/tsserver.js");
    assert_eq!(typescript_path(Some(directory.path())).unwrap(), expected);
    let service = Service::new(Some(directory.path().to_path_buf()), Arc::new(|_| {}));
    assert_eq!(
        service.typescript_path().unwrap(),
        expected.to_string_lossy()
    );
}

#[test]
fn unsupported_manifest_version_is_rejected_before_resolution() {
    let directory = tempfile::tempdir().unwrap();
    optional_pack(directory.path(), 2, &["svelte-untrusted-prettier-config"]);
    let error = production_descriptor(ServerKind::TypeScript, Some(directory.path())).unwrap_err();
    assert!(error.contains("unsupported manifest version 2"), "{error}");
    assert!(error.contains("Reinstall"), "{error}");
    assert!(typescript_path(Some(directory.path()))
        .unwrap_err()
        .contains("unsupported manifest version 2"));
}

#[test]
fn unpatched_pack_is_rejected_before_resolution() {
    let directory = tempfile::tempdir().unwrap();
    optional_pack(directory.path(), 1, &[]);
    for kind in [ServerKind::TypeScript, ServerKind::Svelte] {
        let error = production_descriptor(kind, Some(directory.path())).unwrap_err();
        assert!(error.contains("unpatched pack"), "{error}");
        assert!(
            error.contains("svelte-untrusted-prettier-config"),
            "{error}"
        );
    }
    assert!(typescript_path(Some(directory.path()))
        .unwrap_err()
        .contains("unpatched pack"));
}

#[test]
fn unicode_json_and_fragmented_frames_round_trip_without_interpretation() {
    let directory = tempfile::tempdir().unwrap();
    let file = typescript_document(directory.path());
    let (service, events) = fake_service("fragmented");
    let started = start(&service, &file);
    let message = serde_json::json!({
        "jsonrpc": "2.0",
        "method": "notation/𝒜é",
        "params": {"text": "🦀漢字", "html": "<script>pass through, do not execute</script>"}
    })
    .to_string();
    assert!(message.len() > message.chars().count());
    service.send(started.id.clone(), message.clone()).unwrap();
    let (id, received) = wait_message(&events);
    assert_eq!(id, started.id);
    assert_eq!(received, message);
    service.stop(started.id).unwrap();
}

#[test]
fn malformed_headers_oversized_frames_and_invalid_json_fail_transport() {
    let cases = [
        ("duplicate-length", "duplicate Content-Length"),
        ("oversized-header", "header exceeds 8 KiB"),
        ("oversized-body", "frame exceeds 4 MiB"),
        ("invalid-json", "invalid JSON"),
    ];
    for (mode, expected) in cases {
        let directory = tempfile::tempdir().unwrap();
        let file = typescript_document(directory.path());
        let (service, events) = fake_service(mode);
        let started = start(&service, &file);
        let (id, error) = wait_exit(&events);
        assert_eq!(id, started.id, "mode {mode}");
        assert!(error.contains(expected), "mode {mode}: {error}");
        let status = service.status();
        assert_eq!(status.len(), 1);
        assert!(!status[0].running);
        assert!(status[0].error.as_deref().unwrap().contains(expected));
        service.stop(started.id).unwrap();
    }
}

#[test]
fn unexpected_child_exit_is_reported_and_retained_as_bounded_status() {
    let directory = tempfile::tempdir().unwrap();
    let file = typescript_document(directory.path());
    let (service, events) = fake_service("exit");
    let started = start(&service, &file);
    let (id, error) = wait_exit(&events);
    assert_eq!(id, started.id);
    assert!(!error.is_empty());
    assert!(!service.status()[0].running);
    service.stop(started.id.clone()).unwrap();
    let status = service.status();
    assert_eq!(status.len(), 1, "one recent error is retained");
    assert!(!status[0].running);
    assert!(status[0].error.is_some());
    service.stop(started.id).unwrap();
}

#[test]
fn starts_deduplicate_per_root_but_not_across_workspace_views() {
    let directory = tempfile::tempdir().unwrap();
    let root_a = directory.path().join("wörk space 🦀/one");
    let root_b = directory.path().join("wörk space 🦀/two");
    let a = typescript_document(&root_a);
    let second = root_a.join("src/component.tsx");
    saved_file(&second);
    let b = typescript_document(&root_b);
    let (service, _events) = fake_service("echo");

    let first = start(&service, &a);
    let repeated = start(&service, &a);
    let other_language = service
        .start(
            second.to_string_lossy().into_owned(),
            "typescriptreact".into(),
        )
        .unwrap();
    let separate = start(&service, &b);
    assert_eq!(first.id, repeated.id);
    assert_eq!(first.id, other_language.id);
    assert_eq!(other_language.language_id, "typescriptreact");
    assert_ne!(first.id, separate.id);
    assert_ne!(first.root_uri, separate.root_uri);
    assert_eq!(service.status().len(), 2);
    for (uri, path) in [(&first.uri, &a), (&first.root_uri, &root_a)] {
        assert!(!uri.contains('🦀') && !uri.contains(' '));
        let parsed = url::Url::parse(uri).unwrap();
        assert_eq!(
            parsed.to_file_path().unwrap(),
            fs::canonicalize(path).unwrap()
        );
    }
    service.stop_all();
    assert!(service.status().is_empty());
}

#[test]
fn project_markers_beat_git_and_git_is_the_fallback_root() {
    let directory = tempfile::tempdir().unwrap();
    let marked = directory.path().join("marked");
    let file = typescript_document(&marked.join("project"));
    fs::create_dir_all(marked.join(".git")).unwrap();
    let (service, _events) = fake_service("echo");
    let started = start(&service, &file);
    let expected = url::Url::from_directory_path(marked.join("project").canonicalize().unwrap())
        .unwrap()
        .to_string();
    assert_eq!(started.root_uri, expected);

    let rust_file = marked.join("repository/src/lib.rs");
    saved_file(&rust_file);
    fs::create_dir_all(marked.join("repository/.git")).unwrap();
    let rust = service
        .start(rust_file.to_string_lossy().into_owned(), "rust".into())
        .unwrap();
    let expected = url::Url::from_directory_path(marked.join("repository").canonicalize().unwrap())
        .unwrap()
        .to_string();
    assert_eq!(rust.root_uri, expected);
    assert_eq!(rust.language_id, "rust");
    assert_eq!(rust.server, "rust-analyzer");
    service.stop_all();
}

#[test]
fn concurrent_identical_starts_create_one_child() {
    let directory = tempfile::tempdir().unwrap();
    let file = typescript_document(directory.path());
    let (service, _events) = fake_service("echo");
    let barrier = Arc::new(Barrier::new(9));
    let ids = thread::scope(|scope| {
        let handles: Vec<_> = (0..8)
            .map(|_| {
                let service = service.clone();
                let barrier = barrier.clone();
                let file = file.clone();
                scope.spawn(move || {
                    barrier.wait();
                    start(&service, &file).id
                })
            })
            .collect();
        barrier.wait();
        handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect::<Vec<_>>()
    });
    assert!(ids.iter().all(|id| id == &ids[0]));
    assert_eq!(service.status().len(), 1);
    service.stop_all();
}

#[test]
fn server_cap_is_six_and_a_stopped_slot_can_be_reused() {
    let directory = tempfile::tempdir().unwrap();
    let (service, _events) = fake_service("echo");
    let files: Vec<_> = (0..7)
        .map(|index| typescript_document(&directory.path().join(format!("root-{index}"))))
        .collect();
    let mut started = Vec::new();
    for file in &files[..6] {
        started.push(start(&service, file));
    }
    let error = service
        .start(files[6].to_string_lossy().into_owned(), "typescript".into())
        .unwrap_err();
    assert!(error.contains("At most 6"), "{error}");
    service.stop(started.remove(0).id).unwrap();
    start(&service, &files[6]);
    assert_eq!(service.status().len(), 6);
    service.stop_all();
}

#[test]
fn send_rejects_invalid_and_oversized_json_and_queue_saturation_is_nonblocking() {
    let directory = tempfile::tempdir().unwrap();
    let file = typescript_document(directory.path());
    let (service, _events) = fake_service("hold");
    let started = start(&service, &file);
    assert!(service
        .send(started.id.clone(), "not json".into())
        .unwrap_err()
        .contains("complete JSON"));
    let oversized = serde_json::to_string(&"x".repeat(MAX_FRAME_BYTES)).unwrap();
    assert!(service
        .send(started.id.clone(), oversized)
        .unwrap_err()
        .contains("4 MiB"));

    let message = serde_json::to_string(&"x".repeat(64 * 1024)).unwrap();
    let mut accepted = 0;
    let mut saturated = false;
    for _ in 0..(OUTGOING_QUEUE * 3) {
        match service.send(started.id.clone(), message.clone()) {
            Ok(()) => accepted += 1,
            Err(error) if error.contains("queue is full") => {
                saturated = true;
                break;
            }
            Err(error) => panic!("unexpected queue failure: {error}"),
        }
    }
    assert!(saturated, "writer did not apply backpressure");
    assert!(accepted >= OUTGOING_QUEUE);
    service.stop(started.id).unwrap();
}

#[test]
fn input_validation_rejects_unsupported_unsaved_and_non_file_paths() {
    let directory = tempfile::tempdir().unwrap();
    let file = typescript_document(directory.path());
    let (service, _events) = fake_service("echo");
    assert!(service
        .start("relative.ts".into(), "typescript".into())
        .unwrap_err()
        .contains("absolute"));
    assert!(service
        .start(file.to_string_lossy().into_owned(), "python".into())
        .unwrap_err()
        .contains("Unsupported language"));
    assert!(service
        .start(
            directory.path().to_string_lossy().into_owned(),
            "typescript".into(),
        )
        .unwrap_err()
        .contains("regular file"));
    assert!(service
        .start(
            directory
                .path()
                .join("missing.ts")
                .to_string_lossy()
                .into_owned(),
            "typescript".into(),
        )
        .unwrap_err()
        .contains("existing saved"));
    assert!(service.status().is_empty());
}

#[cfg(unix)]
fn tree_service(heartbeat: &Path) -> Service {
    let spec = ServerSpec::new(
        fake_executable(),
        &["tree-parent", heartbeat.to_str().unwrap()],
    );
    fake_service_with_spec(spec).0
}

#[cfg(unix)]
fn wait_for_heartbeat(heartbeat: &Path) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !heartbeat.exists() {
        assert!(Instant::now() < deadline, "heartbeat did not start");
        thread::sleep(Duration::from_millis(10));
    }
    let first = fs::read_to_string(heartbeat).unwrap();
    loop {
        thread::sleep(Duration::from_millis(30));
        if fs::read_to_string(heartbeat).unwrap() != first {
            return;
        }
        assert!(Instant::now() < deadline, "heartbeat did not advance");
    }
}

#[cfg(unix)]
fn assert_heartbeat_stopped(heartbeat: &Path) {
    thread::sleep(Duration::from_millis(75));
    let stopped = fs::read_to_string(heartbeat).unwrap();
    thread::sleep(Duration::from_millis(175));
    assert_eq!(fs::read_to_string(heartbeat).unwrap(), stopped);
}

#[cfg(unix)]
#[test]
fn stop_kills_process_group_reaps_and_is_idempotent() {
    let directory = tempfile::tempdir().unwrap();
    let file = typescript_document(directory.path());
    let heartbeat = directory.path().join("heartbeat");
    let service = tree_service(&heartbeat);
    let started = start(&service, &file);
    wait_for_heartbeat(&heartbeat);
    let before = Instant::now();
    service.stop(started.id.clone()).unwrap();
    assert!(before.elapsed() < Duration::from_secs(3));
    assert_heartbeat_stopped(&heartbeat);
    assert!(service.status().is_empty());
    service.stop(started.id).unwrap();
}

#[cfg(unix)]
#[test]
fn last_service_drop_stops_all_process_groups() {
    let directory = tempfile::tempdir().unwrap();
    let first = typescript_document(&directory.path().join("first"));
    let second = typescript_document(&directory.path().join("second"));
    let heartbeat = directory.path().join("heartbeat");
    let service = tree_service(&heartbeat);
    start(&service, &first);
    start(&service, &second);
    assert_eq!(service.status().len(), 2);
    wait_for_heartbeat(&heartbeat);
    drop(service);
    assert_heartbeat_stopped(&heartbeat);
}
