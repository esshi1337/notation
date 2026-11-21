use notation_lib::file_changes::write_checked;
use std::fs;
#[test]
fn checked_save_preserves_external_edits_and_missing_files() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("main.rs");
    let path = path.to_str().unwrap();
    fs::write(path, "old\r\n").unwrap();
    let database = Err("test without history".into());
    assert!(write_checked(path, "new\r\n", "old\r\n", &database).is_ok());
    fs::write(path, "external").unwrap();
    assert!(write_checked(path, "my draft", "new\r\n", &database)
        .unwrap_err()
        .contains("changed on disk"));
    assert_eq!(fs::read_to_string(path).unwrap(), "external");
    fs::remove_file(path).unwrap();
    assert!(write_checked(path, "my draft", "external", &database).is_err());
    assert!(!std::path::Path::new(path).exists());
}

#[test]
fn fingerprint_changes_with_content_identity_and_time_and_refuses_non_files() {
    use notation_lib::file_changes::fingerprint;
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("note.md");
    std::fs::write(&path, "one").unwrap();
    let text = path.to_str().unwrap();
    let first = fingerprint(text).unwrap();
    assert_eq!(first.size, "3");
    assert!(first.modified_ns.parse::<u128>().unwrap() > 1_600_000_000_000_000_000);
    assert_eq!(fingerprint(text).unwrap(), first, "unchanged file, same fingerprint");
    // Another size.
    std::fs::write(&path, "longer").unwrap();
    let second = fingerprint(text).unwrap();
    assert_ne!(second, first);
    assert_eq!(second.size, "6");
    // Same size, replaced by an atomic rename (how editors save): a new identity.
    let replacement = directory.path().join("note.tmp");
    std::fs::write(&replacement, "LONGER").unwrap();
    std::fs::rename(&replacement, &path).unwrap();
    let third = fingerprint(text).unwrap();
    assert_eq!(third.size, second.size);
    #[cfg(unix)]
    assert_ne!(third.inode, second.inode);
    assert_ne!(third, second);
    // Serialized with string numbers and camelCase names.
    let json = serde_json::to_value(&third).unwrap();
    assert!(json["modifiedNs"].is_string() && json["size"].is_string() && json["inode"].is_string() && json["device"].is_string());
    // Not files, not absolute, missing, or reached through a link.
    assert!(fingerprint(directory.path().to_str().unwrap()).is_err());
    assert!(fingerprint("note.md").is_err());
    assert!(fingerprint("").is_err());
    assert!(fingerprint(directory.path().join("missing.md").to_str().unwrap()).is_err());
    #[cfg(unix)]
    {
        let link = directory.path().join("link.md");
        std::os::unix::fs::symlink(&path, &link).unwrap();
        assert!(fingerprint(link.to_str().unwrap()).is_err());
    }
}
