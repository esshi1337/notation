//! Native, transport-only JSON-RPC stdio hosting for language servers.
//!
//! The editor owns LSP initialization and all protocol semantics. This module
//! validates JSON, bounds frames and queues, and supervises local child processes.
#![cfg_attr(not(any(feature = "desktop", test)), allow(dead_code))]
// The integration copy omits the desktop launcher, so its production-only
// profile-discovery path is intentionally unused there.
#![cfg_attr(test, allow(dead_code))]

use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    ffi::OsString,
    fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{sync_channel, Receiver, SyncSender, TrySendError},
        Arc, Condvar, Mutex, MutexGuard,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

pub(crate) const MAX_FRAME_BYTES: usize = 4 * 1024 * 1024;
pub(crate) const MAX_HEADER_BYTES: usize = 8 * 1024;
pub(crate) const OUTGOING_QUEUE: usize = 64;
const MAX_SERVERS: usize = 6;
const MAX_RECENT_ERRORS: usize = 6;
const MAX_ANCESTORS: usize = 64;
const MAX_STDERR_BYTES: usize = 8 * 1024;
const INCOMPLETE_FRAME_TIMEOUT: Duration = Duration::from_secs(30);
const TERMINATE_GRACE: Duration = Duration::from_millis(400);
const STOP_TIMEOUT: Duration = Duration::from_secs(2);
const START_SHUTDOWN_WAIT: Duration = Duration::from_secs(2);
const LANGUAGE_PACK_MANIFEST_VERSION: u64 = 1;
const REQUIRED_LANGUAGE_PACK_PATCH: &str = "svelte-untrusted-prettier-config";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StartInfo {
    pub id: String,
    pub root_uri: String,
    pub uri: String,
    pub language_id: String,
    pub server: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatus {
    pub id: String,
    pub server: String,
    pub root_uri: String,
    pub running: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Event {
    Message { id: String, message: String },
    Exit { id: String, error: String },
}

type EventSink = Arc<dyn Fn(Event) + Send + Sync>;
type DescriptorResolver =
    Arc<dyn Fn(ServerKind) -> Result<ServerSpec, String> + Send + Sync + 'static>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum ServerKind {
    TypeScript,
    Svelte,
    Rust,
}

impl ServerKind {
    fn name(self) -> &'static str {
        match self {
            Self::TypeScript => "typescript-language-server",
            Self::Svelte => "svelte-language-server",
            Self::Rust => "rust-analyzer",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Language {
    JavaScript,
    TypeScript,
    JavaScriptReact,
    TypeScriptReact,
    Svelte,
    Rust,
}

impl Language {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "javascript" => Ok(Self::JavaScript),
            "typescript" => Ok(Self::TypeScript),
            "javascriptreact" => Ok(Self::JavaScriptReact),
            "typescriptreact" => Ok(Self::TypeScriptReact),
            "svelte" => Ok(Self::Svelte),
            "rust" => Ok(Self::Rust),
            _ => Err(format!(
                "Unsupported language '{value}'. Expected javascript, typescript, javascriptreact, typescriptreact, svelte, or rust."
            )),
        }
    }

    fn id(self) -> &'static str {
        match self {
            Self::JavaScript => "javascript",
            Self::TypeScript => "typescript",
            Self::JavaScriptReact => "javascriptreact",
            Self::TypeScriptReact => "typescriptreact",
            Self::Svelte => "svelte",
            Self::Rust => "rust",
        }
    }

    fn kind(self) -> ServerKind {
        match self {
            Self::JavaScript | Self::TypeScript | Self::JavaScriptReact | Self::TypeScriptReact => {
                ServerKind::TypeScript
            }
            Self::Svelte => ServerKind::Svelte,
            Self::Rust => ServerKind::Rust,
        }
    }

    fn markers(self) -> &'static [&'static str] {
        match self.kind() {
            ServerKind::TypeScript => &["tsconfig.json", "jsconfig.json", "package.json"],
            ServerKind::Svelte => &["svelte.config.js", "svelte.config.ts", "package.json"],
            ServerKind::Rust => &["Cargo.toml"],
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct ServerKey {
    root: PathBuf,
    kind: ServerKind,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LanguagePackManifest {
    manifest_version: u64,
    notation_patches: Vec<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct ServerSpec {
    program: PathBuf,
    arguments: Vec<OsString>,
}

impl ServerSpec {
    pub(crate) fn new(program: PathBuf, arguments: &[&str]) -> Self {
        Self {
            program,
            arguments: arguments.iter().map(OsString::from).collect(),
        }
    }

    #[cfg(test)]
    pub(crate) fn program(&self) -> &Path {
        &self.program
    }

    #[cfg(test)]
    pub(crate) fn arguments(&self) -> &[OsString] {
        &self.arguments
    }
}

#[derive(Clone)]
pub struct Service {
    inner: Arc<ServiceInner>,
    profile: Option<PathBuf>,
}

struct ServiceInner {
    resolver: DescriptorResolver,
    events: EventSink,
    registry: Registry,
    closing: AtomicBool,
    sequence: AtomicU64,
}

#[derive(Default)]
struct Registry {
    state: Mutex<RegistryState>,
    changed: Condvar,
}

#[derive(Default)]
struct RegistryState {
    active: HashMap<ServerKey, Arc<Server>>,
    ids: HashMap<String, Arc<Server>>,
    starting: HashSet<ServerKey>,
    recent_errors: VecDeque<ServerStatus>,
}

struct Server {
    shared: Arc<Shared>,
    sender: Mutex<Option<SyncSender<String>>>,
    threads: Mutex<Option<Vec<JoinHandle<()>>>>,
}

struct Shared {
    id: String,
    server: String,
    root_uri: String,
    pid: u32,
    child: Mutex<Child>,
    running: AtomicBool,
    stopping: AtomicBool,
    expected_exit: AtomicBool,
    exit_sent: AtomicBool,
    kill_sent: AtomicBool,
    reaped: Mutex<bool>,
    reaped_changed: Condvar,
    stop_started: Mutex<Option<Instant>>,
    error: Mutex<Option<String>>,
    stderr: Mutex<VecDeque<u8>>,
    events: EventSink,
}

enum BeginStart {
    Existing(Arc<Server>),
    Reserved {
        id: String,
        replacement: Option<Arc<Server>>,
    },
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl Service {
    pub(crate) fn new(profile: Option<PathBuf>, events: EventSink) -> Self {
        let resolver_profile = profile.clone();
        let resolver: DescriptorResolver =
            Arc::new(move |kind| production_descriptor(kind, resolver_profile.as_deref()));
        let mut service = Self::with_resolver(resolver, events);
        service.profile = profile;
        service
    }

    fn with_resolver(resolver: DescriptorResolver, events: EventSink) -> Self {
        Self {
            inner: Arc::new(ServiceInner {
                resolver,
                events,
                registry: Registry::default(),
                closing: AtomicBool::new(false),
                sequence: AtomicU64::new(0),
            }),
            profile: None,
        }
    }

    #[cfg(test)]
    pub(crate) fn for_test(spec: ServerSpec, events: EventSink) -> Self {
        Self::with_resolver(Arc::new(move |_| Ok(spec.clone())), events)
    }

    #[cfg(feature = "desktop")]
    pub(crate) fn discover(profile: Option<PathBuf>, handle: tauri::AppHandle) -> Self {
        use tauri::Emitter;
        Self::new(
            profile,
            Arc::new(move |event| {
                let result = match event {
                    Event::Message { id, message } => handle.emit_to(
                        "main",
                        "notation:lsp-message",
                        serde_json::json!({ "id": id, "message": message }),
                    ),
                    Event::Exit { id, error } => handle.emit_to(
                        "main",
                        "notation:lsp-exit",
                        serde_json::json!({ "id": id, "error": error }),
                    ),
                };
                // Application teardown can invalidate the webview while an IO
                // thread is finishing. The exit hook still reaps every child.
                let _ = result;
            }),
        )
    }

    pub(crate) fn typescript_path(&self) -> Result<String, String> {
        typescript_path(self.profile.as_deref()).and_then(|path| {
            path.into_os_string()
                .into_string()
                .map_err(|_| "The optional TypeScript runtime path is not UTF-8.".into())
        })
    }

    pub(crate) fn start(&self, path: String, language: String) -> Result<StartInfo, String> {
        let language = Language::parse(&language)?;
        let path = canonical_document(Path::new(&path))?;
        let root = project_root(&path, language);
        let root_uri = directory_uri(&root)?;
        let uri = file_uri(&path)?;
        let key = ServerKey {
            root,
            kind: language.kind(),
        };

        let server = loop {
            match self.inner.begin_start(&key)? {
                BeginStart::Existing(server) => break server,
                BeginStart::Reserved { id, replacement } => {
                    let outcome = match self.inner.prepare_server(&key, replacement) {
                        Ok(()) => (self.inner.resolver)(key.kind).and_then(|spec| {
                            spawn_server(&id, &key, &root_uri, spec, self.inner.events.clone())
                        }),
                        Err(error) => Err(error),
                    };
                    match outcome {
                        Ok(server) => {
                            if self.inner.finish_start(&key, Some(server.clone())) {
                                break server;
                            }
                            // Shutdown won the registration race. Keep the start
                            // reservation until this child is gone so stop_all can
                            // wait for it rather than returning with a live process.
                            let _ = stop_process(&server);
                            self.inner.finish_start(&key, None);
                            return Err("The language-server service is shutting down.".into());
                        }
                        Err(error) => {
                            self.inner.finish_start(&key, None);
                            return Err(error);
                        }
                    }
                }
            }
        };
        Ok(StartInfo {
            id: server.shared.id.clone(),
            root_uri: server.shared.root_uri.clone(),
            uri,
            language_id: language.id().into(),
            server: server.shared.server.clone(),
        })
    }

    pub(crate) fn send(&self, id: String, message: String) -> Result<(), String> {
        if message.len() > MAX_FRAME_BYTES {
            return Err("LSP message exceeds the 4 MiB limit.".into());
        }
        valid_json(&message)
            .map_err(|error| format!("LSP message must be one complete JSON value: {error}"))?;
        let server = self
            .inner
            .find(&id)
            .ok_or("Language server is not running. Start it again before sending messages.")?;
        if !server.is_running() {
            return Err(
                "Language server is not running. Start it again before sending messages.".into(),
            );
        }
        let sender = lock(&server.sender)
            .as_ref()
            .cloned()
            .ok_or("Language server input is closed.")?;
        sender.try_send(message).map_err(|error| match error {
            TrySendError::Full(_) => {
                "Language server input queue is full; retry after pending messages are processed."
                    .into()
            }
            TrySendError::Disconnected(_) => "Language server input is closed.".into(),
        })
    }

    pub(crate) fn stop(&self, id: String) -> Result<(), String> {
        let Some(server) = self.inner.find(&id) else {
            return Ok(());
        };
        stop_process(&server)?;
        self.inner.remove(&server);
        Ok(())
    }

    pub(crate) fn stop_all(&self) {
        self.inner.stop_all();
    }

    pub(crate) fn status(&self) -> Vec<ServerStatus> {
        let state = lock(&self.inner.registry.state);
        let mut statuses: Vec<_> = state
            .active
            .values()
            .map(|server| server.status())
            .chain(state.recent_errors.iter().cloned())
            .collect();
        drop(state);
        statuses.sort_by(|left, right| left.id.cmp(&right.id));
        statuses
    }
}

impl ServiceInner {
    fn begin_start(&self, key: &ServerKey) -> Result<BeginStart, String> {
        let mut state = lock(&self.registry.state);
        loop {
            if self.closing.load(Ordering::Acquire) {
                return Err("The language-server service is shutting down.".into());
            }
            if state.starting.contains(key) {
                state = self
                    .registry
                    .changed
                    .wait(state)
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                continue;
            }
            if let Some(server) = state.active.get(key).cloned() {
                if server.is_running() {
                    return Ok(BeginStart::Existing(server));
                }
                state.starting.insert(key.clone());
                return Ok(BeginStart::Reserved {
                    id: self.next_id(),
                    replacement: Some(server),
                });
            }
            // Count every unresolved reservation, including replacements whose
            // old entry may already have been removed. This slightly favors
            // safety over transient availability and makes the six-child cap
            // atomic across concurrent start/stop/restart races.
            if state.active.len() + state.starting.len() >= MAX_SERVERS {
                return Err("At most 6 language servers can run at once. Stop an unused server and try again.".into());
            }
            state.starting.insert(key.clone());
            return Ok(BeginStart::Reserved {
                id: self.next_id(),
                replacement: None,
            });
        }
    }

    fn next_id(&self) -> String {
        format!("lsp-{}", self.sequence.fetch_add(1, Ordering::Relaxed) + 1)
    }

    fn prepare_server(
        &self,
        key: &ServerKey,
        replacement: Option<Arc<Server>>,
    ) -> Result<(), String> {
        if !key.root.is_dir() {
            return Err("The language-server project directory no longer exists.".into());
        }
        if let Some(server) = replacement {
            stop_process(&server)?;
            self.remove(&server);
        }
        Ok(())
    }

    fn finish_start(&self, key: &ServerKey, server: Option<Arc<Server>>) -> bool {
        let mut state = lock(&self.registry.state);
        if server.is_some() && self.closing.load(Ordering::Acquire) {
            return false;
        }
        state.starting.remove(key);
        if let Some(server) = server {
            state.ids.insert(server.shared.id.clone(), server.clone());
            state.active.insert(key.clone(), server);
        }
        drop(state);
        self.registry.changed.notify_all();
        true
    }

    fn find(&self, id: &str) -> Option<Arc<Server>> {
        lock(&self.registry.state).ids.get(id).cloned()
    }

    fn remove(&self, server: &Arc<Server>) {
        let mut state = lock(&self.registry.state);
        let removed = state
            .ids
            .get(&server.shared.id)
            .is_some_and(|current| Arc::ptr_eq(current, server));
        if !removed {
            return;
        }
        state.ids.remove(&server.shared.id);
        state
            .active
            .retain(|_, current| !Arc::ptr_eq(current, server));
        let status = server.status();
        if status.error.is_some() {
            state.recent_errors.push_back(status);
            while state.recent_errors.len() > MAX_RECENT_ERRORS {
                state.recent_errors.pop_front();
            }
        }
        drop(state);
        self.registry.changed.notify_all();
    }

    fn stop_all(&self) {
        self.closing.store(true, Ordering::Release);
        let deadline = Instant::now() + START_SHUTDOWN_WAIT;
        let servers = {
            let mut state = lock(&self.registry.state);
            while !state.starting.is_empty() {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    break;
                }
                let (next, _) = self
                    .registry
                    .changed
                    .wait_timeout(state, remaining)
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                state = next;
            }
            state.active.values().cloned().collect::<Vec<_>>()
        };
        for server in servers {
            let _ = stop_process(&server);
            self.remove(&server);
        }
    }
}

impl Drop for ServiceInner {
    fn drop(&mut self) {
        self.stop_all();
    }
}

impl Server {
    fn is_running(&self) -> bool {
        self.shared.running.load(Ordering::Acquire)
            && !self.shared.stopping.load(Ordering::Acquire)
            && !*lock(&self.shared.reaped)
    }

    fn status(&self) -> ServerStatus {
        ServerStatus {
            id: self.shared.id.clone(),
            server: self.shared.server.clone(),
            root_uri: self.shared.root_uri.clone(),
            running: self.is_running(),
            error: lock(&self.shared.error).clone(),
        }
    }
}

fn canonical_document(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("Language servers require an absolute, saved document path.".into());
    }
    let metadata = fs::metadata(path)
        .map_err(|error| format!("The document must be an existing saved local file: {error}"))?;
    if !metadata.file_type().is_file() {
        return Err(
            "The document path must identify a regular file, not a directory or device.".into(),
        );
    }
    let canonical = fs::canonicalize(path)
        .map_err(|error| format!("Could not canonicalize the document path: {error}"))?;
    if canonical.to_str().is_none() {
        return Err("Language servers require a UTF-8 document path.".into());
    }
    if !fs::metadata(&canonical)
        .map_err(|error| format!("Could not inspect the canonical document: {error}"))?
        .file_type()
        .is_file()
    {
        return Err("The canonical document path is not a regular file.".into());
    }
    Ok(canonical)
}

fn project_root(file: &Path, language: Language) -> PathBuf {
    let parent = file.parent().unwrap_or_else(|| Path::new("/"));
    let mut git_fallback = None;
    let mut current = Some(parent);
    for _ in 0..MAX_ANCESTORS {
        let Some(directory) = current else {
            break;
        };
        if language
            .markers()
            .iter()
            .any(|marker| directory.join(marker).is_file())
        {
            return directory.to_path_buf();
        }
        if git_fallback.is_none() && fs::symlink_metadata(directory.join(".git")).is_ok() {
            git_fallback = Some(directory.to_path_buf());
        }
        current = directory.parent();
    }
    git_fallback.unwrap_or_else(|| parent.to_path_buf())
}

fn file_uri(path: &Path) -> Result<String, String> {
    url::Url::from_file_path(path)
        .map(|url| url.to_string())
        .map_err(|_| "Could not encode the document path as a file URI.".into())
}

fn directory_uri(path: &Path) -> Result<String, String> {
    url::Url::from_directory_path(path)
        .map(|url| url.to_string())
        .map_err(|_| "Could not encode the project path as a file URI.".into())
}

fn language_pack_install_help() -> &'static str {
    "From a Notation source checkout, run `npm run desktop:languages` to explicitly obtain and install a compatible pack. Notation never downloads language servers automatically."
}

fn validated_language_pack(profile: Option<&Path>) -> Result<PathBuf, String> {
    if cfg!(target_os = "macos") {
        return Err("The optional TypeScript/Svelte language pack is currently Linux x86-64 only. macOS code editing and highlighting work without it; no compatible macOS Node runtime is pinned.".into());
    }
    let profile = profile.ok_or_else(|| {
        format!(
            "The application profile is unavailable, so the optional language pack cannot be resolved. {}",
            language_pack_install_help()
        )
    })?;
    let base = profile.join("language-servers");
    let manifest_path = base.join("manifest.json");
    let source = fs::read_to_string(&manifest_path).map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            format!(
                "The optional language pack is not installed at {}. {}",
                base.display(),
                language_pack_install_help()
            )
        } else {
            format!(
                "Could not read the optional language-pack manifest at {}: {error}. Reinstall it with `npm run desktop:languages`.",
                manifest_path.display()
            )
        }
    })?;
    let manifest: LanguagePackManifest = serde_json::from_str(&source).map_err(|error| {
        format!(
            "The optional language-pack manifest at {} is unsupported or damaged: {error}. Reinstall it with `npm run desktop:languages`.",
            manifest_path.display()
        )
    })?;
    if manifest.manifest_version != LANGUAGE_PACK_MANIFEST_VERSION {
        return Err(format!(
            "The optional language pack at {} has unsupported manifest version {} (expected {}). Reinstall it with `npm run desktop:languages`.",
            base.display(),
            manifest.manifest_version,
            LANGUAGE_PACK_MANIFEST_VERSION
        ));
    }
    if !manifest
        .notation_patches
        .iter()
        .any(|patch| patch == REQUIRED_LANGUAGE_PACK_PATCH)
    {
        return Err(format!(
            "The optional language pack at {} does not declare the required safety patch `{REQUIRED_LANGUAGE_PACK_PATCH}`. Refusing to start an unpatched pack; reinstall it with `npm run desktop:languages`.",
            base.display()
        ));
    }
    Ok(base)
}

