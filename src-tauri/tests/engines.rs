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
#[cfg_attr(not(target_os = "linux"), ignore = "bundled engines run only inside the Linux sandbox")]
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
#[cfg_attr(not(target_os = "linux"), ignore = "bundled engines run only inside the Linux sandbox")]
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
#[cfg_attr(not(target_os = "linux"), ignore = "bundled engines run only inside the Linux sandbox")]
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
#[cfg_attr(not(target_os = "linux"), ignore = "bundled engines run only inside the Linux sandbox")]
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
#[cfg_attr(not(target_os = "linux"), ignore = "bundled engines run only inside the Linux sandbox")]
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
#[cfg_attr(not(target_os = "linux"), ignore = "bundled engines run only inside the Linux sandbox")]
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
#[cfg_attr(not(target_os = "linux"), ignore = "AppDir layouts are Linux-only and need a case-sensitive volume")]
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

#[test]
fn status_tells_an_unsupported_platform_from_a_damaged_install() {
    let empty = tempfile::tempdir().unwrap();
    let status = Runtime::new(empty.path().to_path_buf(), PathBuf::from(env!("CARGO_BIN_EXE_notation"))).status();
    assert!(!status.available);
    assert_eq!(status.platform_supported, cfg!(target_os = "linux"));
    let error = status.error.clone().expect("an explanation");
    if cfg!(target_os = "linux") {
        // Engines can run here, so missing files are an installation problem.
        assert!(error.contains("incomplete") || error.contains("Landlock"), "{error}");
    } else {
        assert!(error.contains("Not available on"), "{error}");
        assert!(!error.to_lowercase().contains("reinstall") && !error.contains("Rebuild"), "{error}");
    }
    let json = serde_json::to_value(&status).unwrap();
    assert_eq!(json["platformSupported"], cfg!(target_os = "linux"));
}

