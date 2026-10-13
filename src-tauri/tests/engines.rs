use notation_lib::{
    assets,
    engines::{ExportRequest, Runtime},
    storage::Database,
};
use serde_json::json;
use std::{
    fs,
    io::Read,
    path::PathBuf,
    thread,
    time::{Duration, Instant},
};
fn runtime() -> Runtime {
    let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/engines");
    assert!(
        directory.join("manifest.json").is_file(),
        "Run python scripts/bundle-engines.py to provision the pinned engine fixtures"
    );
    Runtime::new(directory, PathBuf::from(env!("CARGO_BIN_EXE_notation")))
}
fn request(id: &str, output: &std::path::Path, format: &str) -> ExportRequest {
    serde_json::from_value(json!({"id":id,"content":"<h1>Offline export</h1><p>Readable native document.</p><p>\\(x^2 + y^2\\)</p><img src=\"figure.svg\" alt=\"Diagram\">","inputFormat":"html","format":format,"outputPath":output,"title":"Notation export","assets":[{"name":"figure.svg","svg":"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"240\" height=\"80\"><rect x=\"1\" y=\"1\" width=\"238\" height=\"78\" fill=\"white\" stroke=\"black\"/><text x=\"20\" y=\"45\" font-size=\"20\">Alpha → Beta</text></svg>"}]})).unwrap()
}
#[test]
fn bundled_diagram_engines_render_actual_offline_svg() {
    let runtime = runtime();
    let status = runtime.status();
    assert!(status.available, "{:?}", status.error);
    for (engine, source, label) in [
        ("d2", "a -> b: Connected", "Connected"),
        ("plantuml", "Alice -> Bob: Hello", "Hello"),
        (
            "plantuml",
            "class Order\nclass Customer\nCustomer --> Order",
            "Order",
        ),
    ] {
        let svg = runtime
            .render_diagram(engine, source)
            .unwrap_or_else(|error| panic!("{engine}: {error}"));
        assert!(svg.contains("<svg"));
        assert!(svg.contains(label));
        assets::safe_svg(&svg).unwrap();
    }
}
#[test]
fn bundled_converters_produce_pdf_and_office_archives_with_text_math_and_images() {
    let runtime = runtime();
    let temporary = tempfile::tempdir().unwrap();
    for format in ["pdf", "docx", "pptx"] {
        let output = temporary.path().join(format!("export.{format}"));
        let result = runtime
            .export(request(format, &output, format), None)
            .unwrap_or_else(|error| panic!("{format}: {error}"));
        let bytes = fs::read(&output).unwrap();
        assert!(result.bytes > 1000);
        if format == "pdf" {
            assert!(bytes.starts_with(b"%PDF-"));
        } else {
            assert!(bytes.starts_with(b"PK"));
            let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
            assert!(archive
                .file_names()
                .map(|name| name.unwrap().into_owned())
                .any(|name| name.contains("media/") && name.ends_with(".png")));
            let names = archive
                .file_names()
                .map(|name| name.unwrap().into_owned())
                .filter(|name| name.ends_with(".xml"))
                .collect::<Vec<_>>();
            let mut content = String::new();
            for name in names {
                let mut file = archive.by_name(&name).unwrap();
                let mut text = String::new();
                file.read_to_string(&mut text).unwrap();
                content.push_str(&text);
            }
            assert!(content.contains("Readable native document"));
            assert!(content.contains("oMath") || format == "pptx");
        }
    }
}
#[test]
fn engine_failures_report_program_and_exit_status_without_stderr() {
    use notation_lib::engine_process::{run, JobSpec};
    use std::sync::{atomic::AtomicBool, Arc};
    let temporary = tempfile::tempdir().unwrap();
    for (script, expected) in [
        ("exit 7", "exit status: 7"),
        ("kill -SEGV $$", "signal: 11"),
    ] {
        let error = run(
            &PathBuf::from(env!("CARGO_BIN_EXE_notation")),
            JobSpec {
                program: "/bin/sh".into(),
                arguments: vec!["-c".into(), script.into()],
                cwd: temporary.path().into(),
                input: None,
                read_paths: vec!["/bin".into()],
                environment: Default::default(),
            },
            &Arc::new(AtomicBool::new(false)),
            Instant::now() + Duration::from_secs(5),
            1024,
        )
        .err()
        .expect("the worker should fail");
        assert!(error.contains("engine sh failed"), "{error}");
        assert!(error.contains(expected), "{error}");
        assert!(error.contains("no error output"), "{error}");
    }
}
#[test]
fn export_errors_cancel_and_invalid_destinations_preserve_original_files() {
    let runtime = runtime();
    let temporary = tempfile::tempdir().unwrap();
    let destination = temporary.path().join("existing.pdf");
    fs::write(&destination, "original export").unwrap();
    let mut invalid = request("invalid", &destination, "pdf");
    invalid.assets[0].svg =
        "<svg xmlns=\"http://www.w3.org/2000/svg\"><image href=\"file:///etc/passwd\"/></svg>"
            .into();
    assert!(runtime.export(invalid, None).is_err());
    assert_eq!(fs::read_to_string(&destination).unwrap(), "original export");
    let wrong = temporary.path().join("wrong.md");
    assert!(runtime
        .export(request("wrong", &wrong, "pdf"), None)
        .is_err());
    assert!(!wrong.exists());
    let background = runtime.clone();
    let mut large = request("cancel-job", &destination, "pdf");
    large.content = "<p>A bounded but large export paragraph.</p>".repeat(100000);
    large.assets.clear();
    let handle = thread::spawn(move || background.export(large, None));
    let began = Instant::now();
    while !runtime.cancel("cancel-job") {
        assert!(began.elapsed() < Duration::from_secs(3));
        thread::sleep(Duration::from_millis(1));
    }
    assert!(handle
        .join()
        .unwrap()
        .unwrap_err()
        .to_lowercase()
        .contains("cancel"));
    assert_eq!(fs::read_to_string(&destination).unwrap(), "original export");
}
#[test]
fn automatic_diagrams_cannot_load_user_files_or_connect_to_network() {
    let runtime = runtime();
    let temporary = tempfile::tempdir().unwrap();
    let secret = temporary.path().join("private.json");
    fs::write(&secret, "{\"secret\":\"SENTINEL_NOT_FOR_DIAGRAMS\"}").unwrap();
    let source = format!(
        "@startuml\n!$data = %load_json(\"{}\")\nAlice -> Bob: $data.secret\n@enduml",
        secret.display()
    );
    if let Ok(svg) = runtime.render_diagram("plantuml", &source) {
        assert!(!svg.contains("SENTINEL_NOT_FOR_DIAGRAMS"));
    }
    let source = format!("...@{}", secret.display());
    assert!(runtime.render_diagram("d2", &source).is_err());
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let address = listener.local_addr().unwrap();
    let source = format!("node: {{ icon: http://{address}/private.svg }}");
    assert!(runtime.render_diagram("d2", &source).is_err());
    assert!(listener.accept().is_err());
}
#[test]
fn native_citations_render_inline_references_and_local_footnote_styles() {
    let runtime = runtime();
    let source="---\nreferences:\n - id: doe2024\n   type: book\n   title: A Test Book\n   author:\n    - family: Doe\n      given: Jane\n   issued:\n     date-parts: [[2024]]\n---\nSource [@doe2024].\n";
    let output = runtime
        .citations(source, None, vec!["[@doe2024]".into()], None)
        .unwrap();
    assert_eq!(output.citations[0].raw, "[@doe2024]");
    assert!(output.citations[0].html.contains("Doe"));
    assert!(
        output
            .bibliography_html
            .to_lowercase()
            .contains("a test book"),
        "{output:?}"
    );
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("notes");
    fs::create_dir(&root).unwrap();
    let db = Database::open(&temporary.path().join("app/state.sqlite3")).unwrap();
    db.set_workspace(root.to_str().unwrap()).unwrap();
    fs::write(
        root.join("refs.bib"),
        "@book{doe2024, author={Doe, Jane}, title={A Test Book}, year={2024}}\n",
    )
    .unwrap();
    fs::write(root.join("style.csl"),"<style xmlns=\"http://purl.org/net/xbiblio/csl\" version=\"1.0\" class=\"note\"><info><title>Test notes</title><id>https://example.invalid/test-notes</id><updated>2026-01-01T00:00:00+00:00</updated></info><citation><layout suffix=\".\"><text variable=\"title\"/></layout></citation><bibliography><layout><text variable=\"title\"/></layout></bibliography></style>").unwrap();
    let source = "---\nbibliography: refs.bib\ncsl: style.csl\n---\n[@doe2024]\n";
    let output = runtime
        .citations(source, None, vec!["[@doe2024]".into()], Some(&db))
        .unwrap();
    assert!(
        output
            .bibliography_html
            .to_lowercase()
            .contains("a test book"),
        "{output:?}"
    );
    assert!(output.bibliography_html.contains("id=\"fn1\""));
    assert!(runtime
        .citations(
            "---\nbibliography: ../../outside.bib\n---\n",
            None,
            vec!["[@key]".into()],
            Some(&db)
        )
        .is_err());
}
#[test]
fn workspace_media_is_bounded_typed_and_confined_with_inert_svg() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("notes");
    fs::create_dir(&root).unwrap();
    let db = Database::open(&temporary.path().join("app/state.sqlite3")).unwrap();
    db.set_workspace(root.to_str().unwrap()).unwrap();
    fs::write(root.join("tiny.png"), b"\x89PNG\r\n\x1a\nfixture").unwrap();
    let media = assets::read(&db, "tiny.png", None).unwrap();
    assert_eq!(media.mime, "image/png");
    assert!(media.data_url.starts_with("data:image/png;base64,"));
    let large = fs::File::create(root.join("large.png")).unwrap();
    large.set_len(20 * 1024 * 1024 + 1).unwrap();
    assert!(assets::read(&db, "large.png", None).is_err());
    fs::write(root.join("fake.png"), "<html>not an image</html>").unwrap();
    assert!(assets::read(&db, "fake.png", None).is_err());
    assert!(assets::read(&db, "../app/state.sqlite3", None).is_err());
    for svg in ["<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\"><image href=\"&#104;ttps://example.com/image.png\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\"><set attributeName=\"href\" to=\"https://example.com\"/></svg>","<!DOCTYPE svg [<!ENTITY secret SYSTEM 'file:///etc/passwd'>]><svg xmlns=\"http://www.w3.org/2000/svg\">&secret;</svg>"]{assert!(assets::safe_svg(svg).is_err());}
    assets::safe_svg("<svg xmlns=\"http://www.w3.org/2000/svg\"><text>@import is literal label text</text></svg>").unwrap();
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(
            temporary.path().join("app/state.sqlite3"),
            root.join("escape.pdf"),
        )
        .unwrap();
        assert!(assets::read(&db, "escape.pdf", None).is_err());
    }
}