pub(crate) fn typescript_path(profile: Option<&Path>) -> Result<PathBuf, String> {
    let base = validated_language_pack(profile)?;
    let path = base.join("node_modules/typescript/lib/tsserver.js");
    if !path.is_file() {
        return Err(format!(
            "The optional language pack at {} is incomplete: the pinned TypeScript runtime is missing. Reinstall it with `npm run desktop:languages`.",
            base.display()
        ));
    }
    Ok(path)
}

pub(crate) fn production_descriptor(
    kind: ServerKind,
    profile: Option<&Path>,
) -> Result<ServerSpec, String> {
    if kind == ServerKind::Rust {
        let executable = trusted_path_executable("rust-analyzer").ok_or(
            "Rust language intelligence requires rust-analyzer in an absolute directory on the inherited PATH. Install it with your Rust toolchain and reopen the document.",
        )?;
        return Ok(ServerSpec::new(executable, &[]));
    }

    let module = match kind {
        ServerKind::TypeScript => "typescript-language-server/lib/cli.mjs",
        ServerKind::Svelte => "svelte-language-server/bin/server.js",
        ServerKind::Rust => unreachable!(),
    };
    let base = validated_language_pack(profile)?;
    let node = base.join("node");
    let script = base.join("node_modules").join(module);
    if !node.is_file() || !script.is_file() {
        return Err(format!(
            "The optional language pack at {} is incomplete for {}. Reinstall it with `npm run desktop:languages`.",
            base.display(),
            kind.name()
        ));
    }
    Ok(ServerSpec {
        program: node,
        arguments: vec![script.into_os_string(), OsString::from("--stdio")],
    })
}

