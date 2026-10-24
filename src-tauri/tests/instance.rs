#![cfg(target_os = "linux")]

use notation_lib::instance::{acquire, acquire_with_launch, Acquisition};
use notation_lib::launch::{LaunchQueue, LaunchRequest};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{symlink, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Barrier};
use std::time::{Duration, Instant};

fn owner(path: &Path) -> Acquisition {
    acquire(path, || Ok(())).expect("profile should be acquired")
}

fn activation_error(result: Result<Acquisition, String>) -> String {
    match result {
        Ok(Acquisition::Owner(_)) => panic!("unexpectedly became a profile owner"),
        Ok(Acquisition::Activated) => panic!("activation unexpectedly succeeded"),
        Err(error) => error,
    }
}

fn raw_lock(profile: &Path) -> File {
    fs::create_dir_all(profile).unwrap();
    fs::set_permissions(profile, fs::Permissions::from_mode(0o700)).unwrap();
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(profile.join(".instance.lock"))
        .unwrap();
    file.set_permissions(fs::Permissions::from_mode(0o600))
        .unwrap();
    assert_eq!(
        unsafe {
            libc::flock(
                std::os::fd::AsRawFd::as_raw_fd(&file),
                libc::LOCK_EX | libc::LOCK_NB,
            )
        },
        0
    );
    file
}

fn private_listener(path: &Path) -> UnixListener {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let listener = UnixListener::bind(path).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
    listener
}

#[test]
fn one_owner_hands_off_without_touching_existing_state() {
    let temporary = tempfile::tempdir().unwrap();
    let profile = temporary.path().join("xdg/local.notation.app");
    fs::create_dir_all(&profile).unwrap();
    fs::write(profile.join("state.sqlite3"), b"existing-state-sentinel").unwrap();
    let activations = Arc::new(AtomicUsize::new(0));
    let callback_count = activations.clone();
    let first = acquire(&profile, move || {
        callback_count.fetch_add(1, Ordering::SeqCst);
        Ok(())
    })
    .unwrap();
    assert!(matches!(first, Acquisition::Owner(_)));

    let second = acquire(&profile, || {
        panic!("a secondary must not install a callback")
    })
    .unwrap();
    assert!(matches!(second, Acquisition::Activated));
    assert_eq!(activations.load(Ordering::SeqCst), 1);
    assert_eq!(
        fs::read(profile.join("state.sqlite3")).unwrap(),
        b"existing-state-sentinel"
    );
}

#[test]
fn canonical_aliases_share_an_owner() {
    let temporary = tempfile::tempdir().unwrap();
    let profile = temporary.path().join("actual-profile");
    fs::create_dir_all(&profile).unwrap();
    let alias = temporary.path().join("profile-alias");
    symlink(&profile, &alias).unwrap();
    let first = owner(&profile);
    let second = owner(&alias);
    assert!(matches!(first, Acquisition::Owner(_)));
    assert!(matches!(second, Acquisition::Activated));
    if let Acquisition::Owner(owner) = first {
        assert_eq!(owner.profile_dir(), fs::canonicalize(profile).unwrap());
    }
}

#[test]
fn separate_xdg_profiles_own_independently() {
    let temporary = tempfile::tempdir().unwrap();
    let first_profile = temporary.path().join("xdg-one/local.notation.app");
    let second_profile = temporary.path().join("xdg-two/local.notation.app");
    let first = owner(&first_profile);
    let second = owner(&second_profile);
    assert!(matches!(first, Acquisition::Owner(_)));
    assert!(matches!(second, Acquisition::Owner(_)));
    assert!(matches!(owner(&first_profile), Acquisition::Activated));
    assert!(matches!(owner(&second_profile), Acquisition::Activated));
}

#[test]
fn simultaneous_cold_starts_produce_one_owner() {
    const STARTS: usize = 8;
    let temporary = tempfile::tempdir().unwrap();
    let profile = temporary.path().join("local.notation.app");
    let barrier = Arc::new(Barrier::new(STARTS));
    let activations = Arc::new(AtomicUsize::new(0));
    let mut threads = Vec::new();
    for _ in 0..STARTS {
        let profile = profile.clone();
        let barrier = barrier.clone();
        let activations = activations.clone();
        threads.push(std::thread::spawn(move || {
            barrier.wait();
            acquire(&profile, move || {
                activations.fetch_add(1, Ordering::SeqCst);
                Ok(())
            })
            .unwrap()
        }));
    }
    let claims: Vec<_> = threads
        .into_iter()
        .map(|thread| thread.join().unwrap())
        .collect();
    let owners = claims
        .iter()
        .filter(|claim| matches!(claim, Acquisition::Owner(_)))
        .count();
    let activated = claims
        .iter()
        .filter(|claim| matches!(claim, Acquisition::Activated))
        .count();
    assert_eq!((owners, activated), (1, STARTS - 1));
    assert_eq!(activations.load(Ordering::SeqCst), STARTS - 1);
}

