use notation_lib::automation::{ScriptDocument, ScriptManager, ScriptRequest};
use std::path::Path;
use std::thread;
use std::time::{Duration, Instant};

fn request(id: &str, code: &str, cwd: Option<String>) -> ScriptRequest {
    ScriptRequest {
        id: id.into(),
        code: code.into(),
        cwd,
        document: ScriptDocument {
            name: "example.md".into(),
            path: None,
            text: "original".into(),
            selection: String::new(),
            from: 0,
            to: 0,
        },
        script_id: None,
    }
}

#[test]
fn real_worker_executes_embedded_javascript_without_desktop_or_node() {
    let manager = ScriptManager::default();
    let response = manager
        .run(
            Path::new(env!("CARGO_BIN_EXE_notation")),
            request(
                "actual",
                "console.log('embedded'); return {text:api.context.document.text.toUpperCase()};",
                None,
            ),
        )
        .unwrap();
    assert!(response.ok, "{:?}", response.error);
    assert_eq!(response.result["text"], "ORIGINAL");
    assert_eq!(response.logs[0].message, "embedded");
    assert!(!manager.stop("actual"));
}

#[test]
fn real_worker_infinite_loop_times_out_and_manager_can_run_again() {
    let manager = ScriptManager::default();
    let started = Instant::now();
    let response = manager
        .run_with_timeout(
            Path::new(env!("CARGO_BIN_EXE_notation")),
            request("timeout", "while(true) {}", None),
            Duration::from_millis(100),
        )
        .unwrap();
    assert!(!response.ok);
    assert!(response.error.unwrap().contains("time limit"));
    assert!(started.elapsed() < Duration::from_secs(3));
    let response = manager
        .run(
            Path::new(env!("CARGO_BIN_EXE_notation")),
            request("timeout", "return 42;", None),
        )
        .unwrap();
    assert!(response.ok);
    assert_eq!(response.result, 42);
}

#[cfg(target_os = "linux")]
#[test]
fn stop_kills_worker_and_command_descendants_before_they_write() {
    let directory = tempfile::tempdir().unwrap();
    let manager = ScriptManager::default();
    let background_manager = manager.clone();
    let cwd = Some(directory.path().to_string_lossy().into());
    let input = request(
        "stop",
        "return api.run('sh',['-c','touch started; sleep 0.5; printf orphan > orphan.txt']);",
        cwd,
    );
    let handle = thread::spawn(move || {
        background_manager
            .run(Path::new(env!("CARGO_BIN_EXE_notation")), input)
            .unwrap()
    });
    let started = Instant::now();
    while !directory.path().join("started").exists() {
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "worker command did not start"
        );
        thread::sleep(Duration::from_millis(10));
    }
    assert!(manager.stop("stop"));
    let response = handle.join().unwrap();
    assert!(!response.ok);
    assert!(response.error.unwrap().contains("stopped"));
    thread::sleep(Duration::from_millis(600));
    assert!(!directory.path().join("orphan.txt").exists());
    assert!(!manager.stop("stop"));
}

#[cfg(target_os = "linux")]
#[test]
fn overall_timeout_kills_worker_commands_before_they_write() {
    let directory = tempfile::tempdir().unwrap();
    let manager = ScriptManager::default();
    let input = request(
        "command-timeout",
        "api.run('sh',['-c','sleep 0.5; printf orphan > orphan.txt']);",
        Some(directory.path().to_string_lossy().into()),
    );
    let response = manager
        .run_with_timeout(
            Path::new(env!("CARGO_BIN_EXE_notation")),
            input,
            Duration::from_millis(100),
        )
        .unwrap();
    assert!(!response.ok);
    thread::sleep(Duration::from_millis(600));
    assert!(!directory.path().join("orphan.txt").exists());
}
