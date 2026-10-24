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