#[test]
fn unavailable_owner_times_out_without_becoming_a_writer() {
    let temporary = tempfile::tempdir().unwrap();
    let profile = temporary.path().join("profile");
    let lock = raw_lock(&profile);
    let started = Instant::now();
    let error = activation_error(acquire(&profile, || {
        panic!("unavailable owner cannot activate")
    }));
    assert!(started.elapsed() >= Duration::from_secs(5));
    assert!(error.contains("activation was not acknowledged"), "{error}");
    assert!(
        error.contains("Refusing to open a second writer"),
        "{error}"
    );
    drop(lock);
    assert!(matches!(owner(&profile), Acquisition::Owner(_)));
}

#[test]
fn connected_but_unresponsive_owner_also_fails_closed() {
    let temporary = tempfile::tempdir().unwrap();
    let profile = temporary.path().join("profile");
    let _lock = raw_lock(&profile);
    let listener = private_listener(&profile.join(".instance.sock"));
    let (release_sender, release_receiver) = std::sync::mpsc::channel();
    let server = std::thread::spawn(move || {
        let (_stream, _) = listener.accept().unwrap();
        let _ = release_receiver.recv_timeout(Duration::from_secs(10));
    });
    let error = activation_error(acquire(&profile, || {
        panic!("unresponsive owner cannot activate")
    }));
    assert!(
        error.contains("Refusing to open a second writer"),
        "{error}"
    );
    release_sender.send(()).unwrap();
    server.join().unwrap();
}

#[test]
fn malformed_activation_responses_are_not_acknowledgments() {
    let temporary = tempfile::tempdir().unwrap();
    let profile = temporary.path().join("profile");
    let _lock = raw_lock(&profile);
    let listener = private_listener(&profile.join(".instance.sock"));
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut request = [0; 64];
        let _ = stream.read(&mut request);
        stream.write_all(b"not-a-notation-response\n").unwrap();
    });
    let error = activation_error(acquire(&profile, || {
        panic!("malformed endpoint cannot activate")
    }));
    assert!(error.contains("malformed response"), "{error}");
    server.join().unwrap();
}

fn raw_request(socket: &Path, request: &[u8]) -> Vec<u8> {
    let mut stream = UnixStream::connect(socket).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    stream.write_all(request).unwrap();
    let mut response = Vec::new();
    BufReader::new(stream)
        .read_until(b'\n', &mut response)
        .unwrap();
    response
}

#[test]
fn malformed_requests_are_rejected_without_activation() {
    let temporary = tempfile::tempdir().unwrap();
    let profile = temporary.path().join("profile");
    let activations = Arc::new(AtomicUsize::new(0));
    let callback_count = activations.clone();
    let first = acquire(&profile, move || {
        callback_count.fetch_add(1, Ordering::SeqCst);
        Ok(())
    })
    .unwrap();
    assert!(matches!(first, Acquisition::Owner(_)));
    let socket = profile.join(".instance.sock");
    assert_eq!(
        raw_request(&socket, b"open /tmp/document.md\n"),
        b"NOTATION_ACTIVATION_ERROR/1\n"
    );
    assert_eq!(
        raw_request(&socket, &[b'x'; 256]),
        b"NOTATION_ACTIVATION_ERROR/1\n"
    );
    assert_eq!(activations.load(Ordering::SeqCst), 0);
    assert!(matches!(owner(&profile), Acquisition::Activated));
    assert_eq!(activations.load(Ordering::SeqCst), 1);
}