fn trusted_path_executable(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for directory in std::env::split_paths(&path) {
        if directory.as_os_str().is_empty() || !directory.is_absolute() {
            continue;
        }
        let candidate = directory.join(name);
        if candidate.is_file() && is_executable(&candidate) {
            return Some(candidate);
        }
    }
    None
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    fs::metadata(path)
        .map(|metadata| metadata.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    path.is_file()
}

fn spawn_server(
    id: &str,
    key: &ServerKey,
    root_uri: &str,
    spec: ServerSpec,
    events: EventSink,
) -> Result<Arc<Server>, String> {
    let mut command = Command::new(&spec.program);
    command
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_PATH")
        .args(&spec.arguments)
        .current_dir(&key.root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command.spawn().map_err(|error| {
        format!(
            "Could not start {} at {}: {error}. Check that the executable and its runtime are installed.",
            key.kind.name(),
            spec.program.to_string_lossy()
        )
    })?;
    let pipes = (|| {
        Some((
            child.stdin.take()?,
            child.stdout.take()?,
            child.stderr.take()?,
        ))
    })();
    let Some((stdin, stdout, stderr)) = pipes else {
        let _ = child.kill();
        let _ = child.wait();
        return Err("Language server stdio pipes could not be opened.".into());
    };
    let shared = Arc::new(Shared {
        id: id.into(),
        server: key.kind.name().into(),
        root_uri: root_uri.into(),
        pid: child.id(),
        child: Mutex::new(child),
        running: AtomicBool::new(true),
        stopping: AtomicBool::new(false),
        expected_exit: AtomicBool::new(false),
        exit_sent: AtomicBool::new(false),
        kill_sent: AtomicBool::new(false),
        reaped: Mutex::new(false),
        reaped_changed: Condvar::new(),
        stop_started: Mutex::new(None),
        error: Mutex::new(None),
        stderr: Mutex::new(VecDeque::with_capacity(MAX_STDERR_BYTES)),
        events,
    });
    let (sender, receiver) = sync_channel(OUTGOING_QUEUE);
    let writer = spawn_thread(shared.clone(), receiver, stdin, writer_loop);
    let reader = spawn_reader(shared.clone(), stdout);
    let diagnostics = spawn_stderr(shared.clone(), stderr);
    let monitor = spawn_monitor(shared.clone());
    Ok(Arc::new(Server {
        shared,
        sender: Mutex::new(Some(sender)),
        threads: Mutex::new(Some(vec![writer, reader, diagnostics, monitor])),
    }))
}

fn spawn_thread(
    shared: Arc<Shared>,
    receiver: Receiver<String>,
    stdin: ChildStdin,
    worker: fn(Arc<Shared>, Receiver<String>, ChildStdin),
) -> JoinHandle<()> {
    thread::spawn(move || worker(shared, receiver, stdin))
}

fn writer_loop(shared: Arc<Shared>, receiver: Receiver<String>, mut stdin: ChildStdin) {
    while let Ok(message) = receiver.recv() {
        if !shared.running.load(Ordering::Acquire) || shared.stopping.load(Ordering::Acquire) {
            break;
        }
        let header = format!("Content-Length: {}\r\n\r\n", message.len());
        if let Err(error) = stdin
            .write_all(header.as_bytes())
            .and_then(|()| stdin.write_all(message.as_bytes()))
            .and_then(|()| stdin.flush())
        {
            transport_failure(
                &shared,
                format!("Language server stdin failed: {error}"),
                true,
            );
            break;
        }
    }
}

fn spawn_reader(shared: Arc<Shared>, mut stdout: ChildStdout) -> JoinHandle<()> {
    thread::spawn(move || loop {
        #[cfg(unix)]
        let frame =
            read_frame_with(&mut |buffer, timeout| polled_read(&mut stdout, buffer, timeout));
        #[cfg(not(unix))]
        let frame = read_frame_with(&mut |buffer, _| stdout.read(buffer));
        match frame {
            Ok(Some(message)) => {
                if !shared.running.load(Ordering::Acquire)
                    || shared.stopping.load(Ordering::Acquire)
                {
                    break;
                }
                (shared.events)(Event::Message {
                    id: shared.id.clone(),
                    message,
                });
            }
            Ok(None) => {
                if !shared.expected_exit.load(Ordering::Acquire) {
                    transport_failure(
                        &shared,
                        "Language server closed its stdout unexpectedly.".into(),
                        true,
                    );
                }
                break;
            }
            Err(error) => {
                transport_failure(&shared, error, true);
                break;
            }
        }
    })
}

fn spawn_stderr(shared: Arc<Shared>, mut stderr: impl Read + Send + 'static) -> JoinHandle<()> {
    thread::spawn(move || {
        let mut buffer = [0; 2048];
        loop {
            match stderr.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(count) => {
                    let mut ring = lock(&shared.stderr);
                    ring.extend(&buffer[..count]);
                    let overflow = ring.len().saturating_sub(MAX_STDERR_BYTES);
                    ring.drain(..overflow);
                }
            }
        }
    })
}

#[cfg(target_os = "linux")]
fn poll_owned_child(child: &mut Child, pid: u32) -> io::Result<Option<std::process::ExitStatus>> {
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    let result = unsafe {
        libc::waitid(
            libc::P_PID,
            pid,
            &mut info,
            libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
        )
    };
    if result != 0 {
        return Err(io::Error::last_os_error());
    }
    if unsafe { info.si_pid() } == 0 {
        return Ok(None);
    }
    signal_group(pid, Signal::Kill);
    child.try_wait()
}
#[cfg(not(target_os = "linux"))]
fn poll_owned_child(child: &mut Child, _pid: u32) -> io::Result<Option<std::process::ExitStatus>> {
    child.try_wait()
}

fn spawn_monitor(shared: Arc<Shared>) -> JoinHandle<()> {
    thread::spawn(move || {
        loop {
            // Serialize signaling and reaping. WNOWAIT keeps the exited leader's
            // PID reserved while we terminate descendants in its process group.
            let polled = {
                let mut child = lock(&shared.child);
                let result = poll_owned_child(&mut child, shared.pid);
                if matches!(&result, Ok(Some(_))) {
                    mark_reaped(&shared);
                }
                result
            };
            match polled {
                Ok(Some(status)) => {
                    // Reap the leader, then close pipes retained by ordinary
                    // descendants in its dedicated process group.
                    shared.running.store(false, Ordering::Release);
                    mark_reaped(&shared);
                    if !shared.expected_exit.load(Ordering::Acquire) {
                        transport_failure(
                            &shared,
                            format!("Language server exited unexpectedly ({status})."),
                            false,
                        );
                    }
                    break;
                }
                Ok(None) => {}
                Err(error) => {
                    // An unavailable child handle cannot safely authorize a
                    // signal to the old numeric process-group ID.
                    shared.running.store(false, Ordering::Release);
                    mark_reaped(&shared);
                    transport_failure(
                        &shared,
                        format!("Could not wait for the language server: {error}"),
                        false,
                    );
                    break;
                }
            }
            let should_kill = shared.stopping.load(Ordering::Acquire)
                && lock(&shared.stop_started)
                    .is_some_and(|started| started.elapsed() >= TERMINATE_GRACE);
            if should_kill {
                request_kill(&shared);
            }
            thread::sleep(Duration::from_millis(10));
        }
    })
}

fn stop_process(server: &Arc<Server>) -> Result<(), String> {
    let shared = &server.shared;
    lock(&server.sender).take();
    shared.expected_exit.store(true, Ordering::Release);
    {
        let _child = lock(&shared.child);
        if *lock(&shared.reaped) {
            shared.stopping.store(true, Ordering::Release);
            shared.running.store(false, Ordering::Release);
        } else if !shared.stopping.swap(true, Ordering::AcqRel) {
            shared.running.store(false, Ordering::Release);
            *lock(&shared.stop_started) = Some(Instant::now());
            signal_group(shared.pid, Signal::Terminate);
        }
    }
    let reaped = lock(&shared.reaped);
    let (reaped, timeout) = shared
        .reaped_changed
        .wait_timeout_while(reaped, STOP_TIMEOUT, |reaped| !*reaped)
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if !*reaped {
        return Err(format!(
            "Language server did not stop within {} ms (timeout: {}).",
            STOP_TIMEOUT.as_millis(),
            if timeout.timed_out() {
                "deadline reached"
            } else {
                "wait interrupted"
            }
        ));
    }
    drop(reaped);
    if let Some(threads) = lock(&server.threads).take() {
        let current = thread::current().id();
        for handle in threads {
            if handle.thread().id() != current {
                let _ = handle.join();
            }
        }
    }
    Ok(())
}

fn mark_reaped(shared: &Shared) {
    *lock(&shared.reaped) = true;
    shared.reaped_changed.notify_all();
}

fn transport_failure(shared: &Shared, error: String, terminate: bool) {
    if !shared.expected_exit.load(Ordering::Acquire)
        && !shared.exit_sent.swap(true, Ordering::AcqRel)
    {
        shared.running.store(false, Ordering::Release);
        let error = with_diagnostics(shared, error);
        *lock(&shared.error) = Some(error.clone());
        (shared.events)(Event::Exit {
            id: shared.id.clone(),
            error,
        });
    }
    if terminate {
        request_kill(shared);
    }
}

fn with_diagnostics(shared: &Shared, error: String) -> String {
    let mut ring = lock(&shared.stderr);
    if ring.is_empty() {
        return error;
    }
    let bytes = ring.make_contiguous();
    let diagnostics = String::from_utf8_lossy(bytes);
    let diagnostics = diagnostics.trim();
    if diagnostics.is_empty() {
        error
    } else {
        format!("{error} Server diagnostics: {diagnostics}")
    }
}

#[derive(Clone, Copy)]
enum Signal {
    Terminate,
    Kill,
}

#[cfg(unix)]
fn signal_group(pid: u32, signal: Signal) {
    let signal = match signal {
        Signal::Terminate => libc::SIGTERM,
        Signal::Kill => libc::SIGKILL,
    };
    unsafe {
        libc::kill(-(pid as i32), signal);
    }
}

#[cfg(not(unix))]
fn signal_group(_pid: u32, _signal: Signal) {}

fn request_kill(shared: &Shared) {
    let mut child = lock(&shared.child);
    if *lock(&shared.reaped) || shared.kill_sent.swap(true, Ordering::AcqRel) {
        return;
    }
    signal_group(shared.pid, Signal::Kill);
    let _ = child.kill();
}

fn read_frame_with<F>(read: &mut F) -> Result<Option<String>, String>
where
    F: FnMut(&mut [u8], Option<Duration>) -> io::Result<usize>,
{
    let mut header = Vec::with_capacity(256);
    let mut deadline = None;
    loop {
        let mut byte = [0];
        let timeout = remaining(deadline)?;
        let count = read(&mut byte, timeout)
            .map_err(|error| format!("Could not read the language-server frame header: {error}"))?;
        if count == 0 {
            if header.is_empty() {
                return Ok(None);
            }
            return Err("Language server closed stdio in the middle of a frame header.".into());
        }
        if deadline.is_none() {
            deadline = Some(Instant::now() + INCOMPLETE_FRAME_TIMEOUT);
        }
        header.push(byte[0]);
        if header.len() > MAX_HEADER_BYTES {
            return Err("Language server frame header exceeds 8 KiB.".into());
        }
        if header.ends_with(b"\r\n\r\n") {
            break;
        }
        if byte[0] == b'\n' && !header.ends_with(b"\r\n") {
            return Err("Language server headers must use CRLF framing.".into());
        }
    }
    let length = parse_content_length(&header)?;
    if length > MAX_FRAME_BYTES {
        return Err("Language server frame exceeds 4 MiB.".into());
    }
    let mut body = vec![0; length];
    let mut offset = 0;
    while offset < length {
        let timeout = remaining(deadline)?;
        let count = read(&mut body[offset..], timeout)
            .map_err(|error| format!("Could not read the language-server frame body: {error}"))?;
        if count == 0 {
            return Err("Language server closed stdio in the middle of a frame body.".into());
        }
        offset += count;
    }
    let message = String::from_utf8(body)
        .map_err(|_| "Language server frame body is not valid UTF-8 JSON.".to_string())?;
    valid_json(&message).map_err(|error| format!("Language server sent invalid JSON: {error}"))?;
    Ok(Some(message))
}

/// Check that `message` is exactly one JSON value without building it:
/// frames are forwarded as text, so the parsed tree was only thrown away.
///
/// `serde::de::IgnoredAny` would be faster still, but it skips values without
/// the parser's nesting limit. This visitor walks the same grammar as a
/// `serde_json::Value` parse, limit included, and allocates nothing.
pub(crate) fn valid_json(message: &str) -> Result<(), serde_json::Error> {
    serde_json::from_str::<Skipped>(message).map(|_| ())
}
struct Skipped;
impl<'de> serde::Deserialize<'de> for Skipped {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Visitor;
        impl<'de> serde::de::Visitor<'de> for Visitor {
            type Value = Skipped;
            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                formatter.write_str("any JSON value")
            }
            fn visit_bool<E>(self, _: bool) -> Result<Skipped, E> {
                Ok(Skipped)
            }
            fn visit_i64<E>(self, _: i64) -> Result<Skipped, E> {
                Ok(Skipped)
            }
            fn visit_u64<E>(self, _: u64) -> Result<Skipped, E> {
                Ok(Skipped)
            }
            fn visit_f64<E>(self, _: f64) -> Result<Skipped, E> {
                Ok(Skipped)
            }
            fn visit_str<E>(self, _: &str) -> Result<Skipped, E> {
                Ok(Skipped)
            }
            fn visit_unit<E>(self) -> Result<Skipped, E> {
                Ok(Skipped)
            }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut seq: A) -> Result<Skipped, A::Error> {
                while seq.next_element::<Skipped>()?.is_some() {}
                Ok(Skipped)
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(self, mut map: A) -> Result<Skipped, A::Error> {
                while map.next_entry::<Skipped, Skipped>()?.is_some() {}
                Ok(Skipped)
            }
        }
        deserializer.deserialize_any(Visitor)
    }
}

