//! Linux GUI profile ownership and same-user activation.
//!
//! The lock inode is deliberately never unlinked. An owner holds its flock for
//! the entire GUI lifetime, so normal exit and process death both release it.

use crate::launch::LaunchRequest;
use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, IntoRawFd, OwnedFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const LOCK_NAME: &str = ".instance.lock";
const SOCKET_NAME: &str = ".instance.sock";
const LEGACY_AGENT_NAME: &str = "agent.sock";
const REQUEST: &[u8] = b"NOTATION_ACTIVATE/1\n";
const LAUNCH_PREFIX: &[u8] = b"NOTATION_LAUNCH/2 ";
const ACKNOWLEDGED: &[u8] = b"NOTATION_ACTIVATED/1\n";
const LAUNCH_ACKNOWLEDGED: &[u8] = b"NOTATION_LAUNCH_ACCEPTED/2\n";
const LAUNCH_REJECTED: &[u8] = b"NOTATION_LAUNCH_ERROR/2\n";
const REJECTED: &[u8] = b"NOTATION_ACTIVATION_ERROR/1\n";
const MAX_FRAME: usize = 64;
const HANDOFF_TIMEOUT: Duration = Duration::from_secs(6);
const CONNECT_TIMEOUT: Duration = Duration::from_millis(250);
const IO_TIMEOUT: Duration = Duration::from_secs(3);
const RETRY_DELAY: Duration = Duration::from_millis(25);

/// The result of attempting to join or own a canonical application-data profile.
#[must_use = "dropping an owner releases its profile lock"]
pub enum Acquisition {
    Owner(ProfileOwner),
    Activated,
}

/// An operating-system-held profile lock and its activation listener.
///
/// Field order is significant: the listener stops and cleans up its socket
/// before the lock file is closed and the kernel releases ownership.
pub struct ProfileOwner {
    _server: ActivationServer,
    _lock: LockFile,
    _profile: Profile,
}

impl ProfileOwner {
    pub fn profile_dir(&self) -> &Path {
        &self._profile.canonical
    }
}

/// Claim a profile, or activate its existing owner and return `Activated`.
/// This compatibility entry point accepts only v1 activation from secondaries.
pub fn acquire<F>(data_directory: &Path, activate: F) -> Result<Acquisition, String>
where
    F: Fn() -> Result<(), String> + Send + Sync + 'static,
{
    acquire_with_launch(
        data_directory,
        activate,
        |_| Err("This profile owner does not accept file launches.".into()),
        None,
    )
}

/// Claim a profile, or hand `outgoing` to its existing owner. The same request
/// identity is retained across reconnects, so an uncertain acknowledgment cannot
/// enqueue it twice. An accepted launch is queued, not necessarily opened yet.
pub fn acquire_with_launch<F, L>(
    data_directory: &Path,
    activate: F,
    launch: L,
    outgoing: Option<LaunchRequest>,
) -> Result<Acquisition, String>
where
    F: Fn() -> Result<(), String> + Send + Sync + 'static,
    L: Fn(LaunchRequest) -> Result<(), String> + Send + Sync + 'static,
{
    let profile = Profile::open(data_directory)?;
    let activate = Arc::new(activate);
    let launch = Arc::new(launch);
    let deadline = Instant::now() + HANDOFF_TIMEOUT;
    let mut last_error = "the activation endpoint is not ready".to_string();

    loop {
        // Trying the lock on every pass also recovers promptly if an owner
        // crashes between our first lock attempt and activation handshake.
        let lock = match LockFile::try_acquire(&profile)? {
            LockAttempt::Acquired(lock) => lock,
            LockAttempt::Held => {
                if Instant::now() >= deadline {
                    return Err(format!(
                        "Another Notation process owns this profile, but activation was not acknowledged: {last_error}. Refusing to open a second writer."
                    ));
                }
                let handoff = match outgoing.as_ref() {
                    Some(request) => request_launch(&profile, request, deadline),
                    None => request_activation(&profile, deadline),
                };
                match handoff {
                    Ok(()) => return Ok(Acquisition::Activated),
                    Err(ActivationError::Retry(error)) => last_error = error,
                    Err(ActivationError::Fatal(error)) => {
                        return Err(format!(
                            "Could not safely activate the existing Notation process: {error}. Refusing to open a second writer."
                        ));
                    }
                }
                thread::sleep(RETRY_DELAY);
                continue;
            }
        };

        reject_live_legacy_agent(&profile)?;
        let server = ActivationServer::start(&profile, activate.clone(), launch.clone())?;
        return Ok(Acquisition::Owner(ProfileOwner {
            _server: server,
            _lock: lock,
            _profile: profile,
        }));
    }
}

