//! Ordinary CLI file launches and the frontend handoff queue.
//!
//! A socket acknowledgment means that the running owner accepted a request into
//! this queue, not that every document opened. Requests remain available across
//! frontend reloads until the frontend reports them handled (including errors).

use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

pub const MAX_LAUNCH_FILES: usize = 64;
pub const MAX_LAUNCH_REQUEST_BYTES: usize = 256 * 1024;
pub const MAX_PENDING_LAUNCH_REQUESTS: usize = 16;
const MAX_COMPLETED_REQUEST_IDS: usize = 128;
const MAX_REQUEST_ID_BYTES: usize = 64;
static REQUEST_SERIAL: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LaunchRequest {
    id: String,
    paths: Vec<String>,
}

impl LaunchRequest {
    pub fn new(id: impl Into<String>, paths: Vec<String>) -> Result<Self, String> {
        let request = Self {
            id: id.into(),
            paths,
        };
        request.validate()?;
        Ok(request)
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn paths(&self) -> &[String] {
        &self.paths
    }

    pub fn encode(&self) -> Result<Vec<u8>, String> {
        self.validate()?;
        serde_json::to_vec(self)
            .map_err(|error| format!("Could not encode launch request: {error}"))
    }

    pub fn decode(payload: &[u8]) -> Result<Self, String> {
        if payload.len() > MAX_LAUNCH_REQUEST_BYTES {
            return Err("Launch request exceeds the 256 KiB input limit.".into());
        }
        let request: Self = serde_json::from_slice(payload)
            .map_err(|error| format!("Malformed launch request: {error}"))?;
        request.validate()?;
        Ok(request)
    }

    fn validate(&self) -> Result<(), String> {
        if self.id.is_empty()
            || self.id.len() > MAX_REQUEST_ID_BYTES
            || !self
                .id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        {
            return Err("Launch request identity is malformed.".into());
        }
        if self.paths.is_empty() || self.paths.len() > MAX_LAUNCH_FILES {
            return Err(format!(
                "A launch request must contain between 1 and {MAX_LAUNCH_FILES} files."
            ));
        }
        if self.paths.iter().any(|path| {
            path.is_empty() || path.as_bytes().contains(&0) || !Path::new(path).is_absolute()
        }) {
            return Err("Launch requests require non-empty absolute local file paths.".into());
        }
        let encoded = serde_json::to_vec(self)
            .map_err(|error| format!("Could not measure launch request: {error}"))?;
        if encoded.len() > MAX_LAUNCH_REQUEST_BYTES {
            return Err("Launch request exceeds the 256 KiB input limit.".into());
        }
        Ok(())
    }
}

fn request_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let serial = REQUEST_SERIAL.fetch_add(1, Ordering::Relaxed);
    format!("{:x}-{nanos:x}-{serial:x}", std::process::id())
}

/// Parse ordinary GUI arguments. Worker modes are dispatched by `main` before
/// this function, so their argument lists remain completely untouched.
pub fn parse_arguments<I>(arguments: I, cwd: &Path) -> Result<Option<LaunchRequest>, String>
where
    I: IntoIterator<Item = OsString>,
{
    let mut paths = Vec::new();
    let mut filenames_only = false;
    for argument in arguments {
        if !filenames_only && argument == "--" {
            filenames_only = true;
            continue;
        }
        let argument = argument.into_string().map_err(|_| {
            "Document arguments must be valid UTF-8; the file was not opened.".to_string()
        })?;
        if !filenames_only && argument.starts_with('-') {
            return Err(format!(
                "Unexpected option '{argument}'. Use '--' before a filename that begins with '-'."
            ));
        }
        if argument.is_empty() {
            return Err("Document paths must not be empty.".into());
        }
        if paths.len() >= MAX_LAUNCH_FILES {
            return Err(format!(
                "At most {MAX_LAUNCH_FILES} documents can be opened in one launch."
            ));
        }
        let supplied = PathBuf::from(argument);
        let absolute = if supplied.is_absolute() {
            supplied
        } else {
            cwd.join(supplied)
        };
        // Existing files get a stable identity for selecting an already-open
        // unsaved buffer. Missing/inaccessible paths remain absolute so the UI
        // can report the actual open failure after session restoration.
        let resolved = fs::canonicalize(&absolute).unwrap_or(absolute);
        let resolved = resolved.into_os_string().into_string().map_err(|_| {
            "The canonical document path is not valid UTF-8; the file was not opened.".to_string()
        })?;
        paths.push(resolved);
    }
    if paths.is_empty() {
        Ok(None)
    } else {
        LaunchRequest::new(request_id(), paths).map(Some)
    }
}

