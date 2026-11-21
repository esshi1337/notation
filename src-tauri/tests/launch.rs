use notation_lib::launch::{
    parse_arguments, read_document, EnqueueOutcome, LaunchQueue, LaunchRequest, MAX_LAUNCH_FILES,
    MAX_LAUNCH_REQUEST_BYTES, MAX_PENDING_LAUNCH_REQUESTS,
};
use std::ffi::OsString;
use std::fs::{self, File};
use std::path::Path;

fn request(id: &str) -> LaunchRequest {
    LaunchRequest::new(id, vec![format!("/tmp/{id}.txt")]).unwrap()
}

#[test]
fn cli_resolves_multiple_relative_paths_against_the_launching_directory() {
    let temporary = tempfile::tempdir().unwrap();
    let first = temporary.path().join("notes with spaces.txt");
    let second = temporary.path().join("日本語-🖋.md");
    fs::write(&first, "plain text").unwrap();
    fs::write(&second, "# Unicode").unwrap();
    let parsed = parse_arguments(
        [
            OsString::from("notes with spaces.txt"),
            OsString::from("日本語-🖋.md"),
        ],
        temporary.path(),
    )
    .unwrap()
    .unwrap();
    assert_eq!(
        parsed.paths(),
        &[
            first.canonicalize().unwrap().to_string_lossy(),
            second.canonicalize().unwrap().to_string_lossy(),
        ]
    );
    assert!(!parsed.id().is_empty());
}

#[test]
fn cli_supports_dash_filenames_only_after_the_option_separator() {
    let temporary = tempfile::tempdir().unwrap();
    fs::write(temporary.path().join("-draft.txt"), "draft").unwrap();
    let error = parse_arguments([OsString::from("-draft.txt")], temporary.path()).unwrap_err();
    assert!(error.contains("Unexpected option"), "{error}");
    assert!(error.contains("'--'"), "{error}");
    let parsed = parse_arguments(
        [OsString::from("--"), OsString::from("-draft.txt")],
        temporary.path(),
    )
    .unwrap()
    .unwrap();
    assert_eq!(
        parsed.paths()[0],
        temporary
            .path()
            .join("-draft.txt")
            .canonicalize()
            .unwrap()
            .to_string_lossy()
    );
    let error = parse_arguments(
        [OsString::from("notes.md"), OsString::from("--unknown")],
        temporary.path(),
    )
    .unwrap_err();
    assert!(error.contains("Unexpected option '--unknown'"), "{error}");
}

#[cfg(unix)]
#[test]
fn existing_aliases_use_the_same_canonical_document_identity() {
    use std::os::unix::fs::symlink;
    let temporary = tempfile::tempdir().unwrap();
    let target = temporary.path().join("target.txt");
    let alias = temporary.path().join("alias.txt");
    fs::write(&target, "unsaved buffer identity").unwrap();
    symlink(&target, &alias).unwrap();
    let parsed = parse_arguments([OsString::from("alias.txt")], temporary.path())
        .unwrap()
        .unwrap();
    assert_eq!(
        Path::new(&parsed.paths()[0]),
        target.canonicalize().unwrap()
    );
}

#[test]
fn missing_files_remain_absolute_so_the_restored_ui_can_report_the_failure() {
    let temporary = tempfile::tempdir().unwrap();
    let parsed = parse_arguments(
        [OsString::from("missing folder/missing.txt")],
        temporary.path(),
    )
    .unwrap()
    .unwrap();
    assert_eq!(
        Path::new(&parsed.paths()[0]),
        temporary.path().join("missing folder/missing.txt")
    );
}

#[test]
fn file_count_and_encoded_request_bytes_are_bounded() {
    let too_many = (0..=MAX_LAUNCH_FILES)
        .map(|index| OsString::from(format!("/tmp/{index}.txt")))
        .collect::<Vec<_>>();
    let error = parse_arguments(too_many, Path::new("/tmp")).unwrap_err();
    assert!(error.contains("At most 64"), "{error}");

    let error = LaunchRequest::new(
        "oversized",
        vec![format!("/{}", "x".repeat(MAX_LAUNCH_REQUEST_BYTES))],
    )
    .unwrap_err();
    assert!(error.contains("256 KiB"), "{error}");
    let error = LaunchRequest::decode(&vec![b'x'; MAX_LAUNCH_REQUEST_BYTES + 1]).unwrap_err();
    assert!(error.contains("256 KiB"), "{error}");
    let error = LaunchRequest::decode(b"not-json").unwrap_err();
    assert!(error.contains("Malformed"), "{error}");
}

#[test]
fn startup_requests_replay_until_handled_and_retries_are_deduplicated() {
    let queue = LaunchQueue::default();
    let request = request("startup");
    assert_eq!(queue.enqueue(request.clone()), Ok(EnqueueOutcome::Enqueued));
    assert_eq!(
        queue.enqueue(request.clone()),
        Ok(EnqueueOutcome::DuplicatePending)
    );
    assert!(queue.set_ready(false).unwrap().is_empty());
    assert_eq!(queue.set_ready(true).unwrap(), vec![request.clone()]);
    // A second readiness snapshot models a frontend reload before completion.
    assert_eq!(queue.set_ready(true).unwrap(), vec![request.clone()]);
    assert_eq!(queue.complete(request.id()), Ok(true));
    assert!(queue.set_ready(true).unwrap().is_empty());
    assert_eq!(
        queue.enqueue(request),
        Ok(EnqueueOutcome::DuplicateCompleted)
    );
}