struct Profile {
    canonical: PathBuf,
    directory: File,
}

impl Profile {
    fn open(path: &Path) -> Result<Self, String> {
        fs::create_dir_all(path)
            .map_err(|error| format!("Could not create the application-data profile: {error}"))?;
        // Resolving after creation makes symlink and other path aliases share
        // exactly the same lock inode as Tauri's effective data directory.
        let canonical = fs::canonicalize(path).map_err(|error| {
            format!("Could not canonicalize the application-data profile: {error}")
        })?;
        validate_ancestors(&canonical)?;
        let original = if path.is_absolute() {
            path.to_path_buf()
        } else {
            std::env::current_dir()
                .map_err(|error| error.to_string())?
                .join(path)
        };
        validate_ancestors(&original)?;
        let directory = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_CLOEXEC | libc::O_DIRECTORY | libc::O_NOFOLLOW)
            .open(&canonical)
            .map_err(|error| format!("Could not open the canonical profile directory: {error}"))?;
        let metadata = file_metadata(&directory, "profile directory")?;
        if !metadata.is_dir() || metadata.uid() != effective_uid() {
            return Err(
                "The application-data profile must be a directory owned by the current user."
                    .into(),
            );
        }
        // fchmod operates on the validated directory rather than a path that
        // could have been replaced after canonicalization.
        if unsafe { libc::fchmod(directory.as_raw_fd(), 0o700) } != 0 {
            return Err(format!(
                "Could not make the application-data profile private: {}",
                io::Error::last_os_error()
            ));
        }
        Ok(Self {
            canonical,
            directory,
        })
    }

    fn endpoint(&self, name: &str) -> PathBuf {
        // Linux resolves this magic link to the already-open canonical
        // directory. Besides reducing path-race exposure, the short alias keeps
        // Unix socket sockaddr_un paths below their 108-byte limit.
        PathBuf::from(format!(
            "/proc/self/fd/{}/{}",
            self.directory.as_raw_fd(),
            name
        ))
    }
}

// Other users must not be able to replace a path component between locking
// and SQLite/MCP opening the canonical profile. Sticky temporary roots are OK.
fn validate_ancestors(path: &Path) -> Result<(), String> {
    for ancestor in path.ancestors().skip(1) {
        let metadata = fs::metadata(ancestor).map_err(|error| {
            format!(
                "Could not inspect profile ancestor {}: {error}",
                ancestor.display()
            )
        })?;
        if !metadata.is_dir()
            || (metadata.uid() != effective_uid() && metadata.uid() != 0)
            || (metadata.mode() & 0o022 != 0 && metadata.mode() & 0o1000 == 0)
        {
            return Err(format!(
                "Profile ancestor {} is not protected from replacement by other users.",
                ancestor.display()
            ));
        }
    }
    Ok(())
}

enum LockAttempt {
    Acquired(LockFile),
    Held,
}

struct LockFile {
    _file: File,
    path: PathBuf,
    device: u64,
    inode: u64,
}

