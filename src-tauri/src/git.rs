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
fn run(cwd: &Path, args: &[&str]) -> Result<Output, String> {
    let mut command = Command::new("git");
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
fn repository(database: &Database) -> Result<(PathBuf, PathBuf), String> {
    let workspace = explorer::workspace_root(database)?;
    let output = checked(&workspace, &["rev-parse", "--show-toplevel"])?;
    let root = PathBuf::from(String::from_utf8_lossy(&output.stdout).trim())
        .canonicalize()
        .map_err(|error| error.to_string())?;
    Ok((workspace, root))
}
pub fn status(database: &Database) -> Status {
    let result = (|| -> Result<Status, String> {
        let (workspace, root) = repository(database)?;
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
    let (workspace, _) = repository(database)?;
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
    let (workspace, root) = repository(database)?;
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