#[test]
fn close_gate_admits_only_retries_of_already_accepted_requests() {
    let queue = LaunchQueue::default();
    let pending = request("accepted-before-close");
    assert_eq!(queue.enqueue(pending.clone()), Ok(EnqueueOutcome::Enqueued));
    queue.set_closing(true).unwrap();
    assert!(queue.enqueue(request("new-during-close")).is_err());
    assert_eq!(
        queue.enqueue(pending.clone()),
        Ok(EnqueueOutcome::DuplicatePending)
    );
    assert_eq!(queue.complete(pending.id()), Ok(true));
    assert_eq!(
        queue.enqueue(pending),
        Ok(EnqueueOutcome::DuplicateCompleted)
    );
    queue.set_closing(false).unwrap();
    assert_eq!(
        queue.enqueue(request("new-after-cancel")),
        Ok(EnqueueOutcome::Enqueued)
    );
}

#[test]
fn pending_queue_has_a_fixed_request_bound() {
    let queue = LaunchQueue::default();
    for index in 0..MAX_PENDING_LAUNCH_REQUESTS {
        assert_eq!(
            queue.enqueue(request(&format!("queued-{index}"))),
            Ok(EnqueueOutcome::Enqueued)
        );
    }
    let error = queue.enqueue(request("overflow")).unwrap_err();
    assert!(error.contains("full"), "{error}");
    assert_eq!(
        queue.set_ready(true).unwrap().len(),
        MAX_PENDING_LAUNCH_REQUESTS
    );
}

#[test]
fn launch_reads_utf8_without_writing_and_rejects_invalid_or_non_regular_input() {
    let temporary = tempfile::tempdir().unwrap();
    let path = temporary.path().join("plain text.txt");
    let original = "Notación · 日本語 · 🖋️\n";
    fs::write(&path, original).unwrap();
    let document = read_document(path.to_str().unwrap()).unwrap();
    assert_eq!(document.content, original);
    assert_eq!(
        document.path,
        path.canonicalize().unwrap().to_string_lossy()
    );
    assert_eq!(fs::read_to_string(&path).unwrap(), original);

    let invalid = temporary.path().join("invalid.txt");
    fs::write(&invalid, [0xff, 0xfe]).unwrap();
    assert!(read_document(invalid.to_str().unwrap())
        .unwrap_err()
        .contains("UTF-8"));
    assert!(read_document(temporary.path().to_str().unwrap())
        .unwrap_err()
        .contains("regular file"));
}

#[test]
fn oversized_launch_files_are_rejected_before_a_full_read() {
    let temporary = tempfile::tempdir().unwrap();
    let path = temporary.path().join("oversized.txt");
    let file = File::create(&path).unwrap();
    file.set_len(notation_lib::storage::MAX_CONTENT as u64 + 1)
        .unwrap();
    let error = read_document(path.to_str().unwrap()).unwrap_err();
    assert!(error.contains("4 MiB"), "{error}");
    assert_eq!(
        fs::metadata(&path).unwrap().len(),
        notation_lib::storage::MAX_CONTENT as u64 + 1
    );
}

#[test]
fn system_file_urls_become_one_launch_with_canonical_paths() {
    let temporary = tempfile::tempdir().unwrap();
    let directory = temporary.path().canonicalize().unwrap();
    let first = directory.join("First note.md");
    let second = directory.join("ünï/second.mmd");
    std::fs::create_dir_all(second.parent().unwrap()).unwrap();
    std::fs::write(&first, "# First").unwrap();
    std::fs::write(&second, "flowchart LR").unwrap();
    let url = |path: &std::path::Path| url::Url::from_file_path(path).unwrap().to_string();
    let urls = [
        url(&first),
        "https://example.com/not-a-document.md".to_string(),
        "notation://open?file=x".to_string(),
        "not a url".to_string(),
        // Finder may deliver a path with relative segments or a missing file.
        url(&directory.join("ünï/../ünï/second.mmd")),
        url(&directory.join("missing.md")),
    ];
    assert!(urls[0].contains("First%20note.md"), "{}", urls[0]);
    let request = notation_lib::launch::from_file_urls(urls.iter().map(String::as_str))
        .unwrap()
        .expect("documents");
    assert_eq!(
        request.paths(),
        [
            first.to_str().unwrap().to_string(),
            second.to_str().unwrap().to_string(),
            directory.join("missing.md").to_str().unwrap().to_string(),
        ]
    );
    // Nothing openable is not a launch, and it is not an error either.
    assert_eq!(notation_lib::launch::from_file_urls(["https://example.com/a.md", "mailto:x@example.com"]).unwrap(), None);
    assert_eq!(notation_lib::launch::from_file_urls(std::iter::empty()).unwrap(), None);
    // A file whose name starts with a dash is a document, not an option.
    let dashed = directory.join("-draft.md");
    std::fs::write(&dashed, "").unwrap();
    let request = notation_lib::launch::from_file_urls([url(&dashed).as_str()]).unwrap().unwrap();
    assert_eq!(request.paths(), [dashed.to_str().unwrap().to_string()]);
    // The per-launch document limit still applies.
    let many = (0..MAX_LAUNCH_FILES + 1).map(|index| url(&directory.join(format!("{index}.md")))).collect::<Vec<_>>();
    assert!(notation_lib::launch::from_file_urls(many.iter().map(String::as_str)).is_err());
}