impl LockFile {
    fn try_acquire(profile: &Profile) -> Result<LockAttempt, String> {
        let path = profile.endpoint(LOCK_NAME);
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .mode(0o600)
            .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
            .open(&path)
            .map_err(|error| {
                format!("Could not open the profile ownership lock safely: {error}")
            })?;
        let metadata = file_metadata(&file, "profile ownership lock")?;
        if !metadata.is_file() || metadata.uid() != effective_uid() || metadata.nlink() != 1 {
            return Err(
                "The profile ownership lock must be an unshared regular file owned by the current user; it was left intact."
                    .into(),
            );
        }
        if unsafe { libc::fchmod(file.as_raw_fd(), 0o600) } != 0 {
            return Err(format!(
                "Could not make the profile ownership lock private: {}",
                io::Error::last_os_error()
            ));
        }

        let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        let acquired = if result == 0 {
            true
        } else {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::WouldBlock {
                false
            } else {
                return Err(format!(
                    "Could not lock the application-data profile: {error}"
                ));
            }
        };
        let lock = Self {
            _file: file,
            path,
            device: metadata.dev(),
            inode: metadata.ino(),
        };
        // Detect an externally replaced lock path. No Notation code unlinks or
        // rotates this inode, so a mismatch is always fail-closed.
        lock.verify_path()?;
        Ok(if acquired {
            LockAttempt::Acquired(lock)
        } else {
            LockAttempt::Held
        })
    }

    fn verify_path(&self) -> Result<(), String> {
        let metadata = fs::symlink_metadata(&self.path)
            .map_err(|error| format!("The profile ownership lock path changed: {error}"))?;
        if !metadata.file_type().is_file()
            || metadata.uid() != effective_uid()
            || metadata.nlink() != 1
            || metadata.dev() != self.device
            || metadata.ino() != self.inode
        {
            return Err(
                "The profile ownership lock path was replaced or is unsafe; it was left intact."
                    .into(),
            );
        }
        Ok(())
    }
}

struct ActivationServer {
    wakeup: UnixStream,
    shutdown: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
    socket: PathBuf,
    device: u64,
    inode: u64,
}

impl ActivationServer {
    fn start<F, L>(profile: &Profile, activate: Arc<F>, launch: Arc<L>) -> Result<Self, String>
    where
        F: Fn() -> Result<(), String> + Send + Sync + 'static + ?Sized,
        L: Fn(LaunchRequest) -> Result<(), String> + Send + Sync + 'static + ?Sized,
    {
        let socket = profile.endpoint(SOCKET_NAME);
        if let Some(metadata) = socket_metadata(&socket)? {
            match probe_socket(&socket) {
                Ok(SocketProbe::Live) => {
                    return Err(
                        "A live activation socket exists without the new profile lock. Refusing to become a competing writer; the socket was left intact."
                            .into(),
                    );
                }
                Ok(SocketProbe::Missing) => {}
                Ok(SocketProbe::Stale) => remove_socket(&socket, &metadata)?,
                Err(error) => {
                    return Err(format!(
                        "Could not verify the existing activation socket safely: {error}. It was left intact."
                    ));
                }
            }
        }

        let listener = UnixListener::bind(&socket)
            .map_err(|error| format!("Could not bind the profile activation socket: {error}"))?;
        fs::set_permissions(&socket, fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("Could not make the activation socket private: {error}"))?;
        let metadata = socket_metadata(&socket)?.ok_or(
            "The activation socket disappeared immediately after it was created.".to_string(),
        )?;
        listener
            .set_nonblocking(true)
            .map_err(|error| format!("Could not configure the activation listener: {error}"))?;
        let (wakeup, receiver) = UnixStream::pair()
            .map_err(|error| format!("Could not create listener shutdown signal: {error}"))?;
        let shutdown = Arc::new(AtomicBool::new(false));
        let thread_shutdown = shutdown.clone();
        let thread = thread::Builder::new()
            .name("notation-activation".into())
            .spawn(move || {
                while !thread_shutdown.load(Ordering::Acquire) {
                    let mut descriptors = [
                        libc::pollfd {
                            fd: listener.as_raw_fd(),
                            events: libc::POLLIN,
                            revents: 0,
                        },
                        libc::pollfd {
                            fd: receiver.as_raw_fd(),
                            events: libc::POLLIN,
                            revents: 0,
                        },
                    ];
                    let result = unsafe { libc::poll(descriptors.as_mut_ptr(), 2, -1) };
                    if result < 0 && io::Error::last_os_error().kind() == io::ErrorKind::Interrupted
                    {
                        continue;
                    }
                    if result < 0
                        || descriptors[1].revents != 0
                        || descriptors[0].revents & libc::POLLIN == 0
                    {
                        break;
                    }
                    match listener.accept() {
                        Ok((stream, _)) => {
                            handle_connection(stream, activate.as_ref(), launch.as_ref())
                        }
                        Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                            continue;
                        }
                        Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                        Err(error) => {
                            eprintln!("Notation activation listener stopped: {error}");
                            break;
                        }
                    }
                }
            })
            .map_err(|error| format!("Could not start the activation listener: {error}"))?;
        Ok(Self {
            wakeup,
            shutdown,
            thread: Some(thread),
            socket,
            device: metadata.dev(),
            inode: metadata.ino(),
        })
    }
}

