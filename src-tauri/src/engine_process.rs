//! Engine subprocesses run through a same-app worker so sandbox setup happens
//! after exec, away from the multithreaded GUI's fork/pre_exec boundary.
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    io::{Read, Write},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};
#[derive(Debug, Serialize, Deserialize)]
pub struct JobSpec {
    pub program: PathBuf,
    pub arguments: Vec<String>,
    pub cwd: PathBuf,
    pub input: Option<PathBuf>,
    pub read_paths: Vec<PathBuf>,
    pub environment: HashMap<String, String>,
}
pub struct Output {
    pub stdout: Vec<u8>,
    pub stderr: String,
}
fn capture(
    mut reader: impl Read + Send + 'static,
    limit: usize,
    overflow: Arc<AtomicBool>,
) -> thread::JoinHandle<Vec<u8>> {
    thread::spawn(move || {
        let mut output = Vec::new();
        let mut buffer = [0; 8192];
        while let Ok(count) = reader.read(&mut buffer) {
            if count == 0 {
                break;
            }
            let remaining = limit.saturating_sub(output.len());
            output.extend_from_slice(&buffer[..count.min(remaining)]);
            if count > remaining {
                overflow.store(true, Ordering::SeqCst);
            }
        }
        output
    })
}
fn terminate(child: &mut Child) {
    #[cfg(unix)]
    unsafe {
        libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
    let _ = child.kill();
    let _ = child.wait();
}
fn rss(pid: u32) -> usize {
    std::fs::read_to_string(format!("/proc/{pid}/status"))
        .ok()
        .and_then(|text| {
            text.lines().find_map(|line| {
                line.strip_prefix("VmRSS:")
                    .and_then(|line| line.split_whitespace().next())
                    .and_then(|number| number.parse::<usize>().ok())
            })
        })
        .unwrap_or(0)
        * 1024
}
pub fn run(
    worker: &std::path::Path,
    spec: JobSpec,
    cancel: &Arc<AtomicBool>,
    deadline: Instant,
    stdout_limit: usize,
) -> Result<Output, String> {
    if cancel.load(Ordering::SeqCst) {
        return Err("Export cancelled. The destination was kept unchanged.".into());
    }
    if Instant::now() >= deadline {
        return Err("Native engine exceeded its time limit.".into());
    }
    let mut command = Command::new(worker);
    command
        .arg("--engine-worker")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("Could not start bundled engine worker: {error}"))?;
    let overflow = Arc::new(AtomicBool::new(false));
    let stdout = capture(child.stdout.take().unwrap(), stdout_limit, overflow.clone());
    let stderr = capture(
        child.stderr.take().unwrap(),
        64 * 1024,
        Arc::new(AtomicBool::new(false)),
    );
    if let Err(error) = child
        .stdin
        .take()
        .unwrap()
        .write_all(&serde_json::to_vec(&spec).map_err(|error| error.to_string())?)
    {
        terminate(&mut child);
        let _ = stdout.join();
        let _ = stderr.join();
        return Err(error.to_string());
    }
    let mut failure = None;
    let status = loop {
        if cancel.load(Ordering::SeqCst) {
            failure = Some("Export cancelled. The destination was kept unchanged.".to_string());
            terminate(&mut child);
            break None;
        }
        if Instant::now() >= deadline {
            failure = Some("Native engine exceeded its time limit and was stopped.".into());
            terminate(&mut child);
            break None;
        }
        if overflow.load(Ordering::SeqCst) {
            failure = Some("Native engine output exceeded its size limit.".into());
            terminate(&mut child);
            break None;
        }
        if rss(child.id()) > 1024 * 1024 * 1024 {
            failure = Some("Native engine exceeded its 1 GiB resident-memory limit.".into());
            terminate(&mut child);
            break None;
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                #[cfg(unix)]
                unsafe {
                    libc::kill(-(child.id() as i32), libc::SIGKILL);
                }
                break Some(status);
            }
            Ok(None) => thread::sleep(Duration::from_millis(10)),
            Err(error) => {
                failure = Some(error.to_string());
                terminate(&mut child);
                break None;
            }
        }
    };
    let stdout = stdout.join().unwrap_or_default();
    let stderr = String::from_utf8_lossy(&stderr.join().unwrap_or_default()).into_owned();
    if let Some(error) = failure {
        return Err(format!("{error} {}", stderr.trim()));
    }
    if !status.is_some_and(|status| status.success()) {
        let program = spec
            .program
            .file_name()
            .unwrap_or_default()
            .to_string_lossy();
        let status = status
            .map(|status| status.to_string())
            .unwrap_or_else(|| "exit status unavailable".into());
        let detail = if stderr.trim().is_empty() {
            "The engine produced no error output."
        } else {
            stderr.trim()
        };
        return Err(format!(
            "Bundled engine {program} failed ({status}): {detail}"
        ));
    }
    Ok(Output { stdout, stderr })
}
#[cfg(target_os = "linux")]
pub fn sandbox_available() -> bool {
    unsafe {
        libc::syscall(
            libc::SYS_landlock_create_ruleset,
            std::ptr::null::<libc::c_void>(),
            0,
            1,
        ) >= 3
    }
}
#[cfg(not(target_os = "linux"))]
pub fn sandbox_available() -> bool {
    false
}
#[cfg(target_os = "linux")]
fn restrict(spec: &JobSpec) -> Result<(), String> {
    use landlock::{
        path_beneath_rules, Access, AccessFs, CompatLevel, Compatible, Ruleset, RulesetAttr,
        RulesetCreatedAttr, RulesetStatus, ABI,
    };
    let abi = ABI::V3;
    let read = AccessFs::from_read(abi);
    let all = AccessFs::from_all(abi);
    let mut paths = spec.read_paths.clone();
    for path in [
        "/lib",
        "/lib64",
        "/usr/lib",
        "/usr/lib64",
        "/dev/urandom",
        "/dev/random",
        "/proc/self",
        "/proc/meminfo",
        "/proc/cpuinfo",
        "/sys/fs/cgroup",
    ] {
        let path = PathBuf::from(path);
        if path.exists() {
            paths.push(path);
        }
    }
    let status = Ruleset::default()
        .set_compatibility(CompatLevel::HardRequirement)
        .handle_access(all)
        .map_err(|error| error.to_string())?
        .create()
        .map_err(|error| error.to_string())?
        .add_rules(path_beneath_rules(&paths, read))
        .map_err(|error| error.to_string())?
        .add_rules(path_beneath_rules(
            [&spec.cwd, &PathBuf::from("/dev/null")],
            all,
        ))
        .map_err(|error| error.to_string())?
        .restrict_self()
        .map_err(|error| error.to_string())?;
    if status.ruleset != RulesetStatus::FullyEnforced {
        return Err("The native-engine filesystem sandbox could not be fully enforced.".into());
    }
    #[cfg(target_arch = "x86_64")]
    let audit_arch = 0xc000003e;
    #[cfg(target_arch = "aarch64")]
    let audit_arch = 0xc00000b7;
    #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
    return Err("Unsupported native-engine sandbox architecture.".into());
    let mut filters = vec![
        libc::sock_filter {
            code: (libc::BPF_LD | libc::BPF_W | libc::BPF_ABS) as u16,
            jt: 0,
            jf: 0,
            k: 4,
        },
        libc::sock_filter {
            code: (libc::BPF_JMP | libc::BPF_JEQ | libc::BPF_K) as u16,
            jt: 1,
            jf: 0,
            k: audit_arch,
        },
        libc::sock_filter {
            code: (libc::BPF_RET | libc::BPF_K) as u16,
            jt: 0,
            jf: 0,
            k: libc::SECCOMP_RET_KILL_PROCESS,
        },
        libc::sock_filter {
            code: (libc::BPF_LD | libc::BPF_W | libc::BPF_ABS) as u16,
            jt: 0,
            jf: 0,
            k: 0,
        },
        libc::sock_filter {
            code: (libc::BPF_JMP | libc::BPF_JGE | libc::BPF_K) as u16,
            jt: 0,
            jf: 1,
            k: 0x40000000,
        },
        libc::sock_filter {
            code: (libc::BPF_RET | libc::BPF_K) as u16,
            jt: 0,
            jf: 0,
            k: libc::SECCOMP_RET_KILL_PROCESS,
        },
    ];
    for syscall in [
        libc::SYS_socket,
        libc::SYS_socketpair,
        libc::SYS_connect,
        libc::SYS_bind,
        libc::SYS_sendto,
        libc::SYS_sendmsg,
    ] {
        filters.push(libc::sock_filter {
            code: (libc::BPF_JMP | libc::BPF_JEQ | libc::BPF_K) as u16,
            jt: 0,
            jf: 1,
            k: syscall as u32,
        });
        filters.push(libc::sock_filter {
            code: (libc::BPF_RET | libc::BPF_K) as u16,
            jt: 0,
            jf: 0,
            k: libc::SECCOMP_RET_ERRNO | (libc::EPERM as u32),
        });
    }
    filters.push(libc::sock_filter {
        code: (libc::BPF_RET | libc::BPF_K) as u16,
        jt: 0,
        jf: 0,
        k: libc::SECCOMP_RET_ALLOW,
    });
    let program = libc::sock_fprog {
        len: filters.len() as u16,
        filter: filters.as_mut_ptr(),
    };
    unsafe {
        if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0
            || libc::prctl(libc::PR_SET_SECCOMP, libc::SECCOMP_MODE_FILTER, &program) != 0
        {
            return Err(format!(
                "Native-engine network sandbox: {}",
                std::io::Error::last_os_error()
            ));
        }
        let file_limit = libc::rlimit {
            rlim_cur: 64 * 1024 * 1024,
            rlim_max: 64 * 1024 * 1024,
        };
        if libc::setrlimit(libc::RLIMIT_FSIZE, &file_limit) != 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let core_limit = libc::rlimit {
            rlim_cur: 0,
            rlim_max: 0,
        };
        libc::setrlimit(libc::RLIMIT_CORE, &core_limit);
    }
    Ok(())
}
#[cfg(not(target_os = "linux"))]
fn restrict(_spec: &JobSpec) -> Result<(), String> {
    Err("Bundled native engines currently require Linux with Landlock support.".into())
}
pub fn worker_main() {
    let result = (|| -> Result<(), String> {
        let mut input = String::new();
        std::io::stdin()
            .take(64 * 1024)
            .read_to_string(&mut input)
            .map_err(|error| error.to_string())?;
        let spec: JobSpec = serde_json::from_str(&input).map_err(|error| error.to_string())?;
        if !spec.cwd.is_dir() {
            return Err("Native engine temporary directory is missing.".into());
        }
        #[cfg(target_os = "linux")]
        unsafe {
            libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL);
        }
        restrict(&spec)?;
        let mut command = Command::new(&spec.program);
        command
            .args(&spec.arguments)
            .current_dir(&spec.cwd)
            .env_clear()
            .envs(spec.environment);
        if let Some(input) = spec.input {
            command.stdin(std::fs::File::open(input).map_err(|error| error.to_string())?);
        } else {
            command.stdin(Stdio::null());
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            Err(command.exec().to_string())
        }
        #[cfg(not(unix))]
        {
            let _ = command;
            Err("Unsupported native-engine platform.".into())
        }
    })();
    if let Err(error) = result {
        eprintln!("{error}");
        std::process::exit(126);
    }
}