/// Documents the system asks a running app to open (Finder double-click, Open
/// With, a drop on the Dock icon). Only local `file:` URLs are documents;
/// anything else is ignored.
pub fn from_file_urls<'a>(
    urls: impl IntoIterator<Item = &'a str>,
) -> Result<Option<LaunchRequest>, String> {
    let paths = urls
        .into_iter()
        .filter_map(|value| url::Url::parse(value).ok())
        .filter(|url| url.scheme() == "file")
        .filter_map(|url| url.to_file_path().ok())
        .map(PathBuf::into_os_string);
    parse_arguments(
        std::iter::once(OsString::from("--")).chain(paths),
        Path::new("/"),
    )
}

pub fn from_env() -> Result<Option<LaunchRequest>, String> {
    // AppImage's AppRun changes cwd to its bundled usr directory. The runtime
    // preserves the caller's directory as OWD; ordinary binaries use real cwd.
    let original = std::env::var_os("APPIMAGE")
        .and_then(|_| std::env::var_os("OWD"))
        .map(PathBuf::from)
        .filter(|path| path.is_absolute());
    let cwd = match original {
        Some(path) => path,
        None => std::env::current_dir()
            .map_err(|error| format!("Could not determine the launching directory: {error}"))?,
    };
    parse_arguments(std::env::args_os().skip(1), &cwd)
}

fn open_launch_file(path: &Path) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // Do not follow a last-component replacement or block forever if a
        // regular file is replaced by a FIFO between metadata and open.
        options.custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    options.open(path)
}