impl Drop for ActivationServer {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::Release);
        let _ = self.wakeup.write_all(&[1]);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        if let Ok(metadata) = fs::symlink_metadata(&self.socket) {
            if metadata.dev() == self.device && metadata.ino() == self.inode {
                let _ = remove_socket(&self.socket, &metadata);
            }
        }
    }
}

fn handle_connection<F, L>(mut stream: UnixStream, activate: &F, launch: &L)
where
    F: Fn() -> Result<(), String> + ?Sized,
    L: Fn(LaunchRequest) -> Result<(), String> + ?Sized,
{
    let _ = stream.set_read_timeout(Some(IO_TIMEOUT));
    let _ = stream.set_write_timeout(Some(IO_TIMEOUT));
    let deadline = Instant::now() + IO_TIMEOUT;
    let header =
        peer_is_current_user(&stream).and_then(|()| read_frame_until(&stream, MAX_FRAME, deadline));
    let Ok(header) = header else {
        let _ = stream.write_all(REJECTED);
        return;
    };
    if header == REQUEST {
        let response = if activate().is_ok() {
            ACKNOWLEDGED
        } else {
            REJECTED
        };
        let _ = stream.write_all(response);
        return;
    }
    if !header.starts_with(LAUNCH_PREFIX) {
        let _ = stream.write_all(REJECTED);
        return;
    }

    // Validate the complete bounded payload before activating or enqueueing.
    // Activation, closing, queue-capacity, and event-delivery failures are
    // retryable under the same request identity; malformed requests are not.
    let request = launch_payload_length(&header)
        .and_then(|length| {
            read_launch_payload(&stream, length, deadline).map_err(|error| error.to_string())
        })
        .and_then(|payload| LaunchRequest::decode(&payload));
    let response = match request {
        Err(_) => LAUNCH_REJECTED,
        Ok(request) => match activate() {
            Err(_) => REJECTED,
            Ok(()) => match launch(request) {
                Ok(()) => LAUNCH_ACKNOWLEDGED,
                Err(_) => REJECTED,
            },
        },
    };
    let _ = stream.write_all(response);
}

fn launch_payload_length(header: &[u8]) -> Result<usize, String> {
    let length = header
        .strip_prefix(LAUNCH_PREFIX)
        .and_then(|tail| tail.strip_suffix(b"\n"))
        .ok_or("Malformed launch header.")?;
    let length = std::str::from_utf8(length).map_err(|_| "Malformed launch length.")?;
    if length.is_empty() || !length.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err("Malformed launch length.".into());
    }
    let length: usize = length
        .parse()
        .map_err(|_| "Malformed launch length.".to_string())?;
    if length == 0 || length > crate::launch::MAX_LAUNCH_REQUEST_BYTES {
        return Err("Launch request exceeds the 256 KiB input limit.".into());
    }
    Ok(length)
}

#[derive(Debug)]
enum ActivationError {
    Retry(String),
    Fatal(String),
}

fn time_remaining(deadline: Instant) -> io::Result<Duration> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        Err(io::ErrorKind::TimedOut.into())
    } else {
        Ok(remaining)
    }
}