fn remaining(deadline: Option<Instant>) -> Result<Option<Duration>, String> {
    match deadline {
        None => Ok(None),
        Some(deadline) => {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                Err("Language server sent an incomplete frame for more than 30 seconds.".into())
            } else {
                Ok(Some(remaining))
            }
        }
    }
}

fn parse_content_length(header: &[u8]) -> Result<usize, String> {
    let text = std::str::from_utf8(header)
        .map_err(|_| "Language server frame header is not valid ASCII/UTF-8.".to_string())?;
    if !text.is_ascii() {
        return Err("Language server frame header must be ASCII.".into());
    }
    let lines: Vec<_> = text.split("\r\n").collect();
    if lines.len() < 3 || !lines[lines.len() - 1].is_empty() || !lines[lines.len() - 2].is_empty() {
        return Err("Language server frame header has a malformed terminator.".into());
    }
    let mut content_length = None;
    for line in &lines[..lines.len() - 2] {
        let (name, value) = line
            .split_once(':')
            .ok_or("Language server frame contains a malformed header.")?;
        if name.trim() != name || name.is_empty() {
            return Err("Language server frame contains a malformed header name.".into());
        }
        if name.eq_ignore_ascii_case("Content-Length") {
            if content_length.is_some() {
                return Err(
                    "Language server frame contains duplicate Content-Length headers.".into(),
                );
            }
            let value = value.trim_matches([' ', '\t']);
            if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
                return Err("Language server Content-Length must be a decimal byte count.".into());
            }
            content_length = Some(
                value
                    .parse::<usize>()
                    .map_err(|_| "Language server Content-Length is out of range.")?,
            );
        }
    }
    content_length.ok_or_else(|| "Language server frame is missing Content-Length.".into())
}