#[test]
fn drop_preserves_the_lock_inode_and_allows_reacquisition() {
    let temporary = tempfile::tempdir().unwrap();
    let profile = temporary.path().join("profile");
    let first = owner(&profile);
    assert!(matches!(first, Acquisition::Owner(_)));
    let lock = profile.join(".instance.lock");
    let inode = fs::metadata(&lock).unwrap().ino();
    drop(first);
    assert_eq!(fs::metadata(&lock).unwrap().ino(), inode);
    let second = owner(&profile);
    assert!(matches!(second, Acquisition::Owner(_)));
    assert_eq!(fs::metadata(&lock).unwrap().ino(), inode);
}

#[test]
fn stale_activation_socket_is_replaced_after_lock_acquisition() {
    let temporary = tempfile::tempdir().unwrap();
    let profile = temporary.path().join("profile");
    fs::create_dir_all(&profile).unwrap();
    let socket = profile.join(".instance.sock");
    drop(private_listener(&socket));
    let stale_inode = fs::metadata(&socket).unwrap().ino();
    let first = owner(&profile);
    assert!(matches!(first, Acquisition::Owner(_)));
    assert_ne!(fs::metadata(&socket).unwrap().ino(), stale_inode);
    assert!(matches!(owner(&profile), Acquisition::Activated));
}

#[test]
fn live_activation_socket_without_the_lock_blocks_startup() {
    let temporary = tempfile::tempdir().unwrap();
    let profile = temporary.path().join("profile");
    fs::create_dir_all(&profile).unwrap();
    let socket = profile.join(".instance.sock");
    let listener = private_listener(&socket);
    let error = activation_error(acquire(&profile, || Ok(())));
    assert!(error.contains("live activation socket"), "{error}");
    assert!(socket.exists());
    drop(listener);
    assert!(matches!(owner(&profile), Acquisition::Owner(_)));
}

#[test]
fn long_profile_paths_still_support_activation() {
    let temporary = tempfile::tempdir().unwrap();
    let profile = temporary
        .path()
        .join("x".repeat(140))
        .join("local.notation.app");
    assert!(profile.join(".instance.sock").as_os_str().as_bytes().len() > 108);
    let first = owner(&profile);
    assert!(matches!(first, Acquisition::Owner(_)));
    assert!(matches!(owner(&profile), Acquisition::Activated));
}

#[test]
fn unsafe_lock_and_socket_paths_are_rejected_and_preserved() {
    let temporary = tempfile::tempdir().unwrap();

    let lock_profile = temporary.path().join("lock-symlink");
    fs::create_dir_all(&lock_profile).unwrap();
    let target = temporary.path().join("lock-target");
    fs::write(&target, b"keep-lock-target").unwrap();
    symlink(&target, lock_profile.join(".instance.lock")).unwrap();
    assert!(acquire(&lock_profile, || Ok(())).is_err());
    assert_eq!(fs::read(&target).unwrap(), b"keep-lock-target");
    assert!(fs::symlink_metadata(lock_profile.join(".instance.lock"))
        .unwrap()
        .file_type()
        .is_symlink());

    let socket_profile = temporary.path().join("socket-symlink");
    fs::create_dir_all(&socket_profile).unwrap();
    let target = temporary.path().join("socket-target");
    fs::write(&target, b"keep-socket-target").unwrap();
    symlink(&target, socket_profile.join(".instance.sock")).unwrap();
    assert!(acquire(&socket_profile, || Ok(())).is_err());
    assert_eq!(fs::read(&target).unwrap(), b"keep-socket-target");
    assert!(fs::symlink_metadata(socket_profile.join(".instance.sock"))
        .unwrap()
        .file_type()
        .is_symlink());

    let regular_profile = temporary.path().join("regular-socket-file");
    fs::create_dir_all(&regular_profile).unwrap();
    fs::write(regular_profile.join(".instance.sock"), b"keep-regular-file").unwrap();
    assert!(acquire(&regular_profile, || Ok(())).is_err());
    assert_eq!(
        fs::read(regular_profile.join(".instance.sock")).unwrap(),
        b"keep-regular-file"
    );

    let public_profile = temporary.path().join("non-private-socket");
    fs::create_dir_all(&public_profile).unwrap();
    let public_socket = public_profile.join(".instance.sock");
    let _listener = private_listener(&public_socket);
    fs::set_permissions(&public_socket, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(acquire(&public_profile, || Ok(())).is_err());
    assert!(public_socket.exists());

    let hardlink_profile = temporary.path().join("hardlinked-lock");
    fs::create_dir_all(&hardlink_profile).unwrap();
    let target = temporary.path().join("hardlink-target");
    fs::write(&target, b"keep-hardlink-target").unwrap();
    fs::hard_link(&target, hardlink_profile.join(".instance.lock")).unwrap();
    assert!(acquire(&hardlink_profile, || Ok(())).is_err());
    assert_eq!(fs::read(&target).unwrap(), b"keep-hardlink-target");
}

#[test]
fn live_legacy_agent_blocks_but_stale_agent_does_not() {
    let temporary = tempfile::tempdir().unwrap();
    let profile = temporary.path().join("profile");
    fs::create_dir_all(&profile).unwrap();
    let agent = profile.join("agent.sock");
    let listener = private_listener(&agent);
    let error = activation_error(acquire(&profile, || Ok(())));
    assert!(error.contains("live legacy Notation agent.sock"), "{error}");
    assert!(agent.exists());
    drop(listener);
    let first = owner(&profile);
    assert!(matches!(first, Acquisition::Owner(_)));
    assert!(
        agent.exists(),
        "instance ownership must leave MCP cleanup to MCP"
    );
}

#[test]
fn crash_releases_ownership_and_stale_socket_is_recovered() {
    let temporary = tempfile::tempdir().unwrap();
    let profile = temporary.path().join("profile");
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args(["crash_child_helper", "--exact", "--nocapture"])
        .env("NOTATION_INSTANCE_CRASH_PROFILE", &profile)
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap());
    let mut ready = false;
    for _ in 0..8 {
        let mut line = String::new();
        if output.read_line(&mut line).unwrap() == 0 {
            break;
        }
        if line == "READY\n" {
            ready = true;
            break;
        }
    }
    let _ = child.kill();
    let status = child.wait().unwrap();
    assert!(ready, "crash helper did not report ownership");
    assert!(!status.success());
    assert!(profile.join(".instance.lock").exists());
    assert!(profile.join(".instance.sock").exists());
    let first = owner(&profile);
    assert!(matches!(first, Acquisition::Owner(_)));
    assert!(matches!(owner(&profile), Acquisition::Activated));
}