fn request_activation(profile: &Profile, deadline: Instant) -> Result<(), ActivationError> {
    let socket = profile.endpoint(SOCKET_NAME);
    let metadata = socket_metadata(&socket).map_err(|error| {
        // bind() publishes the inode immediately before the owner can chmod it.
        // Never use an unsafe endpoint, but allow that short startup window to
        // finish instead of turning it into a competing-writer failure.
        ActivationError::Retry(format!("the owner endpoint is not ready safely: {error}"))
    })?;
    if metadata.is_none() {
        return Err(ActivationError::Retry(
            "the owner has not published its activation socket".into(),
        ));
    }
    let connect_timeout = time_remaining(deadline)
        .map_err(|error| ActivationError::Retry(format!("the handoff deadline elapsed: {error}")))?
        .min(CONNECT_TIMEOUT);
    let mut stream = connect_stream(&socket, connect_timeout)
        .map_err(|error| ActivationError::Retry(format!("the owner is unavailable: {error}")))?;
    peer_is_current_user(&stream).map_err(|error| {
        ActivationError::Fatal(format!("activation peer check failed: {error}"))
    })?;
    let io_timeout = time_remaining(deadline)
        .map_err(|error| ActivationError::Retry(format!("the handoff deadline elapsed: {error}")))?
        .min(IO_TIMEOUT);
    stream
        .set_read_timeout(Some(io_timeout))
        .and_then(|()| stream.set_write_timeout(Some(io_timeout)))
        .and_then(|()| stream.write_all(REQUEST))
        .map_err(|error| ActivationError::Retry(format!("activation handshake failed: {error}")))?;
    let response_deadline = deadline.min(Instant::now() + IO_TIMEOUT);
    let response = read_frame_until(&stream, MAX_FRAME, response_deadline).map_err(|error| {
        ActivationError::Retry(format!("activation was not acknowledged: {error}"))
    })?;
    if response == ACKNOWLEDGED {
        Ok(())
    } else if response == REJECTED {
        Err(ActivationError::Retry(
            "the owner rejected or could not complete activation".into(),
        ))
    } else {
        Err(ActivationError::Fatal(
            "the activation endpoint returned a malformed response".into(),
        ))
    }
}

fn request_launch(
    profile: &Profile,
    request: &LaunchRequest,
    deadline: Instant,
) -> Result<(), ActivationError> {
    let payload = request.encode().map_err(ActivationError::Fatal)?;
    let header = format!("NOTATION_LAUNCH/2 {}\n", payload.len());
    let socket = profile.endpoint(SOCKET_NAME);
    let metadata = socket_metadata(&socket).map_err(|error| {
        ActivationError::Retry(format!("the owner endpoint is not ready safely: {error}"))
    })?;
    if metadata.is_none() {
        return Err(ActivationError::Retry(
            "the owner has not published its activation socket".into(),
        ));
    }
    let connect_timeout = time_remaining(deadline)
        .map_err(|error| ActivationError::Retry(format!("the handoff deadline elapsed: {error}")))?
        .min(CONNECT_TIMEOUT);
    let mut stream = connect_stream(&socket, connect_timeout)
        .map_err(|error| ActivationError::Retry(format!("the owner is unavailable: {error}")))?;
    peer_is_current_user(&stream).map_err(|error| {
        ActivationError::Fatal(format!("activation peer check failed: {error}"))
    })?;
    let io_timeout = time_remaining(deadline)
        .map_err(|error| ActivationError::Retry(format!("the handoff deadline elapsed: {error}")))?
        .min(IO_TIMEOUT);
    stream
        .set_read_timeout(Some(io_timeout))
        .and_then(|()| stream.set_write_timeout(Some(io_timeout)))
        .and_then(|()| stream.write_all(header.as_bytes()))
        .and_then(|()| stream.write_all(&payload))
        .map_err(|error| ActivationError::Retry(format!("launch handshake failed: {error}")))?;
    let response = read_frame_until(
        &stream,
        MAX_FRAME,
        deadline.min(Instant::now() + IO_TIMEOUT),
    )
    .map_err(|error| ActivationError::Retry(format!("launch was not acknowledged: {error}")))?;
    if response == LAUNCH_ACKNOWLEDGED {
        // Accepted means queued by the owner; document open outcomes belong to
        // the frontend and may include a visible per-file error.
        Ok(())
    } else if response == REJECTED {
        Err(ActivationError::Retry(
            "the owner could not complete launch activation".into(),
        ))
    } else if response == LAUNCH_REJECTED {
        Err(ActivationError::Fatal(
            "the owner rejected the launch request".into(),
        ))
    } else {
        Err(ActivationError::Fatal(
            "the launch endpoint returned a malformed response".into(),
        ))
    }
}