#[test]
fn unchanged_media_is_confirmed_without_reading_and_changes_are_reloaded() {
    use notation_lib::assets::{read_if_changed, AssetResponse};
    use std::time::{Duration, SystemTime};
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("notes");
    fs::create_dir(&root).unwrap();
    let db = Database::open(&temporary.path().join("app/state.sqlite3")).unwrap();
    db.set_workspace(root.to_str().unwrap()).unwrap();
    let image = root.join("image.png");
    let age = |path: &std::path::Path, seconds: u64| {
        fs::File::options().write(true).open(path).unwrap()
            .set_modified(SystemTime::now() - Duration::from_secs(seconds)).unwrap();
    };
    fs::write(&image, b"\x89PNG\r\n\x1a\nfirst").unwrap();
    age(&image, 60);
    let first = assets::read(&db, "image.png", None).unwrap();
    assert!(!first.fingerprint.is_empty());
    // The caller's copy is current: no data comes back.
    match read_if_changed(&db, "image.png", None, Some(&first.fingerprint)).unwrap() {
        AssetResponse::Unchanged { unchanged, fingerprint } => {
            assert!(unchanged);
            assert_eq!(fingerprint, first.fingerprint);
        }
        AssetResponse::Asset(_) => panic!("an unchanged file must not be re-sent"),
    }
    let json = serde_json::to_value(read_if_changed(&db, "image.png", None, Some(&first.fingerprint)).unwrap()).unwrap();
    assert_eq!(json, json!({"unchanged": true, "fingerprint": first.fingerprint}));
    // No or another fingerprint: the asset itself.
    for known in [None, Some("0:0:0:0"), Some("")] {
        match read_if_changed(&db, "image.png", None, known).unwrap() {
            AssetResponse::Asset(asset) => assert_eq!(asset.data_url, first.data_url),
            AssetResponse::Unchanged { .. } => panic!("unknown fingerprint"),
        }
    }
    // Changed content (same length) is re-sent with a new fingerprint.
    fs::write(&image, b"\x89PNG\r\n\x1a\nother").unwrap();
    age(&image, 30);
    let second = match read_if_changed(&db, "image.png", None, Some(&first.fingerprint)).unwrap() {
        AssetResponse::Asset(asset) => asset,
        AssetResponse::Unchanged { .. } => panic!("a changed file must be re-sent"),
    };
    assert_ne!(second.fingerprint, first.fingerprint);
    assert_ne!(second.data_url, first.data_url);
    // A file modified a moment ago is not trusted to be unchanged yet.
    fs::write(&image, b"\x89PNG\r\n\x1a\nfresh").unwrap();
    let fresh = assets::read(&db, "image.png", None).unwrap();
    assert!(matches!(read_if_changed(&db, "image.png", None, Some(&fresh.fingerprint)).unwrap(), AssetResponse::Asset(_)));
    // Knowing a fingerprint opens nothing: checks run before it is compared.
    fs::write(temporary.path().join("outside.png"), b"\x89PNG\r\n\x1a\nsecret").unwrap();
    age(&temporary.path().join("outside.png"), 60);
    assert!(read_if_changed(&db, "../outside.png", None, Some(&first.fingerprint)).is_err());
    assert!(read_if_changed(&db, "missing.png", None, Some(&first.fingerprint)).is_err());
    fs::write(root.join("fake.png"), "<html>not an image</html>").unwrap();
    age(&root.join("fake.png"), 60);
    assert!(read_if_changed(&db, "fake.png", None, Some("1:2:3:4")).is_err());
}
/// Converter input as the frontend sends it for a note that mixes Typst and
/// LaTeX math: Typst equations are marker spans, LaTeX is `\(…\)`.
fn math_request(id: &str, output: &std::path::Path, format: &str, extra: &str) -> ExportRequest {
    let picture = "<svg xmlns='http://www.w3.org/2000/svg' width='80' height='40' viewBox='0 0 20 10'><path d='M1 1h18v8H1z' fill='#000000'/></svg>";
    let marker = |source: &str, display: bool| {
        format!(
            "<span class=\"notation-typst-math\" data-typst=\"{}\" data-display=\"{}\" data-width=\"20\" data-height=\"10\" data-svg=\"{picture}\"></span>",
            source.replace('&', "&amp;").replace('"', "&quot;"),
            u8::from(display)
        )
    };
    let content = format!(
        "<h1>Mixed math</h1><p>Typst {} and LaTeX \\(\\frac{{a}}{{b}}\\) inline.</p><p>{}</p><p>Text {} end.</p>{extra}",
        marker("sum_(i=1)^n x_i", false),
        marker("integral_0^oo e^(-x^2) dif x = sqrt(pi)/2", true),
        marker("\"speed\" = d/t", false),
    );
    let extra_marker = extra
        .replace("{unreadable}", &marker("x + #text(fill: gradient.linear(red, blue))[y]", false))
        .replace("{empty}", &marker("#line(length: 1em)", false));
    let content = content.replace(extra, &extra_marker);
    serde_json::from_value(json!({"id":id,"content":content,"inputFormat":"html","format":format,"outputPath":output,"title":"Mixed math"})).unwrap()
}
fn office_xml(bytes: Vec<u8>) -> (String, Vec<String>) {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    let names = archive
        .file_names()
        .map(|name| name.unwrap().into_owned())
        .collect::<Vec<_>>();
    let mut content = String::new();
    for name in names.iter().filter(|name| name.ends_with(".xml")) {
        let mut text = String::new();
        archive
            .by_name(name)
            .unwrap()
            .read_to_string(&mut text)
            .unwrap();
        content.push_str(&text);
    }
    (content, names)
}
#[test]
#[cfg_attr(not(target_os = "linux"), ignore = "bundled engines run only inside the Linux sandbox")]
fn typst_equations_are_typeset_by_the_pdf_engine_and_become_office_equations() {
    let runtime = runtime();
    let temporary = tempfile::tempdir().unwrap();
    let pdf = temporary.path().join("math.pdf");
    let result = runtime
        .export(math_request("math-pdf", &pdf, "pdf", ""), None)
        .unwrap_or_else(|error| panic!("pdf: {error}"));
    assert_eq!(result.warning, None);
    let bytes = fs::read(&pdf).unwrap();
    assert!(bytes.starts_with(b"%PDF-"));
    // Equations are text set in a font, not pictures: the document has no
    // image at all, and the marker never reaches the output.
    let text = String::from_utf8_lossy(&bytes);
    assert!(!text.contains("/Subtype /Image") && !text.contains("/Subtype/Image"));
    assert!(!text.contains("notation-typst-math"));

    for format in ["docx", "pptx"] {
        let output = temporary.path().join(format!("math.{format}"));
        let result = runtime
            .export(math_request(format, &output, format, ""), None)
            .unwrap_or_else(|error| panic!("{format}: {error}"));
        assert_eq!(result.warning, None, "{format}");
        let (content, names) = office_xml(fs::read(&output).unwrap());
        // Three Typst equations and one LaTeX equation, all native. Slides
        // wrap each equation in an `a14:m` element.
        let native = if format == "docx" { "<m:oMath>" } else { "<a14:m>" };
        assert!(content.matches(native).count() >= 4, "{format}");
        assert!(content.contains("<m:nary>") || content.contains("∑"), "{format}");
        assert!(content.contains("speed"), "{format}");
        assert!(!content.contains("notation-typst-math"), "{format}");
        assert!(
            !names.iter().any(|name| name.contains("media/") && name.ends_with(".png")),
            "{format}: no equation was rasterized"
        );
    }
}
#[test]
#[cfg_attr(not(target_os = "linux"), ignore = "bundled engines run only inside the Linux sandbox")]
fn an_equation_office_cannot_represent_is_embedded_as_an_image_and_reported() {
    let runtime = runtime();
    let temporary = tempfile::tempdir().unwrap();
    let output = temporary.path().join("fallback.docx");
    // Valid Typst that Pandoc's Typst reader rejects (a gradient fill) or
    // reads as nothing (a drawn line). Their neighbours must still become
    // equations.
    let extra = "<p>Odd {unreadable} one and {empty} another.</p>";
    let result = runtime
        .export(math_request("fallback", &output, "docx", extra), None)
        .unwrap_or_else(|error| panic!("docx: {error}"));
    let warning = result.warning.expect("the fallback is reported");
    assert!(warning.contains("2 Typst equation(s) could not be converted"), "{warning}");
    assert!(warning.contains("2 embedded as images, 0 as source text"), "{warning}");
    let (content, names) = office_xml(fs::read(&output).unwrap());
    assert!(content.matches("<m:oMath>").count() >= 4);
    assert_eq!(
        names
            .iter()
            .filter(|name| name.contains("media/") && name.ends_with(".png"))
            .count(),
        2
    );
    // Slides cannot hold a picture inside a sentence, so they get the source.
    let slides = temporary.path().join("fallback.pptx");
    let result = runtime
        .export(math_request("fallback-pptx", &slides, "pptx", extra), None)
        .unwrap_or_else(|error| panic!("pptx: {error}"));
    let warning = result.warning.expect("the fallback is reported");
    assert!(warning.contains("0 embedded as images, 2 as source text"), "{warning}");
    let (content, _) = office_xml(fs::read(&slides).unwrap());
    assert!(content.contains("gradient.linear(red, blue)"));
    assert!(content.matches("<a14:m>").count() >= 4);
    // The same note as PDF needs no fallback: Typst reads its own syntax.
    let pdf = temporary.path().join("fallback.pdf");
    let result = runtime
        .export(math_request("fallback-pdf", &pdf, "pdf", extra), None)
        .unwrap_or_else(|error| panic!("pdf: {error}"));
    assert_eq!(result.warning, None);
}
#[test]
#[cfg_attr(not(target_os = "linux"), ignore = "bundled engines run only inside the Linux sandbox")]
fn equation_sources_that_would_escape_the_equation_are_rejected() {
    let runtime = runtime();
    let temporary = tempfile::tempdir().unwrap();
    for format in ["pdf", "docx"] {
        let output = temporary.path().join(format!("escape.{format}"));
        let mut request = math_request("escape", &output, format, "");
        request.content = request
            .content
            .replace("sum_(i=1)^n x_i", "x$ #read(&quot;input&quot;) $y");
        let error = runtime.export(request, None).unwrap_err();
        assert!(error.contains("unescaped $"), "{format}: {error}");
        assert!(!output.exists());
    }
}
#[test]
#[cfg_attr(not(target_os = "linux"), ignore = "bundled engines run only inside the Linux sandbox")]
fn typst_code_in_an_exported_equation_stays_inside_the_engine_sandbox() {
    // An equation is the first user-written Typst the PDF engine runs. It can
    // compute, but it cannot read the user's files or fetch a package.
    let runtime = runtime();
    let temporary = tempfile::tempdir().unwrap();
    let secret = temporary.path().join("secret.txt");
    fs::write(&secret, "private").unwrap();
    for (source, expected) in [
        (format!("#read(&quot;{}&quot;)", secret.display()), "typst failed"),
        ("#read(&quot;/etc/hostname&quot;)".to_string(), "typst failed"),
        (
            "#{ import &quot;@preview/cetz:0.3.4&quot;: canvas }".to_string(),
            "typst failed",
        ),
    ] {
        let output = temporary.path().join("confined.pdf");
        let mut request = math_request("confined", &output, "pdf", "");
        request.content = request.content.replace("sum_(i=1)^n x_i", &source);
        let error = runtime.export(request, None).unwrap_err();
        assert!(error.contains(expected), "{source}: {error}");
        assert!(!error.contains("private"), "{error}");
        assert!(!output.exists());
    }
    // Computation is fine.
    let output = temporary.path().join("computed.pdf");
    let mut request = math_request("computed", &output, "pdf", "");
    request.content = request
        .content
        .replace("sum_(i=1)^n x_i", "#calc.pow(2, 10) + #range(4).sum()");
    runtime.export(request, None).unwrap();
    assert!(fs::read(&output).unwrap().starts_with(b"%PDF-"));
}