/// Read an externally launched document with both metadata and streaming size
/// checks, so a large or growing file is never loaded wholesale into memory.
pub fn read_document(path: &str) -> Result<crate::documents::Document, String> {
    let supplied = Path::new(path);
    if path.is_empty() || !supplied.is_absolute() {
        return Err("A launched document requires an absolute local file path.".into());
    }
    let canonical = supplied
        .canonicalize()
        .map_err(|error| format!("Could not resolve {path}: {error}"))?;
    let canonical_path = canonical
        .to_str()
        .ok_or("The canonical file path is not valid UTF-8.")?
        .to_string();
    let metadata =
        fs::metadata(&canonical).map_err(|error| format!("Could not open {path}: {error}"))?;
    if !metadata.is_file() {
        return Err(format!("Could not open {path}: choose a regular file."));
    }
    if metadata.len() > crate::storage::MAX_CONTENT as u64 {
        return Err(format!(
            "Could not open {path}: document exceeds the 4 MiB editor limit."
        ));
    }
    let file =
        open_launch_file(&canonical).map_err(|error| format!("Could not open {path}: {error}"))?;
    let opened_metadata = file
        .metadata()
        .map_err(|error| format!("Could not inspect {path}: {error}"))?;
    if !opened_metadata.is_file() {
        return Err(format!("Could not open {path}: choose a regular file."));
    }
    if opened_metadata.len() > crate::storage::MAX_CONTENT as u64 {
        return Err(format!(
            "Could not open {path}: document exceeds the 4 MiB editor limit."
        ));
    }
    let mut bytes = Vec::with_capacity(opened_metadata.len() as usize);
    file.take(crate::storage::MAX_CONTENT as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Could not read {path}: {error}"))?;
    if bytes.len() > crate::storage::MAX_CONTENT {
        return Err(format!(
            "Could not open {path}: document exceeds the 4 MiB editor limit."
        ));
    }
    let content =
        String::from_utf8(bytes).map_err(|_| format!("Could not read {path} as UTF-8 text."))?;
    Ok(crate::documents::Document {
        path: canonical_path,
        content,
        warning: None,
    })
}

pub fn read_with_metadata(
    path: &str,
    database: &Result<crate::storage::Database, String>,
) -> Result<crate::documents::Document, String> {
    let mut document = read_document(path)?;
    if let Err(error) = database
        .as_ref()
        .map_err(Clone::clone)
        .and_then(|database| database.record_document(&document.path, &document.content, false))
    {
        document.warning = Some(format!(
            "File opened, but local history could not be updated: {error}"
        ));
    }
    Ok(document)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EnqueueOutcome {
    Enqueued,
    DuplicatePending,
    DuplicateCompleted,
}

#[derive(Default)]
struct LaunchState {
    ready: bool,
    closing: bool,
    pending: VecDeque<LaunchRequest>,
    completed: VecDeque<String>,
}

/// Native requests are removed only after the frontend has attempted every
/// path and surfaced any failures. Until then, readiness snapshots replay them.
#[derive(Clone, Default)]
pub struct LaunchQueue {
    state: Arc<Mutex<LaunchState>>,
}

impl LaunchQueue {
    pub fn enqueue(&self, request: LaunchRequest) -> Result<EnqueueOutcome, String> {
        request.validate()?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| "The launch queue is unavailable.".to_string())?;
        if state.pending.iter().any(|pending| pending.id == request.id) {
            return Ok(EnqueueOutcome::DuplicatePending);
        }
        if state.completed.iter().any(|id| id == &request.id) {
            return Ok(EnqueueOutcome::DuplicateCompleted);
        }
        if state.closing {
            return Err(
                "The existing Notation window is closing; retry after it exits or cancels closing."
                    .into(),
            );
        }
        if state.pending.len() >= MAX_PENDING_LAUNCH_REQUESTS {
            return Err("The existing Notation launch queue is full; retry later.".into());
        }
        state.pending.push_back(request);
        Ok(EnqueueOutcome::Enqueued)
    }

    pub fn set_ready(&self, ready: bool) -> Result<Vec<LaunchRequest>, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "The launch queue is unavailable.".to_string())?;
        state.ready = ready;
        Ok(if state.ready {
            state.pending.iter().cloned().collect()
        } else {
            Vec::new()
        })
    }

    pub fn ready(&self) -> Result<bool, String> {
        self.state
            .lock()
            .map(|state| state.ready)
            .map_err(|_| "The launch queue is unavailable.".to_string())
    }

    pub fn set_closing(&self, closing: bool) -> Result<(), String> {
        self.state
            .lock()
            .map(|mut state| state.closing = closing)
            .map_err(|_| "The launch queue is unavailable.".to_string())
    }

    pub fn complete(&self, id: &str) -> Result<bool, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "The launch queue is unavailable.".to_string())?;
        let Some(index) = state.pending.iter().position(|request| request.id == id) else {
            return Ok(false);
        };
        state.pending.remove(index);
        state.completed.retain(|completed| completed != id);
        state.completed.push_back(id.to_string());
        while state.completed.len() > MAX_COMPLETED_REQUEST_IDS {
            state.completed.pop_front();
        }
        Ok(true)
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::ffi::CString;
    use std::os::unix::fs::OpenOptionsExt;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn replaced_fifo_does_not_block_the_document_reader() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("replaced.txt");
        fs::write(&path, "original").unwrap();
        assert!(fs::metadata(&path).unwrap().is_file());
        fs::remove_file(&path).unwrap();
        let name = CString::new(path.to_str().unwrap()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        let (sender, receiver) = mpsc::channel();
        let replacement = path.clone();
        let thread = std::thread::spawn(move || {
            let _ = sender.send(open_launch_file(&replacement));
        });
        let result = receiver.recv_timeout(Duration::from_secs(1));
        if result.is_err() {
            // Unblock a regressed blocking reader before failing the test.
            let _writer = OpenOptions::new()
                .write(true)
                .custom_flags(libc::O_NONBLOCK)
                .open(&path)
                .unwrap();
            thread.join().unwrap();
            panic!("Opening a replaced FIFO blocked waiting for a writer");
        }
        let file = result.unwrap().unwrap();
        assert!(!file.metadata().unwrap().is_file());
        thread.join().unwrap();
    }
}