fn reject_live_legacy_agent(profile: &Profile) -> Result<(), String> {
    let path = profile.endpoint(LEGACY_AGENT_NAME);
    let Some(_) = socket_metadata(&path)? else {
        return Ok(());
    };
    match probe_socket(&path) {
        Ok(SocketProbe::Live) => Err(
            "A live legacy Notation agent.sock exists without the new ownership lock. Close the existing Notation process; refusing to open a competing writer and leaving its socket intact."
                .into(),
        ),
        Ok(SocketProbe::Stale | SocketProbe::Missing) => {
            // The established MCP startup path owns stale agent.sock cleanup.
            Ok(())
        }
        Err(error) => Err(format!(
            "Could not verify whether legacy agent.sock is live: {error}. Refusing to open the profile; the socket was left intact."
        )),
    }
}

fn socket_metadata(path: &Path) -> Result<Option<Metadata>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "Could not inspect a local ownership endpoint: {error}"
            ));
        }
    };
    if !metadata.file_type().is_socket()
        || metadata.uid() != effective_uid()
        || metadata.nlink() != 1
        || metadata.permissions().mode() & 0o077 != 0
    {
        return Err(
            "A local ownership endpoint is not a private, unshared socket owned by the current user; it was left intact."
                .into(),
        );
    }
    Ok(Some(metadata))
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum SocketProbe {
    Live,
    Stale,
    Missing,
}

fn probe_socket(path: &Path) -> io::Result<SocketProbe> {
    let first = probe_socket_once(path)?;
    if first != SocketProbe::Live {
        return Ok(first);
    }
    // A just-closed listener can race its final pending connection. Confirm a
    // live result once before refusing startup; a genuinely live owner remains
    // live, while a closed/crashed owner becomes safely recoverable.
    thread::sleep(Duration::from_millis(5));
    probe_socket_once(path)
}

fn probe_socket_once(path: &Path) -> io::Result<SocketProbe> {
    match connect_stream(path, CONNECT_TIMEOUT) {
        Ok(stream) => {
            peer_is_current_user(&stream)?;
            Ok(SocketProbe::Live)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(SocketProbe::Missing),
        Err(error) if error.kind() == io::ErrorKind::ConnectionRefused => Ok(SocketProbe::Stale),
        Err(error) => Err(error),
    }
}

fn remove_socket(path: &Path, expected: &Metadata) -> Result<(), String> {
    let current = fs::symlink_metadata(path)
        .map_err(|error| format!("Could not recheck the stale activation socket: {error}"))?;
    if !current.file_type().is_socket()
        || current.uid() != effective_uid()
        || current.dev() != expected.dev()
        || current.ino() != expected.ino()
    {
        return Err("The activation socket changed during cleanup; it was left intact.".into());
    }
    fs::remove_file(path)
        .map_err(|error| format!("Could not remove the stale activation socket: {error}"))
}

fn read_frame_until(stream: &UnixStream, maximum: usize, deadline: Instant) -> io::Result<Vec<u8>> {
    let mut reader = stream;
    let mut frame = Vec::with_capacity(maximum.min(256));
    loop {
        if frame.len() >= maximum {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Notation protocol frame exceeds its limit",
            ));
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(io::ErrorKind::TimedOut.into());
        }
        reader.set_read_timeout(Some(remaining))?;
        let mut byte = [0];
        match reader.read(&mut byte) {
            // EOF before a complete frame is a disconnected owner, not a
            // malformed acknowledgment. The caller retries the ownership lock.
            Ok(0) => return Err(io::ErrorKind::UnexpectedEof.into()),
            Ok(_) => {
                frame.push(byte[0]);
                if byte[0] == b'\n' {
                    return Ok(frame);
                }
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        }
    }
}

fn read_launch_payload(
    stream: &UnixStream,
    length: usize,
    deadline: Instant,
) -> io::Result<Vec<u8>> {
    let mut reader = stream;
    let mut payload = vec![0; length];
    let mut offset = 0;
    while offset < length {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(io::ErrorKind::TimedOut.into());
        }
        reader.set_read_timeout(Some(remaining))?;
        match reader.read(&mut payload[offset..]) {
            Ok(0) => return Err(io::ErrorKind::UnexpectedEof.into()),
            Ok(read) => offset += read,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        }
    }
    Ok(payload)
}

