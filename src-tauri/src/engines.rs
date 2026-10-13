//! Offline bundled render/conversion engines. Automatic rendering is isolated
//! from user files/network; explicit export atomically publishes only a finished artifact.
use crate::{
    assets,
    engine_process::{self, JobSpec},
    explorer, frontmatter,
    storage::Database,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering},
        Arc, Condvar, Mutex,
    },
    time::{Duration, Instant},
};
#[derive(Clone)]
pub struct Runtime {
    pub directory: PathBuf,
    worker: PathBuf,
    registry: Arc<Registry>,
    sequence: Arc<AtomicU64>,
}
#[derive(Default)]
struct Registry {
    active: Mutex<HashMap<String, Control>>,
    slots: Mutex<usize>,
    changed: Condvar,
}
#[derive(Clone)]
struct Control {
    cancel: Arc<AtomicBool>,
    phase: Arc<AtomicU8>,
}
struct Ticket {
    id: String,
    cancel: Arc<AtomicBool>,
    phase: Arc<AtomicU8>,
    registry: Arc<Registry>,
}
impl Drop for Ticket {
    fn drop(&mut self) {
        self.registry.active.lock().unwrap().remove(&self.id);
    }
}
struct Slot(Arc<Registry>);
struct EngineIo {
    input: Option<PathBuf>,
    limit: usize,
}
impl Drop for Slot {
    fn drop(&mut self) {
        *self.0.slots.lock().unwrap() -= 1;
        self.0.changed.notify_all();
    }
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub available: bool,
    pub engines: HashMap<String, bool>,
    pub resource_dir: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}
#[derive(Debug, Deserialize, Serialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum Format {
    Pdf,
    Docx,
    Pptx,
}
impl Format {
    fn extension(self) -> &'static str {
        match self {
            Self::Pdf => "pdf",
            Self::Docx => "docx",
            Self::Pptx => "pptx",
        }
    }
}
#[derive(Debug, Default, Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum InputFormat {
    #[default]
    Markdown,
    Html,
}
#[derive(Debug, Deserialize)]
pub struct SvgAsset {
    pub name: String,
    pub svg: String,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
    pub id: String,
    pub content: String,
    #[serde(default)]
    pub input_format: InputFormat,
    pub format: Format,
    pub output_path: String,
    pub source_path: Option<String>,
    #[serde(default)]
    pub assets: Vec<SvgAsset>,
    pub title: Option<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub id: String,
    pub path: String,
    pub format: Format,
    pub bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}