#[test]
fn crash_child_helper() {
    let Some(profile) = std::env::var_os("NOTATION_INSTANCE_CRASH_PROFILE") else {
        return;
    };
    let _owner = match acquire(Path::new(&profile), || Ok(())).unwrap() {
        Acquisition::Owner(owner) => owner,
        Acquisition::Activated => panic!("crash helper unexpectedly found an owner"),
    };
    println!("READY");
    std::io::stdout().flush().unwrap();
    std::thread::sleep(Duration::from_secs(30));
}

#[test]
fn unsafe_shared_ancestors_are_rejected() {
    let temporary = tempfile::tempdir().unwrap();
    let shared = temporary.path().join("shared");
    fs::create_dir(&shared).unwrap();
    fs::set_permissions(&shared, fs::Permissions::from_mode(0o777)).unwrap();
    let error = activation_error(acquire(&shared.join("profile"), || Ok(())));
    assert!(error.contains("not protected from replacement"), "{error}");
    fs::set_permissions(&shared, fs::Permissions::from_mode(0o1777)).unwrap();
    assert!(matches!(
        owner(&shared.join("profile")),
        Acquisition::Owner(_)
    ));
}

#[test]
fn retargeting_an_alias_does_not_retarget_the_owned_profile() {
    let temporary = tempfile::tempdir().unwrap();
    let first = temporary.path().join("first");
    let second = temporary.path().join("second");
    fs::create_dir(&first).unwrap();
    fs::create_dir(&second).unwrap();
    let alias = temporary.path().join("alias");
    symlink(&first, &alias).unwrap();
    let Acquisition::Owner(held) = owner(&alias) else {
        panic!("expected owner")
    };
    fs::remove_file(&alias).unwrap();
    symlink(&second, &alias).unwrap();
    assert_eq!(held.profile_dir(), first);
    assert!(matches!(owner(&first), Acquisition::Activated));
    assert!(matches!(owner(&alias), Acquisition::Owner(_)));
}