fn file_metadata(file: &File, description: &str) -> Result<Metadata, String> {
    file.metadata()
        .map_err(|error| format!("Could not inspect the {description}: {error}"))
}

fn effective_uid() -> u32 {
    unsafe { libc::geteuid() }
}

fn peer_is_current_user(stream: &UnixStream) -> io::Result<()> {
    let mut credentials: libc::ucred = unsafe { std::mem::zeroed() };
    let mut length = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    let result = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            (&mut credentials as *mut libc::ucred).cast(),
            &mut length,
        )
    };
    if result != 0 {
        return Err(io::Error::last_os_error());
    }
    if length as usize != std::mem::size_of::<libc::ucred>() || credentials.uid != effective_uid() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "the Unix socket peer belongs to a different user",
        ));
    }
    Ok(())
}

/// Connect with a real deadline; a full listener backlog must not hang launch.
fn connect_stream(path: &Path, timeout: Duration) -> io::Result<UnixStream> {
    let bytes = path.as_os_str().as_bytes();
    let raw = unsafe {
        libc::socket(
            libc::AF_UNIX,
            libc::SOCK_STREAM | libc::SOCK_CLOEXEC | libc::SOCK_NONBLOCK,
            0,
        )
    };
    if raw < 0 {
        return Err(io::Error::last_os_error());
    }
    let fd = unsafe { OwnedFd::from_raw_fd(raw) };
    let mut address: libc::sockaddr_un = unsafe { std::mem::zeroed() };
    if bytes.is_empty() || bytes.contains(&0) || bytes.len() >= address.sun_path.len() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid Unix socket path",
        ));
    }
    address.sun_family = libc::AF_UNIX as libc::sa_family_t;
    unsafe {
        std::ptr::copy_nonoverlapping(
            bytes.as_ptr(),
            address.sun_path.as_mut_ptr().cast::<u8>(),
            bytes.len(),
        );
    }
    let connected = unsafe {
        libc::connect(
            fd.as_raw_fd(),
            (&address as *const libc::sockaddr_un).cast(),
            std::mem::size_of::<libc::sockaddr_un>() as libc::socklen_t,
        )
    };
    if connected != 0 {
        let error = io::Error::last_os_error();
        if !matches!(
            error.raw_os_error(),
            Some(libc::EINPROGRESS | libc::EAGAIN | libc::EINTR)
        ) {
            return Err(error);
        }
        wait_for_connection(fd.as_raw_fd(), timeout)?;
    }
    let stream = unsafe { UnixStream::from_raw_fd(fd.into_raw_fd()) };
    stream.set_nonblocking(false)?;
    Ok(stream)
}

fn wait_for_connection(fd: i32, timeout: Duration) -> io::Result<()> {
    let deadline = Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        let milliseconds = remaining.as_millis().clamp(1, i32::MAX as u128) as i32;
        let mut poll = libc::pollfd {
            fd,
            events: libc::POLLOUT,
            revents: 0,
        };
        let result = unsafe { libc::poll(&mut poll, 1, milliseconds) };
        if result == 0 {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "Unix socket connection timed out",
            ));
        }
        if result < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted && Instant::now() < deadline {
                continue;
            }
            return Err(error);
        }
        let mut socket_error = 0;
        let mut length = std::mem::size_of::<libc::c_int>() as libc::socklen_t;
        let result = unsafe {
            libc::getsockopt(
                fd,
                libc::SOL_SOCKET,
                libc::SO_ERROR,
                (&mut socket_error as *mut libc::c_int).cast(),
                &mut length,
            )
        };
        if result != 0 {
            return Err(io::Error::last_os_error());
        }
        if socket_error != 0 {
            return Err(io::Error::from_raw_os_error(socket_error));
        }
        if poll.revents & libc::POLLNVAL != 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid Unix socket descriptor",
            ));
        }
        return Ok(());
    }
}