#[cfg(unix)]
fn polled_read(
    stdout: &mut ChildStdout,
    buffer: &mut [u8],
    timeout: Option<Duration>,
) -> io::Result<usize> {
    use std::os::fd::AsRawFd;
    let deadline = timeout.map(|timeout| Instant::now() + timeout);
    loop {
        let milliseconds = match deadline {
            None => -1,
            Some(deadline) => {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "incomplete frame timed out",
                    ));
                }
                remaining.as_millis().min(i32::MAX as u128) as i32
            }
        };
        let mut descriptor = libc::pollfd {
            fd: stdout.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        let result = unsafe { libc::poll(&mut descriptor, 1, milliseconds) };
        if result > 0 {
            if descriptor.revents & libc::POLLNVAL != 0 {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "invalid stdio pipe",
                ));
            }
            if descriptor.revents & (libc::POLLIN | libc::POLLHUP | libc::POLLERR) != 0 {
                return stdout.read(buffer);
            }
        } else if result == 0 {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "incomplete frame timed out",
            ));
        } else {
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::Interrupted {
                return Err(error);
            }
        }
    }
}

#[cfg(test)]
mod json_validation_tests {
    use super::valid_json;

    #[test]
    fn validation_accepts_one_complete_value_and_rejects_everything_else() {
        for valid in [
            r#"{"jsonrpc":"2.0","id":1,"result":{"items":[{"label":"é\u00e9","n":1.5e3,"x":null,"y":[true,false]}]}}"#,
            "[]",
            "  {\"a\": {\"b\": [1, 2, {\"c\": \"\\\"\"}]}}  ",
            "\"text\"",
            "0",
            "null",
        ] {
            assert!(valid_json(valid).is_ok(), "{valid}");
            assert!(serde_json::from_str::<serde_json::Value>(valid).is_ok(), "{valid}");
        }
        for invalid in [
            "",
            "{",
            r#"{"a":1"#,
            r#"{"a":1} {"b":2}"#,
            r#"{"a":1}x"#,
            r#"{"a":}"#,
            r#"{'a':1}"#,
            "[1,]",
            r#"{"a":"\x"}"#,
            "NaN",
            r#"{"a":1,}"#,
        ] {
            assert!(valid_json(invalid).is_err(), "{invalid}");
            // Same verdict as the value-tree parse it replaces.
            assert!(serde_json::from_str::<serde_json::Value>(invalid).is_err(), "{invalid}");
        }
        // Deep nesting is refused by both, without overflowing the stack.
        let deep = "[".repeat(200_000) + &"]".repeat(200_000);
        assert!(valid_json(&deep).is_err());
    }
}