#[test]
fn slow_trickle_cannot_extend_the_frame_deadline() {
    let temporary = tempfile::tempdir().unwrap();
    let profile = temporary.path().join("profile");
    let held = owner(&profile);
    let mut stream = UnixStream::connect(profile.join(".instance.sock")).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let mut writer = stream.try_clone().unwrap();
    let trickle = std::thread::spawn(move || {
        for _ in 0..24 {
            if writer.write_all(b"x").is_err() {
                break;
            }
            std::thread::sleep(Duration::from_millis(250));
        }
    });
    let start = Instant::now();
    let mut response = [0; 64];
    let count = stream.read(&mut response).unwrap();
    assert_eq!(&response[..count], b"NOTATION_ACTIVATION_ERROR/1\n");
    assert!(start.elapsed() < Duration::from_millis(4500));
    trickle.join().unwrap();
    assert!(matches!(owner(&profile), Acquisition::Activated));
    let start = Instant::now();
    drop(held);
    assert!(
        start.elapsed() < Duration::from_secs(1),
        "idle shutdown did not wake listener"
    );
}

#[test]
fn disconnected_owner_releases_lock_during_handoff() {
    let temporary = tempfile::tempdir().unwrap();
    let profile = temporary.path().join("profile");
    let lock = raw_lock(&profile);
    let listener = private_listener(&profile.join(".instance.sock"));
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut request = [0; 64];
        assert!(stream.read(&mut request).unwrap() > 0);
        // Model an owner dying after receiving activation but before replying.
        drop(lock);
        drop(listener);
        drop(stream);
    });
    let result = acquire(&profile, || Ok(()));
    server.join().unwrap();
    assert!(
        matches!(result, Ok(Acquisition::Owner(_))),
        "waiter must reacquire after owner disappears"
    );
}

#[test]
fn warm_launch_delivers_multiple_paths_and_retry_identity_is_deduplicated() {
    let temporary = tempfile::tempdir().unwrap();
    let profile = temporary.path().join("profile");
    let queue = LaunchQueue::default();
    let owner_queue = queue.clone();
    let activations = Arc::new(AtomicUsize::new(0));
    let callback_count = activations.clone();
    let first = acquire_with_launch(
        &profile,
        move || {
            callback_count.fetch_add(1, Ordering::SeqCst);
            Ok(())
        },
        move |request| owner_queue.enqueue(request).map(|_| ()),
        None,
    );
    assert!(matches!(first, Ok(Acquisition::Owner(_))));
    let request = LaunchRequest::new(
        "warm-request",
        vec!["/tmp/with spaces.txt".into(), "/tmp/日本語.md".into()],
    )
    .unwrap();
    for _ in 0..2 {
        let second = acquire_with_launch(
            &profile,
            || panic!("a secondary must not install an activation callback"),
            |_| panic!("a secondary must not install a launch callback"),
            Some(request.clone()),
        )
        .unwrap();
        assert!(matches!(second, Acquisition::Activated));
    }
    assert_eq!(activations.load(Ordering::SeqCst), 2);
    assert_eq!(queue.set_ready(true).unwrap(), vec![request]);
}

#[test]
fn malformed_and_oversized_v2_frames_do_not_activate_or_enqueue() {
    let temporary = tempfile::tempdir().unwrap();
    let profile = temporary.path().join("profile");
    let queue = LaunchQueue::default();
    let owner_queue = queue.clone();
    let activations = Arc::new(AtomicUsize::new(0));
    let callback_count = activations.clone();
    let first = acquire_with_launch(
        &profile,
        move || {
            callback_count.fetch_add(1, Ordering::SeqCst);
            Ok(())
        },
        move |request| owner_queue.enqueue(request).map(|_| ()),
        None,
    );
    assert!(matches!(first, Ok(Acquisition::Owner(_))));
    let socket = profile.join(".instance.sock");
    assert_eq!(
        raw_request(&socket, b"NOTATION_LAUNCH/2 999999999\n"),
        b"NOTATION_LAUNCH_ERROR/2\n"
    );
    let payload = b"not-json";
    let header = format!("NOTATION_LAUNCH/2 {}\n", payload.len());
    let mut frame = header.into_bytes();
    frame.extend_from_slice(payload);
    assert_eq!(raw_request(&socket, &frame), b"NOTATION_LAUNCH_ERROR/2\n");
    assert_eq!(activations.load(Ordering::SeqCst), 0);
    assert!(queue.set_ready(true).unwrap().is_empty());
    assert!(matches!(owner(&profile), Acquisition::Activated));
    assert_eq!(activations.load(Ordering::SeqCst), 1);
}