#[test]
fn runtime_resource_discovery_supports_product_and_executable_appdir_names() {
    let temporary = tempfile::tempdir().unwrap();
    let appdir = temporary.path().join("Notation.AppDir");
    let upper = appdir.join("usr/lib/Notation/engines");
    let lower = appdir.join("usr/lib/notation/engines");
    fs::create_dir_all(&upper).unwrap();
    fs::write(upper.join("manifest.json"), "{}").unwrap();
    assert_eq!(
        Runtime::resource_directory(None, Some(&appdir), None),
        upper
    );
    fs::create_dir_all(&lower).unwrap();
    fs::write(lower.join("manifest.json"), "{}").unwrap();
    assert_eq!(
        Runtime::resource_directory(None, Some(&appdir), None),
        upper
    );
    assert_eq!(
        Runtime::resource_directory(lower.parent(), Some(&appdir), None),
        lower
    );
    fs::remove_file(upper.join("manifest.json")).unwrap();
    assert_eq!(
        Runtime::resource_directory(None, Some(&appdir), None),
        lower
    );
    fs::remove_file(lower.join("manifest.json")).unwrap();
    let development = temporary.path().join("development/engines");
    fs::create_dir_all(&development).unwrap();
    fs::write(development.join("manifest.json"), "{}").unwrap();
    assert_eq!(
        Runtime::resource_directory(None, None, Some(&development)),
        development
    );
    assert_ne!(
        Runtime::resource_directory(None, Some(&appdir), None),
        development
    );
}
