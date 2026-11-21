//! Bounded, read-only Git queries. Never fetches, stages, commits, or runs external diffs.
use crate::{explorer, storage::Database};
use serde::Serialize;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};
const OUTPUT_LIMIT: usize = 512 * 1024;
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub path: String,
    pub index: String,
    pub worktree: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_path: Option<String>,
}
#[derive(Debug, Serialize)]
pub struct Branch {
    pub name: String,
    pub current: bool,
    pub commit: String,
}
#[derive(Debug, Serialize)]
pub struct Status {
    pub available: bool,
    pub root: Option<String>,
    pub branch: Option<String>,
    pub detached: bool,
    pub changes: Vec<Change>,
    pub branches: Vec<Branch>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub hash: String,
    pub short_hash: String,
    pub parents: Vec<String>,
    pub author: String,
    pub date: String,
    pub subject: String,
    pub refs: Vec<String>,
}
#[derive(Debug, Serialize)]
pub struct Diff {
    pub path: String,
    pub staged: bool,
    pub diff: String,
    pub truncated: bool,
}
struct Output {
    ok: bool,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    truncated: bool,
}
fn capture(mut reader: impl Read + Send + 'static, limit: usize) -> thread::JoinHandle<Vec<u8>> {
    thread::spawn(move || {
        let mut result = Vec::new();
        let mut buffer = [0; 8192];
        while let Ok(count) = reader.read(&mut buffer) {
            if count == 0 {
                break;
            }
            let remaining = limit.saturating_sub(result.len());
            result.extend_from_slice(&buffer[..count.min(remaining)]);
        }
        result
    })
}
/// The `git` a bare command name resolves to in this search path.
fn first_git(paths: &std::ffi::OsStr) -> Option<PathBuf> {
    std::env::split_paths(paths)
        .map(|directory| directory.join("git"))
        .find(|candidate| candidate.is_file())
}
/// On macOS `/usr/bin/git` is a stub for the Xcode Command Line Tools. When
/// they are not installed, running it opens the system "install developer
/// tools" dialog and fails. Any other Git in the search path is a real one.
fn is_system_stub(found: Option<&Path>) -> bool {
    found.is_none_or(|path| path == Path::new("/usr/bin/git"))
}
/// Decided once per session. Elsewhere than macOS a missing Git simply
/// fails to start, which is reported as before.
fn git_usable() -> bool {
    static USABLE: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *USABLE.get_or_init(|| {
        if !cfg!(target_os = "macos") {
            return true;
        }
        let found = std::env::var_os("PATH").and_then(|paths| first_git(&paths));
        if !is_system_stub(found.as_deref()) {
            return true;
        }
        // Prints the active developer directory; fails without one and never
        // opens a dialog.
        Command::new("xcode-select")
            .arg("-p")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    })
}
fn run(cwd: &Path, args: &[&str]) -> Result<Output, String> {
    if !git_usable() {
        return Err("Git is unavailable: install the Xcode Command Line Tools (xcode-select --install) to use Git features.".into());
    }
    let mut command = Command::new("git");
    // A desktop launched from a Git-aware shell must not inherit another
    // repository/index or injected Git configuration. Resolve only from cwd.
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("GIT_") {
            command.env_remove(key);
        }
    }
    command
        .args([
            "--no-pager",
            "--no-optional-locks",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.pager=cat",
        ])
        .args(args)
        .current_dir(cwd)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("Git is unavailable: {error}"))?;
    let stdout = capture(child.stdout.take().unwrap(), OUTPUT_LIMIT + 1);
    let stderr = capture(child.stderr.take().unwrap(), 65536);
    let deadline = Instant::now() + Duration::from_secs(5);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) if Instant::now() >= deadline => {
                #[cfg(unix)]
                unsafe {
                    libc::kill(-(child.id() as i32), libc::SIGKILL);
                }
                let _ = child.kill();
                let _ = child.wait();
                break Err("Git query exceeded its 5 second time limit.".to_string());
            }
            Ok(None) => thread::sleep(Duration::from_millis(5)),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                break Err(error.to_string());
            }
        }
    };
    let mut output = stdout.join().unwrap_or_default();
    let errors = stderr.join().unwrap_or_default();
    let status = status?;
    let truncated = output.len() > OUTPUT_LIMIT;
    output.truncate(OUTPUT_LIMIT);
    Ok(Output {
        ok: status.success(),
        stdout: output,
        stderr: errors,
        truncated,
    })
}
fn checked(cwd: &Path, args: &[&str]) -> Result<Output, String> {
    let output = run(cwd, args)?;
    if !output.ok {
        return Err(format!(
            "Git: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(output)
}
fn repository_root(directory: &Path) -> Result<PathBuf, String> {
    let output = checked(directory, &["rev-parse", "--show-toplevel"])?;
    if output.truncated {
        return Err("Git repository path exceeds its output limit.".into());
    }
    let root = PathBuf::from(String::from_utf8_lossy(&output.stdout).trim())
        .canonicalize()
        .map_err(|error| error.to_string())?;
    Ok(root)
}
fn document_repository(document_path: &str) -> Result<PathBuf, String> {
    let path = Path::new(document_path);
    if !path.is_absolute() {
        return Err("Git requires an absolute document path.".into());
    }
    let path = path.canonicalize().map_err(|error| error.to_string())?;
    if !path.is_file() {
        return Err("Git requires an existing document file.".into());
    }
    let root = repository_root(path.parent().ok_or("Document has no parent directory.")?)?;
    if !path.starts_with(&root) {
        return Err("Document is outside the Git worktree.".into());
    }
    Ok(root)
}
/// Lightweight detection: no status, history, database, or process-cwd fallback.
pub fn document_repository_root(document_path: &str) -> Option<String> {
    document_repository(document_path)
        .ok()
        .map(|root| root.to_string_lossy().into_owned())
}
fn repository(
    database: &Database,
    document_path: Option<&str>,
) -> Result<(PathBuf, PathBuf), String> {
    if let Some(path) = document_path {
        let root = document_repository(path)?;
        return Ok((root.clone(), root));
    }
    let workspace = explorer::workspace_root(database)?;
    let root = repository_root(&workspace)?;
    Ok((workspace, root))
}
pub fn status(database: &Database) -> Status {
    status_for_document(database, None)
}
pub fn status_for_document(database: &Database, document_path: Option<&str>) -> Status {
    let result = (|| -> Result<Status, String> {
        let (workspace, root) = repository(database, document_path)?;
        let branch = run(&workspace, &["symbolic-ref", "--quiet", "--short", "HEAD"])?;
        let branch = branch
            .ok
            .then(|| String::from_utf8_lossy(&branch.stdout).trim().to_string());
        let detached = branch.is_none();
        let output = checked(
            &workspace,
            &[
                "status",
                "--porcelain=v1",
                "-z",
                "--untracked-files=normal",
                "--",
                ".",
            ],
        )?;
        if output.truncated {
            return Err("Git status exceeds its 512 KiB output limit.".into());
        }
        let mut fields = output.stdout.split(|byte| *byte == 0);
        let mut changes = Vec::new();
        while let Some(field) = fields.next() {
            if field.len() < 4 {
                continue;
            }
            let index = String::from_utf8_lossy(&field[..1]).into_owned();
            let worktree = String::from_utf8_lossy(&field[1..2]).into_owned();
            let path = String::from_utf8_lossy(&field[3..]);
            let original_path =
                if matches!(field[0], b'R' | b'C') || matches!(field[1], b'R' | b'C') {
                    fields.next().map(|path| {
                        root.join(String::from_utf8_lossy(path).as_ref())
                            .to_string_lossy()
                            .into_owned()
                    })
                } else {
                    None
                };
            changes.push(Change {
                path: root.join(path.as_ref()).to_string_lossy().into(),
                index,
                worktree,
                original_path,
            });
        }
        let output = checked(
            &workspace,
            &[
                "for-each-ref",
                "--format=%(refname:short)%00%(objectname)",
                "refs/heads",
            ],
        )?;
        if output.truncated {
            return Err("Git branch list exceeds its 512 KiB output limit.".into());
        }
        let mut branches = Vec::new();
        for line in output.stdout.split(|byte| *byte == b'\n') {
            if let Some(split) = line.iter().position(|byte| *byte == 0) {
                let name = String::from_utf8_lossy(&line[..split]).into_owned();
                branches.push(Branch {
                    current: branch.as_ref() == Some(&name),
                    name,
                    commit: String::from_utf8_lossy(&line[split + 1..]).into_owned(),
                });
            }
        }
        Ok(Status {
            available: true,
            root: Some(root.to_string_lossy().into()),
            branch,
            detached,
            changes,
            branches,
            error: None,
        })
    })();
    result.unwrap_or_else(|error| Status {
        available: false,
        root: None,
        branch: None,
        detached: false,
        changes: vec![],
        branches: vec![],
        error: Some(error),
    })
}
pub fn history(database: &Database, limit: Option<usize>) -> Result<Vec<Commit>, String> {
    history_for_document(database, limit, None)
}
pub fn history_for_document(
    database: &Database,
    limit: Option<usize>,
    document_path: Option<&str>,
) -> Result<Vec<Commit>, String> {
    let (workspace, _) = repository(database, document_path)?;
    if !run(&workspace, &["rev-parse", "--verify", "HEAD"])?.ok {
        return Ok(vec![]);
    }
    let limit = limit.unwrap_or(50).clamp(1, 200).to_string();
    let output = checked(
        &workspace,
        &[
            "log",
            "--all",
            "--date-order",
            "-n",
            &limit,
            "--format=%H%x00%h%x00%P%x00%an%x00%aI%x00%s%x00%D%x1e",
        ],
    )?;
    if output.truncated {
        return Err("Git history exceeds its output limit.".into());
    }
    let mut commits = Vec::new();
    for record in String::from_utf8_lossy(&output.stdout).split('\x1e') {
        let fields = record
            .trim_start_matches('\n')
            .split('\0')
            .collect::<Vec<_>>();
        if fields.len() != 7 {
            continue;
        }
        commits.push(Commit {
            hash: fields[0].into(),
            short_hash: fields[1].into(),
            parents: fields[2].split_whitespace().map(str::to_string).collect(),
            author: fields[3].into(),
            date: fields[4].into(),
            subject: fields[5].into(),
            refs: fields[6]
                .split(',')
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .map(str::to_string)
                .collect(),
        });
    }
    Ok(commits)
}
pub fn diff(database: &Database, path: &str, staged: bool) -> Result<Diff, String> {
    diff_for_document(database, path, staged, None)
}
pub fn diff_for_document(
    database: &Database,
    path: &str,
    staged: bool,
    document_path: Option<&str>,
) -> Result<Diff, String> {
    let (workspace, root) = repository(database, document_path)?;
    let requested = if Path::new(path).is_absolute() {
        PathBuf::from(path)
    } else {
        root.join(path)
    };
    let requested = explorer::resolve_allow_missing(&workspace, &requested.to_string_lossy())?;
    let relative = requested
        .strip_prefix(&root)
        .map_err(|_| "Diff path is outside the repository.")?
        .to_string_lossy();
    let mut args = vec!["diff", "--no-ext-diff", "--no-textconv", "--no-color"];
    if staged {
        args.push("--cached");
    }
    args.extend(["--", relative.as_ref()]);
    let tracked = run(
        &root,
        &["ls-files", "--error-unmatch", "--", relative.as_ref()],
    )?
    .ok;
    let output = if !staged && !tracked {
        if !requested.is_file() {
            return Err("This file is untracked and no longer exists.".into());
        }
        #[cfg(windows)]
        let empty = "NUL";
        #[cfg(not(windows))]
        let empty = "/dev/null";
        let output = run(
            &root,
            &[
                "diff",
                "--no-index",
                "--no-ext-diff",
                "--no-textconv",
                "--no-color",
                "--",
                empty,
                &requested.to_string_lossy(),
            ],
        )?;
        if !output.ok && output.stdout.is_empty() && !output.stderr.is_empty() {
            return Err(format!(
                "Git diff: {}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }
        output
    } else {
        checked(&root, &args)?
    };
    let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
    if output.truncated {
        text.push_str("\n[diff truncated at 512 KiB]\n");
    }
    Ok(Diff {
        path: requested.to_string_lossy().into(),
        staged,
        diff: text,
        truncated: output.truncated,
    })
}

#[cfg(test)]
mod stub_tests {
    use super::*;

    #[test]
    fn the_first_git_in_the_search_path_decides_whether_it_is_the_system_stub() {
        let temporary = tempfile::tempdir().unwrap();
        let (empty, tools, other) = (
            temporary.path().join("empty"),
            temporary.path().join("tools"),
            temporary.path().join("other"),
        );
        for directory in [&empty, &tools, &other] {
            std::fs::create_dir(directory).unwrap();
        }
        std::fs::write(tools.join("git"), "").unwrap();
        std::fs::write(other.join("git"), "").unwrap();
        // A directory named git is not an executable.
        std::fs::create_dir(empty.join("git")).unwrap();
        let search = |directories: &[&PathBuf]| first_git(&std::env::join_paths(directories).unwrap());
        assert_eq!(search(&[&empty, &tools, &other]), Some(tools.join("git")));
        assert_eq!(search(&[&other, &tools]), Some(other.join("git")));
        assert_eq!(search(&[&empty]), None);

        assert!(is_system_stub(None));
        assert!(is_system_stub(Some(Path::new("/usr/bin/git"))));
        assert!(!is_system_stub(Some(Path::new("/opt/homebrew/bin/git"))));
        assert!(!is_system_stub(Some(&tools.join("git"))));
        // Only macOS has the stub; everywhere else Git is simply tried.
        if !cfg!(target_os = "macos") {
            assert!(git_usable());
        }
    }
}