#[derive(Debug, Serialize)]
pub struct Citation {
    pub raw: String,
    pub html: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Citations {
    pub citations: Vec<Citation>,
    pub bibliography_html: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}
impl Runtime {
    pub fn new(directory: PathBuf, worker: PathBuf) -> Self {
        Self {
            directory,
            worker,
            registry: Arc::default(),
            sequence: Arc::new(AtomicU64::new(0)),
        }
    }
    pub fn discover(resource: Option<PathBuf>) -> Self {
        let appdir = std::env::var_os("APPDIR").map(PathBuf::from);
        #[cfg(debug_assertions)]
        let development = Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/engines"));
        #[cfg(not(debug_assertions))]
        let development: Option<PathBuf> = None;
        let directory = Self::resource_directory(
            resource.as_deref(),
            appdir.as_deref(),
            development.as_deref(),
        );
        Self::new(
            directory,
            std::env::current_exe().unwrap_or_else(|_| PathBuf::from("notation")),
        )
    }
    pub fn resource_directory(
        resource: Option<&Path>,
        appdir: Option<&Path>,
        development: Option<&Path>,
    ) -> PathBuf {
        let mut directories = Vec::new();
        if let Some(resource) = resource {
            directories.push(resource.join("engines"));
        }
        if let Some(appdir) = appdir {
            directories.push(appdir.join("usr/lib/Notation/engines"));
            directories.push(appdir.join("usr/lib/notation/engines"));
        }
        if let Some(development) = development {
            directories.push(development.to_path_buf());
        }
        directories
            .iter()
            .find(|path| path.join("manifest.json").is_file())
            .cloned()
            .unwrap_or_else(|| {
                directories
                    .first()
                    .cloned()
                    .unwrap_or_else(|| PathBuf::from("engines"))
            })
    }
    pub fn status(&self) -> Status {
        let mut engines = HashMap::new();
        for name in ["pandoc", "typst", "d2"] {
            engines.insert(name.into(), self.directory.join("bin").join(name).is_file());
        }
        engines.insert(
            "plantuml".into(),
            self.directory.join("plantuml.jar").is_file()
                && self.directory.join("jre/bin/java").is_file(),
        );
        let available =
            engines.values().all(|available| *available) && engine_process::sandbox_available();
        let error = if !engine_process::sandbox_available() {
            Some("Native engines require Linux with the Landlock filesystem sandbox enabled (ABI 3 or newer).".into())
        } else if !engines.values().all(|available| *available) {
            Some("Bundled engines are incomplete. Rebuild the application with scripts/bundle-engines.py.".into())
        } else {
            None
        };
        Status {
            available,
            engines,
            resource_dir: self.directory.to_string_lossy().into(),
            error,
        }
    }
    pub fn cancel(&self, id: &str) -> bool {
        self.registry
            .active
            .lock()
            .unwrap()
            .get(id)
            .is_some_and(|control| {
                if control
                    .phase
                    .compare_exchange(0, 1, Ordering::SeqCst, Ordering::SeqCst)
                    .is_err()
                {
                    return false;
                }
                control.cancel.store(true, Ordering::SeqCst);
                self.registry.changed.notify_all();
                true
            })
    }
    fn ticket(&self, id: String) -> Result<Ticket, String> {
        if id.is_empty() || id.len() > 128 {
            return Err("Native job needs an ID of 1–128 characters.".into());
        }
        let mut active = self.registry.active.lock().unwrap();
        if active.contains_key(&id) {
            return Err("This native job is already running.".into());
        }
        if active.len() >= 64 {
            return Err("Too many native jobs are queued.".into());
        }
        let cancel = Arc::new(AtomicBool::new(false));
        let phase = Arc::new(AtomicU8::new(0));
        active.insert(
            id.clone(),
            Control {
                cancel: cancel.clone(),
                phase: phase.clone(),
            },
        );
        Ok(Ticket {
            id,
            cancel,
            phase,
            registry: self.registry.clone(),
        })
    }
    fn slot(&self, ticket: &Ticket, deadline: Instant) -> Result<Slot, String> {
        let mut slots = self.registry.slots.lock().unwrap();
        loop {
            check(ticket, deadline)?;
            if *slots < 2 {
                *slots += 1;
                return Ok(Slot(self.registry.clone()));
            }
            slots = self
                .registry
                .changed
                .wait_timeout(slots, Duration::from_millis(50))
                .unwrap()
                .0;
        }
    }
    fn environment(&self, temp: &Path) -> HashMap<String, String> {
        let mut environment = HashMap::from([
            ("HOME".into(), temp.to_string_lossy().into_owned()),
            ("TMPDIR".into(), temp.to_string_lossy().into_owned()),
            (
                "XDG_CACHE_HOME".into(),
                temp.join("cache").to_string_lossy().into_owned(),
            ),
            (
                "XDG_CONFIG_HOME".into(),
                temp.join("config").to_string_lossy().into_owned(),
            ),
            (
                "PATH".into(),
                self.directory.join("bin").to_string_lossy().into_owned(),
            ),
            ("LANG".into(), "C.UTF-8".into()),
            (
                "FONTCONFIG_FILE".into(),
                temp.join("fonts.conf").to_string_lossy().into_owned(),
            ),
            (
                "JAVA_HOME".into(),
                self.directory.join("jre").to_string_lossy().into_owned(),
            ),
        ]);
        let mut library = vec![
            self.directory
                .join("jre/lib")
                .to_string_lossy()
                .into_owned(),
            self.directory
                .join("jre/lib/server")
                .to_string_lossy()
                .into_owned(),
        ];
        if let Some(existing) = std::env::var_os("LD_LIBRARY_PATH") {
            library.push(existing.to_string_lossy().into_owned());
        }
        environment.insert("LD_LIBRARY_PATH".into(), library.join(":"));
        environment
    }
    fn run(
        &self,
        ticket: &Ticket,
        temp: &Path,
        program: &str,
        arguments: Vec<String>,
        io: EngineIo,
        deadline: Instant,
    ) -> Result<engine_process::Output, String> {
        let EngineIo { input, limit } = io;
        let _slot = self.slot(ticket, deadline)?;
        let program = self.directory.join(program);
        if !program.is_file() {
            return Err(format!("Bundled engine {} is missing.", program.display()));
        }
        let font_config = format!(
            "<?xml version=\"1.0\"?><fontconfig><dir>{}</dir><cachedir>{}</cachedir></fontconfig>",
            xml_escape(&self.directory.join("fonts").to_string_lossy()),
            xml_escape(&temp.join("font-cache").to_string_lossy())
        );
        fs::write(temp.join("fonts.conf"), font_config).map_err(|error| error.to_string())?;
        let mut read_paths = vec![self.directory.clone()];
        if let Some(appdir) = std::env::var_os("APPDIR") {
            let libs = PathBuf::from(appdir).join("usr/lib");
            if libs.is_dir() {
                read_paths.push(libs);
            }
        }
        let output = engine_process::run(
            &self.worker,
            JobSpec {
                program,
                arguments,
                cwd: temp.to_path_buf(),
                input,
                read_paths,
                environment: self.environment(temp),
            },
            &ticket.cancel,
            deadline,
            limit,
        )?;
        check(ticket, deadline)?;
        Ok(output)
    }
    pub fn render_diagram(&self, engine: &str, source: &str) -> Result<String, String> {
        if source.len() > 128 * 1024 {
            return Err("Native diagram source exceeds 128 KiB.".into());
        }
        let id = format!("diagram:{}", self.sequence.fetch_add(1, Ordering::SeqCst));
        let ticket = self.ticket(id)?;
        let deadline = Instant::now() + Duration::from_secs(20);
        let temp = tempfile::tempdir().map_err(|error| error.to_string())?;
        let svg = match engine {
            "plantuml" => {
                let source = if source.contains("@start") {
                    source.to_string()
                } else {
                    format!("@startuml\n{source}\n@enduml\n")
                };
                let path = temp.path().join("input.puml");
                fs::write(&path, source).map_err(|error| error.to_string())?;
                let arguments = vec![
                    "-Xms16m".into(),
                    "-Xmx256m".into(),
                    "-XX:CompressedClassSpaceSize=64m".into(),
                    "-XX:ReservedCodeCacheSize=64m".into(),
                    "-XX:MaxMetaspaceSize=128m".into(),
                    "-Djava.awt.headless=true".into(),
                    "-DPLANTUML_SECURITY_PROFILE=SANDBOX".into(),
                    format!(
                        "-Dsun.java2d.fontpath={}",
                        self.directory.join("fonts").display()
                    ),
                    "-jar".into(),
                    self.directory
                        .join("plantuml.jar")
                        .to_string_lossy()
                        .into_owned(),
                    "-charset".into(),
                    "UTF-8".into(),
                    "-Playout=smetana".into(),
                    "-failfast2".into(),
                    "-pipe".into(),
                    "-tsvg".into(),
                ];
                let output = self.run(
                    &ticket,
                    temp.path(),
                    "jre/bin/java",
                    arguments,
                    EngineIo {
                        input: Some(path),
                        limit: 4 * 1024 * 1024,
                    },
                    deadline,
                )?;
                String::from_utf8(output.stdout).map_err(|_| "PlantUML returned non-UTF-8 SVG.")?
            }
            "d2" => {
                fs::write(temp.path().join("input.d2"), source)
                    .map_err(|error| error.to_string())?;
                self.run(
                    &ticket,
                    temp.path(),
                    "bin/d2",
                    vec![
                        "--layout=dagre".into(),
                        "--bundle=true".into(),
                        "input.d2".into(),
                        "output.svg".into(),
                    ],
                    EngineIo {
                        input: None,
                        limit: 64 * 1024,
                    },
                    deadline,
                )?;
                read_bounded(&temp.path().join("output.svg"), 4 * 1024 * 1024).and_then(
                    |bytes| {
                        String::from_utf8(bytes).map_err(|_| "D2 returned non-UTF-8 SVG.".into())
                    },
                )?
            }
            _ => return Err("Unsupported native diagram engine.".into()),
        };
        assets::safe_svg(&svg)?;
        Ok(svg)
    }
    pub fn export(
        &self,
        request: ExportRequest,
        database: Option<&Database>,
    ) -> Result<ExportResult, String> {
        let limit = match request.input_format {
            InputFormat::Markdown => 4 * 1024 * 1024,
            InputFormat::Html => 32 * 1024 * 1024,
        };
        if request.content.len() > limit {
            return Err("Export input exceeds its bounded document size limit.".into());
        }
        if request.assets.len() > 100
            || request
                .assets
                .iter()
                .map(|asset| asset.svg.len())
                .sum::<usize>()
                > 32 * 1024 * 1024
        {
            return Err("Export diagram assets exceed 100 assets / 32 MiB.".into());
        }
        let destination = validate_destination(
            &request.output_path,
            request.source_path.as_deref(),
            request.format,
        )?;
        let ticket = self.ticket(request.id.clone())?;
        let deadline = Instant::now() + Duration::from_secs(60);
        let temp = tempfile::tempdir().map_err(|error| error.to_string())?;
        let mut supplied = HashMap::new();
        for asset in request.assets {
            check(&ticket, deadline)?;
            if asset.name.len() > 128
                || !asset.name.ends_with(".svg")
                || !asset.name.chars().all(|character| {
                    character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')
                })
                || asset.name.starts_with('.')
                || asset.svg.len() > 4 * 1024 * 1024
            {
                return Err("Invalid or oversized SVG export asset name/content.".into());
            }
            assets::safe_svg(&asset.svg)?;
            fs::write(temp.path().join(&asset.name), &asset.svg)
                .map_err(|error| error.to_string())?;
            supplied.insert(asset.name, asset.svg);
        }
        let source = temp.path().join("input");
        fs::write(&source, &request.content).map_err(|error| error.to_string())?;
        let from = match request.input_format {
            InputFormat::Markdown => "markdown",
            InputFormat::Html => "html+tex_math_single_backslash",
        };
        let parsed = self.run(
            &ticket,
            temp.path(),
            "bin/pandoc",
            vec![
                "--from".into(),
                from.into(),
                "--to=json".into(),
                "input".into(),
            ],
            EngineIo {
                input: None,
                limit: 64 * 1024 * 1024,
            },
            deadline,
        )?;
        let mut ast: Value = serde_json::from_slice(&parsed.stdout)
            .map_err(|error| format!("Pandoc returned invalid document structure: {error}"))?;
        let mut media = MediaPreparation {
            runtime: self,
            database,
            source: request.source_path.as_deref(),
            temp: temp.path(),
            format: request.format,
            supplied: &supplied,
            count: 0,
            total: 0,
        };
        walk_images(&mut ast, &mut media)?;
        if let Some(title) = request.title {
            if title.len() > 512 {
                return Err("Export title exceeds 512 bytes.".into());
            }
            ast["meta"]["title"] = json!({"t":"MetaString","c":title});
        }
        // Local bibliography/CSL paths are copied and rewritten; all other file
        // reads remain confined to temp/resources by the OS worker sandbox.
        prepare_ast_citations(
            &mut ast,
            &request.content,
            request.input_format,
            database,
            request.source_path.as_deref(),
            temp.path(),
        )?;
        fs::write(
            temp.path().join("document.json"),
            serde_json::to_vec(&ast).map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;
        let output_name = format!("output.{}", request.format.extension());
        let mut warnings = Vec::new();
        let mut arguments = vec![
            "--from=json".into(),
            "document.json".into(),
            "--standalone".into(),
            "--resource-path=.".into(),
        ];
        if matches!(request.input_format, InputFormat::Markdown) {
            arguments.push("--citeproc".into());
        }
        if matches!(request.format, Format::Pdf) {
            arguments.extend(["--to=typst".into(), "--output=document.typ".into()]);
            let output = self.run(
                &ticket,
                temp.path(),
                "bin/pandoc",
                arguments,
                EngineIo {
                    input: None,
                    limit: 64 * 1024,
                },
                deadline,
            )?;
            if !output.stderr.trim().is_empty() {
                warnings.push(output.stderr);
            }
            let output = self.run(
                &ticket,
                temp.path(),
                "bin/typst",
                vec![
                    "compile".into(),
                    "--root".into(),
                    temp.path().to_string_lossy().into_owned(),
                    "--ignore-system-fonts".into(),
                    "--font-path".into(),
                    self.directory.join("fonts").to_string_lossy().into_owned(),
                    "document.typ".into(),
                    output_name.clone(),
                ],
                EngineIo {
                    input: None,
                    limit: 64 * 1024,
                },
                deadline,
            )?;
            if !output.stderr.trim().is_empty() {
                warnings.push(output.stderr);
            }
        } else {
            arguments.extend([
                format!("--to={}", request.format.extension()),
                format!("--output={output_name}"),
            ]);
            let output = self.run(
                &ticket,
                temp.path(),
                "bin/pandoc",
                arguments,
                EngineIo {
                    input: None,
                    limit: 64 * 1024,
                },
                deadline,
            )?;
            if !output.stderr.trim().is_empty() {
                warnings.push(output.stderr);
            }
        }
        let output = read_bounded(&temp.path().join(output_name), 64 * 1024 * 1024)?;
        check(&ticket, deadline)?;
        publish(&destination, &output, &ticket, deadline)?;
        Ok(ExportResult {
            id: request.id,
            path: destination.to_string_lossy().into_owned(),
            format: request.format,
            bytes: output.len() as u64,
            warning: (!warnings.is_empty())
                .then(|| warnings.join("\n").chars().take(8192).collect()),
        })
    }
    pub fn citations(
        &self,
        content: &str,
        source: Option<&str>,
        groups: Vec<String>,
        database: Option<&Database>,
    ) -> Result<Citations, String> {
        if content.len() > 4 * 1024 * 1024 {
            return Err("Citation source exceeds 4 MiB.".into());
        }
        let mut seen = HashSet::new();
        let groups = groups
            .into_iter()
            .filter(|group| seen.insert(group.clone()))
            .collect::<Vec<_>>();
        if groups.len() > 100
            || groups
                .iter()
                .any(|group| group.len() > 2048 || !group.starts_with('[') || !group.ends_with(']'))
        {
            return Err(
                "Citation preview supports 100 unique bracketed groups of at most 2 KiB each."
                    .into(),
            );
        }
        let ticket = self.ticket(format!(
            "citations:{}",
            self.sequence.fetch_add(1, Ordering::SeqCst)
        ))?;
        let deadline = Instant::now() + Duration::from_secs(20);
        let temp = tempfile::tempdir().map_err(|error| error.to_string())?;
        let metadata = prepare_citation_metadata(content, database, source, temp.path())?;
        fs::write(temp.path().join("metadata.json"), metadata.to_string())
            .map_err(|error| error.to_string())?;
        fs::write(
            temp.path().join("citations.md"),
            groups
                .iter()
                .map(|group| group.replace(['\r', '\n'], " "))
                .collect::<Vec<_>>()
                .join("\n\n"),
        )
        .map_err(|error| error.to_string())?;
        let output = self.run(
            &ticket,
            temp.path(),
            "bin/pandoc",
            vec![
                "--from=markdown".into(),
                "--to=html5".into(),
                "--citeproc".into(),
                "--metadata-file=metadata.json".into(),
                "citations.md".into(),
            ],
            EngineIo {
                input: None,
                limit: 4 * 1024 * 1024,
            },
            deadline,
        )?;
        let html = String::from_utf8(output.stdout)
            .map_err(|_| "Pandoc returned non-UTF-8 citation HTML.")?;
        let wrapped = format!("<root>{html}</root>");
        let document = roxmltree::Document::parse(&wrapped)
            .map_err(|error| format!("Citation HTML could not be read: {error}"))?;
        let mut rendered = Vec::new();
        let mut bibliography = String::new();
        for node in document
            .root_element()
            .children()
            .filter(|node| node.is_element())
        {
            if node.attribute("id") == Some("refs")
                || node.attribute("class").is_some_and(|classes| {
                    classes.split_whitespace().any(|class| class == "footnotes")
                })
            {
                bibliography.push_str(&wrapped[node.range()]);
            } else if node.tag_name().name() == "p" {
                rendered.push(wrapped[node.range()].to_string());
            }
        }
        if rendered.len() != groups.len() {
            return Err("Citation engine returned an unexpected number of citation groups.".into());
        }
        Ok(Citations {
            citations: groups
                .into_iter()
                .zip(rendered)
                .map(|(raw, html)| Citation { raw, html })
                .collect(),
            bibliography_html: bibliography,
            error: (!output.stderr.trim().is_empty())
                .then(|| output.stderr.chars().take(8192).collect()),
        })
    }
}
fn check(ticket: &Ticket, deadline: Instant) -> Result<(), String> {
    if ticket.cancel.load(Ordering::SeqCst) {
        Err("Export cancelled. The destination was kept unchanged.".into())
    } else if Instant::now() >= deadline {
        Err("Native engine exceeded its time limit.".into())
    } else {
        Ok(())
    }
}
fn xml_escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}
fn read_bounded(path: &Path, limit: usize) -> Result<Vec<u8>, String> {
    use std::io::Read;
    let file = fs::File::open(path)
        .map_err(|error| format!("Expected engine output is missing: {error}"))?;
    let mut bytes = Vec::new();
    file.take((limit + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() > limit {
        return Err("Native engine output exceeds its size limit.".into());
    }
    if bytes.is_empty() {
        return Err("Native engine returned an empty artifact.".into());
    }
    Ok(bytes)
}
fn validate_destination(
    output: &str,
    source: Option<&str>,
    format: Format,
) -> Result<PathBuf, String> {
    if output.trim().is_empty() {
        return Err("Choose an export destination.".into());
    }
    let path = Path::new(output);
    if path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
        != Some(format.extension())
    {
        return Err(format!("Choose a .{} export filename.", format.extension()));
    }
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if !metadata.is_file() || metadata.is_symlink() || metadata.permissions().readonly() {
            return Err(
                "Export destination must be a writable regular file, not a symbolic link.".into(),
            );
        }
    }
    let resolved = PathBuf::from(crate::documents::resolve_document_path(output)?);
    if source
        .and_then(|source| Path::new(source).canonicalize().ok())
        .is_some_and(|source| source == resolved)
    {
        return Err("Export cannot overwrite the source document.".into());
    }
    Ok(resolved)
}
fn publish(
    destination: &Path,
    bytes: &[u8],
    ticket: &Ticket,
    deadline: Instant,
) -> Result<(), String> {
    let parent = destination
        .parent()
        .ok_or("Export destination has no parent directory.")?;
    let mut staged = tempfile::NamedTempFile::new_in(parent).map_err(|error| error.to_string())?;
    staged.write_all(bytes).map_err(|error| error.to_string())?;
    if let Ok(metadata) = fs::symlink_metadata(destination) {
        if metadata.is_symlink() || !metadata.is_file() || metadata.permissions().readonly() {
            return Err(
                "Export destination changed while conversion was running. It was kept unchanged."
                    .into(),
            );
        }
        staged
            .as_file()
            .set_permissions(metadata.permissions())
            .map_err(|error| error.to_string())?;
    }
    staged
        .as_file()
        .sync_all()
        .map_err(|error| error.to_string())?;
    check(ticket, deadline)?;
    // Linearize cancellation against the single atomic publication. A cancel
    // acknowledged before this transition keeps the original; after it starts,
    // cancel returns false rather than claiming a committed export was cancelled.
    if ticket
        .phase
        .compare_exchange(0, 2, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("Export cancelled. The destination was kept unchanged.".into());
    }
    staged.persist(destination).map_err(|error| {
        format!("Could not publish export; previous destination was kept: {error}")
    })?;
    #[cfg(unix)]
    if let Ok(directory) = fs::File::open(parent) {
        let _ = directory.sync_all();
    }
    Ok(())
}

struct MediaPreparation<'a> {
    runtime: &'a Runtime,
    database: Option<&'a Database>,
    source: Option<&'a str>,
    temp: &'a Path,
    format: Format,
    supplied: &'a HashMap<String, String>,
    count: usize,
    total: usize,
}
fn walk_images(value: &mut Value, media: &mut MediaPreparation<'_>) -> Result<(), String> {
    if value.get("t").and_then(Value::as_str) == Some("Image") {
        let source = value["c"][2][0]
            .as_str()
            .ok_or("Invalid image in converted document.")?
            .to_string();
        let rewritten = media.prepare(&source)?;
        value["c"][2][0] = json!(rewritten);
    }
    match value {
        Value::Object(object) => {
            for value in object.values_mut() {
                walk_images(value, media)?;
            }
        }
        Value::Array(values) => {
            for value in values {
                walk_images(value, media)?;
            }
        }
        _ => (),
    };
    Ok(())
}
impl MediaPreparation<'_> {
    fn prepare(&mut self, source: &str) -> Result<String, String> {
        if self.count >= 100 {
            return Err("Export exceeds 100 media items.".into());
        }
        self.count += 1;
        let (mime, bytes) = if let Some(svg) = self.supplied.get(source) {
            ("image/svg+xml".to_string(), svg.as_bytes().to_vec())
        } else if let Some(data) = source.strip_prefix("data:") {
            let (header, body) = data
                .split_once(',')
                .ok_or("Invalid embedded image data URL.")?;
            let mime = header.split(';').next().unwrap_or("").to_string();
            let bytes = if header.split(';').any(|part| part == "base64") {
                STANDARD
                    .decode(body)
                    .map_err(|_| "Invalid base64 image data.")?
            } else {
                percent_encoding::percent_decode_str(body).collect()
            };
            (mime, bytes)
        } else {
            if url::Url::parse(source).is_ok() {
                return Err("Remote/file-URL image fetches are disabled during offline export. Use workspace images or embedded image data.".into());
            }
            let path = source.split(['#', '?']).next().unwrap_or(source);
            let path = percent_encoding::percent_decode_str(path)
                .decode_utf8()
                .map_err(|_| "Image path is not UTF-8.")?;
            let database = self
                .database
                .ok_or("Choose a workspace before exporting local file images.")?;
            let asset = assets::read(database, &path, self.source)?;
            let (_, encoded) = asset
                .data_url
                .split_once(',')
                .ok_or("Invalid workspace image.")?;
            (
                asset.mime,
                STANDARD
                    .decode(encoded)
                    .map_err(|_| "Invalid workspace image encoding.")?,
            )
        };
        if bytes.len() > 20 * 1024 * 1024 {
            return Err("An export image exceeds 20 MiB.".into());
        }
        self.total += bytes.len();
        if self.total > 64 * 1024 * 1024 {
            return Err("Export media exceeds the 64 MiB total limit.".into());
        }
        let extension = match mime.as_str() {
            "image/svg+xml" => "svg",
            "image/png" => "png",
            "image/jpeg" => "jpg",
            "image/gif" => "gif",
            "image/webp" => "webp",
            "image/avif" => "avif",
            _ => return Err("Only image media can be embedded in PDF/Office exports.".into()),
        };
        let name = if extension == "svg" && !matches!(self.format, Format::Pdf) {
            let svg = std::str::from_utf8(&bytes).map_err(|_| "SVG export image is not UTF-8.")?;
            let name = format!("asset-{}.png", self.count);
            raster_svg(svg, &self.temp.join(&name), &self.runtime.directory)?;
            name
        } else {
            if extension == "svg" {
                let svg =
                    std::str::from_utf8(&bytes).map_err(|_| "SVG export image is not UTF-8.")?;
                assets::safe_svg(svg)?;
                if svg.to_ascii_lowercase().contains("<foreignobject") {
                    return Err("This diagram uses HTML labels that the offline PDF engine cannot render. Use plain SVG text labels for export.".into());
                }
            }
            let name = format!("asset-{}.{}", self.count, extension);
            fs::write(self.temp.join(&name), bytes).map_err(|error| error.to_string())?;
            name
        };
        Ok(name)
    }
}
fn raster_svg(svg: &str, destination: &Path, bundle: &Path) -> Result<(), String> {
    assets::safe_svg(svg)?;
    if svg.to_ascii_lowercase().contains("<foreignobject") {
        return Err("This diagram uses HTML labels that the offline Office image engine cannot render. Use plain SVG text labels for export.".into());
    }
    let mut options = resvg::usvg::Options {
        font_family: "Noto Sans".into(),
        ..Default::default()
    };
    let font = fs::read(bundle.join("fonts/NotoSans.ttf"))
        .map_err(|error| format!("Bundled diagram font is missing: {error}"))?;
    options.fontdb_mut().load_font_data(font);
    options.fontdb_mut().set_sans_serif_family("Noto Sans");
    options.fontdb_mut().set_serif_family("Noto Sans");
    options.fontdb_mut().set_monospace_family("Noto Sans");
    let tree = resvg::usvg::Tree::from_str(svg, &options)
        .map_err(|error| format!("Could not rasterize SVG: {error}"))?;
    let size = tree.size();
    let scale = (4096.0 / size.width()).min(4096.0 / size.height()).min(2.0);
    let width = (size.width() * scale).ceil().max(1.0) as u32;
    let height = (size.height() * scale).ceil().max(1.0) as u32;
    let mut image =
        resvg::tiny_skia::Pixmap::new(width, height).ok_or("SVG raster image is too large.")?;
    resvg::render(
        &tree,
        resvg::tiny_skia::Transform::from_scale(scale, scale),
        &mut image.as_mut(),
    );
    image
        .save_png(destination)
        .map_err(|error| error.to_string())
}
fn prepare_citation_metadata(
    content: &str,
    database: Option<&Database>,
    source: Option<&str>,
    temp: &Path,
) -> Result<Value, String> {
    let front = frontmatter::parse(content);
    if let Some(error) = front.error {
        return Err(format!("Invalid citation frontmatter: {}", error.message));
    }
    let mut metadata = serde_json::Map::new();
    for key in ["references", "nocite", "lang"] {
        if let Some(value) = front.properties.get(key) {
            metadata.insert(key.into(), value.clone());
        }
    }
    let bibliography = front.properties.get("bibliography");
    let files = match bibliography {
        None | Some(Value::Null) => vec![],
        Some(Value::String(file)) => vec![file.clone()],
        Some(Value::Array(values)) => values
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .map(str::to_string)
                    .ok_or("Bibliography paths must be strings.")
            })
            .collect::<Result<Vec<_>, _>>()?,
        _ => return Err("Bibliography must be a workspace-local path or list of paths.".into()),
    };
    if files.len() > 20 {
        return Err("Citation preview supports at most 20 bibliography files.".into());
    }
    let mut total = 0;
    let mut copied = Vec::new();
    for (index, file) in files.iter().enumerate() {
        let extension = Path::new(file)
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("bib");
        if !matches!(
            extension.to_ascii_lowercase().as_str(),
            "bib" | "biblatex" | "bibtex" | "json" | "yaml" | "yml" | "ris" | "csljson"
        ) {
            return Err("Unsupported bibliography file format.".into());
        }
        let name = format!("bibliography-{index}.{extension}");
        copy_local_resource(file, database, source, temp, &name, &mut total)?;
        copied.push(Value::String(name));
    }
    if !copied.is_empty() {
        metadata.insert("bibliography".into(), Value::Array(copied));
    }
    if let Some(csl) = front.properties.get("csl") {
        let csl = csl
            .as_str()
            .ok_or("CSL style must be a workspace-local path string.")?;
        copy_local_resource(csl, database, source, temp, "style.csl", &mut total)?;
        metadata.insert("csl".into(), json!("style.csl"));
    }
    Ok(Value::Object(metadata))
}
fn copy_local_resource(
    file: &str,
    database: Option<&Database>,
    source: Option<&str>,
    temp: &Path,
    name: &str,
    total: &mut usize,
) -> Result<(), String> {
    if file.contains(':') {
        return Err("Citation resources must be workspace-local files, not URLs.".into());
    }
    let database =
        database.ok_or("Choose a workspace before loading bibliography or CSL files.")?;
    let root = explorer::workspace_root(database)?;
    let folder = if let Some(source) = source {
        let source = explorer::resolve_allow_missing(&root, source)?;
        source
            .parent()
            .ok_or("Source note needs a parent folder.")?
            .to_path_buf()
    } else {
        root.clone()
    };
    let candidate = if Path::new(file).is_absolute() {
        PathBuf::from(file)
    } else {
        folder.join(file)
    };
    let path = explorer::resolve(&root, &candidate.to_string_lossy())?;
    let bytes = read_bounded(&path, 20 * 1024 * 1024)?;
    *total += bytes.len();
    if *total > 20 * 1024 * 1024 {
        return Err("Bibliography/style files exceed the 20 MiB total limit.".into());
    }
    fs::write(temp.join(name), bytes).map_err(|error| error.to_string())
}
fn meta(value: &Value) -> Value {
    match value {
        Value::Bool(value) => json!({"t":"MetaBool","c":value}),
        Value::Array(values) => {
            json!({"t":"MetaList","c":values.iter().map(meta).collect::<Vec<_>>()})
        }
        Value::Object(values) => {
            json!({"t":"MetaMap","c":values.iter().map(|(key,value)|(key.clone(),meta(value))).collect::<serde_json::Map<_,_>>()})
        }
        Value::String(value) => json!({"t":"MetaString","c":value}),
        _ => json!({"t":"MetaString","c":value.to_string()}),
    }
}
fn prepare_ast_citations(
    ast: &mut Value,
    content: &str,
    input: InputFormat,
    database: Option<&Database>,
    source: Option<&str>,
    temp: &Path,
) -> Result<(), String> {
    if matches!(input, InputFormat::Html) {
        return Ok(());
    }
    let metadata = prepare_citation_metadata(content, database, source, temp)?;
    for (key, value) in metadata.as_object().unwrap() {
        ast["meta"][key] = meta(value);
    }
    Ok(())
}
