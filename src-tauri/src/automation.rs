//! Explicit, trusted local automation. The child process isolates crashes and CPU
//! work from the editor; filesystem and command access are not a security sandbox.
use rquickjs::{Context, Function, Runtime};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

const MAX_TEXT: usize = 4 * 1024 * 1024;
const MAX_CODE: usize = 128 * 1024;
const MAX_OUTPUT: usize = 256 * 1024;
const MAX_LOGS: usize = 64 * 1024;
const MAX_RESULT: usize = 1024 * 1024;
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptDocument {
    pub name: String,
    pub path: Option<String>,
    pub text: String,
    pub selection: String,
    pub from: usize,
    pub to: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScriptRequest {
    pub id: String,
    pub code: String,
    pub cwd: Option<String>,
    pub document: ScriptDocument,
    #[serde(default, rename = "scriptId")]
    pub script_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScriptLog {
    pub level: String,
    pub message: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ScriptResponse {
    pub id: String,
    pub ok: bool,
    pub logs: Vec<ScriptLog>,
    pub result: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl ScriptResponse {
    fn failure(id: String, message: impl Into<String>) -> Self {
        Self {
            id,
            ok: false,
            logs: vec![],
            result: Value::Null,
            error: Some(message.into()),
        }
    }
}

#[derive(Clone, Default)]
pub struct ScriptManager {
    active: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

impl ScriptManager {
    pub fn stop(&self, id: &str) -> bool {
        self.active.lock().unwrap().get(id).is_some_and(|cancel| {
            cancel.store(true, Ordering::SeqCst);
            true
        })
    }

    pub fn run(&self, executable: &Path, request: ScriptRequest) -> Result<ScriptResponse, String> {
        self.run_with_timeout(executable, request, DEFAULT_TIMEOUT)
    }

    pub fn run_with_timeout(
        &self,
        executable: &Path,
        request: ScriptRequest,
        timeout: Duration,
    ) -> Result<ScriptResponse, String> {
        validate(&request)?;
        let cancel = Arc::new(AtomicBool::new(false));
        {
            let mut active = self.active.lock().unwrap();
            if active.contains_key(&request.id) {
                return Err("This automation is already running.".into());
            }
            if active.len() >= 4 {
                return Err("Stop a running automation before starting another.".into());
            }
            active.insert(request.id.clone(), cancel.clone());
        }
        let result = supervise(executable, &request, cancel, timeout);
        self.active.lock().unwrap().remove(&request.id);
        result
    }
}

fn validate(request: &ScriptRequest) -> Result<(), String> {
    if request.id.is_empty() || request.id.len() > 128 {
        return Err("Automation needs a run identifier of 1–128 characters.".into());
    }
    if request.code.len() > MAX_CODE {
        return Err("Automation code exceeds the 128 KiB limit.".into());
    }
    if request.document.text.len() > MAX_TEXT || request.document.selection.len() > MAX_TEXT {
        return Err("Automation document exceeds the 4 MiB limit.".into());
    }
    Ok(())
}

fn supervise(
    executable: &Path,
    request: &ScriptRequest,
    cancel: Arc<AtomicBool>,
    timeout: Duration,
) -> Result<ScriptResponse, String> {
    let mut command = Command::new(executable);
    command
        .arg("--script-worker")
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
        .map_err(|error| format!("Could not start automation: {error}"))?;
    let stdout = capture(
        child.stdout.take().unwrap(),
        MAX_RESULT + MAX_LOGS * 6 + 8192,
    );
    let stderr = capture(child.stderr.take().unwrap(), MAX_LOGS);
    let payload = serde_json::to_vec(request).map_err(|error| error.to_string())?;
    if let Err(error) = child.stdin.take().unwrap().write_all(&payload) {
        terminate_worker(&mut child);
        let _ = stdout.join();
        let _ = stderr.join();
        return Err(format!("Could not send automation to worker: {error}"));
    }
    let deadline = Instant::now() + timeout;
    let mut failure = None;
    let status = loop {
        if cancel.load(Ordering::SeqCst) {
            failure = Some(
                "Automation stopped. File and command changes already made are kept.".to_string(),
            );
            terminate_worker(&mut child);
            break child.wait();
        }
        if Instant::now() >= deadline {
            failure = Some(format!("Automation exceeded its {} ms time limit and was stopped. Changes already made are kept.", timeout.as_millis()));
            terminate_worker(&mut child);
            break child.wait();
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                terminate_group(child.id());
                break Ok(status);
            }
            Ok(None) => thread::sleep(Duration::from_millis(10)),
            Err(error) => {
                terminate_worker(&mut child);
                break Err(error);
            }
        }
    };
    let output = stdout.join().unwrap_or_default();
    let diagnostics = stderr.join().unwrap_or_default();
    if let Some(message) = failure {
        return Ok(ScriptResponse::failure(request.id.clone(), message));
    }
    let status = status.map_err(|error| format!("Could not wait for automation: {error}"))?;
    if !status.success() {
        return Ok(ScriptResponse::failure(
            request.id.clone(),
            format!(
                "Automation worker exited ({status}). {}",
                String::from_utf8_lossy(&diagnostics)
            ),
        ));
    }
    serde_json::from_slice(&output)
        .map_err(|error| format!("Automation returned an invalid response: {error}"))
}

fn capture(mut reader: impl Read + Send + 'static, maximum: usize) -> thread::JoinHandle<Vec<u8>> {
    thread::spawn(move || {
        let mut result = Vec::new();
        let mut buffer = [0u8; 8192];
        while let Ok(count) = reader.read(&mut buffer) {
            if count == 0 {
                break;
            }
            let remaining = maximum.saturating_sub(result.len());
            result.extend_from_slice(&buffer[..count.min(remaining)]);
        }
        result
    })
}

fn terminate_group(id: u32) {
    #[cfg(unix)]
    unsafe {
        libc::kill(-(id as i32), libc::SIGKILL);
    }
    #[cfg(not(unix))]
    let _ = id;
}

fn terminate_worker(child: &mut Child) {
    terminate_group(child.id());
    let _ = child.kill();
}

// Commands inherit the worker's process group. Killing that group on Stop,
// timeout or completion also closes pipes held by ordinary background children.
// A command timeout kills its subtree without killing the JavaScript worker.
fn terminate_command(child: &mut Child) {
    #[cfg(target_os = "linux")]
    fn descendants(pid: u32) {
        if let Ok(children) = std::fs::read_to_string(format!("/proc/{pid}/task/{pid}/children")) {
            for child in children
                .split_whitespace()
                .filter_map(|child| child.parse::<u32>().ok())
            {
                descendants(child);
                unsafe {
                    libc::kill(child as i32, libc::SIGKILL);
                }
            }
        }
    }
    #[cfg(target_os = "linux")]
    descendants(child.id());
    let _ = child.kill();
}

pub fn worker_main() {
    let mut input = String::new();
    let response = match std::io::stdin()
        .take((MAX_TEXT * 2 + MAX_CODE + 8192) as u64)
        .read_to_string(&mut input)
    {
        Ok(_) => match serde_json::from_str::<ScriptRequest>(&input) {
            Ok(request) => execute(request, DEFAULT_TIMEOUT),
            Err(error) => ScriptResponse::failure(
                String::new(),
                format!("Invalid automation request: {error}"),
            ),
        },
        Err(error) => ScriptResponse::failure(
            String::new(),
            format!("Could not read automation request: {error}"),
        ),
    };
    if let Ok(response) = serde_json::to_vec(&response) {
        let _ = std::io::stdout().write_all(&response);
    }
}

fn bounded(text: &str, maximum: usize) -> String {
    if text.len() <= maximum {
        return text.to_string();
    }
    let mut end = maximum;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n[output truncated]", &text[..end])
}

fn resolve(cwd: &Path, value: &str) -> Result<PathBuf, String> {
    if value.is_empty() {
        return Err("Choose a nonempty filesystem path.".into());
    }
    let path = Path::new(value);
    Ok(if path.is_absolute() {
        path.to_path_buf()
    } else {
        cwd.join(path)
    })
}

fn string_arg(args: &[Value], index: usize, name: &str) -> Result<String, String> {
    args.get(index)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| format!("{name} must be a string."))
}

fn host_call(method: &str, args: &[Value], cwd: &Path, deadline: Instant) -> Result<Value, String> {
    match method {
        "readText" => {
            let path = resolve(cwd, &string_arg(args, 0, "path")?)?;
            let file = std::fs::File::open(&path)
                .map_err(|error| format!("Could not read {}: {error}", path.display()))?;
            if !file
                .metadata()
                .map_err(|error| error.to_string())?
                .is_file()
            {
                return Err("readText expects a regular file.".into());
            }
            let mut bytes = Vec::new();
            file.take((MAX_TEXT + 1) as u64)
                .read_to_end(&mut bytes)
                .map_err(|error| error.to_string())?;
            if bytes.len() > MAX_TEXT {
                return Err("readText exceeds the 4 MiB limit.".into());
            }
            String::from_utf8(bytes)
                .map(Value::String)
                .map_err(|_| "File is not valid UTF-8 text.".into())
        }
        "writeText" => {
            let path = resolve(cwd, &string_arg(args, 0, "path")?)?;
            let content = string_arg(args, 1, "content")?;
            if content.len() > MAX_TEXT {
                return Err("writeText exceeds the 4 MiB limit.".into());
            }
            crate::documents::write_document(
                path.to_str().ok_or("Path is not valid UTF-8.")?,
                &content,
            )?;
            Ok(Value::Null)
        }
        "listDir" => {
            let path = resolve(cwd, &string_arg(args, 0, "path")?)?;
            let entries = std::fs::read_dir(&path)
                .map_err(|error| format!("Could not list {}: {error}", path.display()))?;
            let mut result = Vec::new();
            for entry in entries {
                if result.len() >= 2000 {
                    return Err("listDir exceeds the 2,000 entry limit.".into());
                }
                let entry = entry.map_err(|error| error.to_string())?;
                let kind = entry.file_type().map_err(|error| error.to_string())?;
                result.push(json!({"name":entry.file_name().to_string_lossy(),"path":entry.path().to_string_lossy(),"isDir":kind.is_dir(),"isFile":kind.is_file()}));
            }
            result.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
            Ok(Value::Array(result))
        }
        "run" => {
            let program = string_arg(args, 0, "program")?;
            if program.is_empty() {
                return Err("Choose a command program.".into());
            }
            let arguments: Vec<String> =
                serde_json::from_value(args.get(1).cloned().unwrap_or_else(|| json!([])))
                    .map_err(|_| "Command arguments must be an array of strings.")?;
            let options = args.get(2).cloned().unwrap_or_else(|| json!({}));
            let command_cwd = match options.get("cwd").and_then(Value::as_str) {
                Some(path) => resolve(cwd, path)?,
                None => cwd.to_path_buf(),
            };
            let timeout = options
                .get("timeoutMs")
                .and_then(Value::as_u64)
                .unwrap_or(15_000)
                .clamp(1, 15_000);
            let command_deadline = (Instant::now() + Duration::from_millis(timeout)).min(deadline);
            let mut child = Command::new(&program)
                .args(arguments)
                .current_dir(command_cwd)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .map_err(|error| format!("Could not run {program}: {error}"))?;
            let stdout = capture(child.stdout.take().unwrap(), MAX_OUTPUT + 1);
            let stderr = capture(child.stderr.take().unwrap(), MAX_OUTPUT + 1);
            let mut timed_out = false;
            let status = loop {
                match child.try_wait() {
                    Ok(Some(status)) => break Ok(status),
                    Ok(None) if Instant::now() >= command_deadline => {
                        timed_out = true;
                        terminate_command(&mut child);
                        break child.wait();
                    }
                    Ok(None) => thread::sleep(Duration::from_millis(5)),
                    Err(error) => {
                        terminate_command(&mut child);
                        break Err(error);
                    }
                }
            };
            let out = stdout.join().unwrap_or_default();
            let err = stderr.join().unwrap_or_default();
            let status =
                status.map_err(|error| format!("Could not wait for {program}: {error}"))?;
            Ok(
                json!({"exitCode":status.code(),"stdout":bounded(&String::from_utf8_lossy(&out),MAX_OUTPUT),"stderr":bounded(&String::from_utf8_lossy(&err),MAX_OUTPUT),"timedOut":timed_out}),
            )
        }
        _ => Err(format!("Unknown automation API: {method}")),
    }
}

pub fn execute(request: ScriptRequest, timeout: Duration) -> ScriptResponse {
    if let Err(error) = validate(&request) {
        return ScriptResponse::failure(request.id, error);
    }
    let cwd = request
        .cwd
        .as_ref()
        .map(PathBuf::from)
        .or_else(|| {
            request
                .document
                .path
                .as_ref()
                .and_then(|path| Path::new(path).parent().map(Path::to_path_buf))
        })
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    let cwd = match cwd.canonicalize() {
        Ok(path) if path.is_dir() => path,
        _ => {
            return ScriptResponse::failure(
                request.id,
                "Working directory does not exist or is not a directory.",
            )
        }
    };
    let deadline = Instant::now() + timeout;
    let runtime = match Runtime::new() {
        Ok(runtime) => runtime,
        Err(error) => return ScriptResponse::failure(request.id, error.to_string()),
    };
    runtime.set_memory_limit(64 * 1024 * 1024);
    runtime.set_max_stack_size(512 * 1024);
    runtime.set_interrupt_handler(Some(Box::new(move || Instant::now() >= deadline)));
    let context = match Context::full(&runtime) {
        Ok(context) => context,
        Err(error) => return ScriptResponse::failure(request.id, error.to_string()),
    };
    let logs = std::rc::Rc::new(std::cell::RefCell::new(Vec::<ScriptLog>::new()));
    let captured_logs = logs.clone();
    let context_json = json!({"document":request.document,"cwd":cwd.to_string_lossy()}).to_string();
    let result = context.with(|ctx| -> Result<Value, String> {
        let host = Function::new(ctx.clone(), move |method: String, arguments: String| -> String {
            let result = serde_json::from_str::<Vec<Value>>(&arguments).map_err(|error| error.to_string()).and_then(|args| host_call(&method,&args,&cwd,deadline));
            match result { Ok(value) => json!({"ok":true,"value":value}).to_string(), Err(error) => json!({"ok":false,"error":error}).to_string() }
        }).map_err(|error| error.to_string())?;
        ctx.globals().set("__host", host).map_err(|error| error.to_string())?;
        let log = Function::new(ctx.clone(), move |level: String, message: String| {
            let mut logs = captured_logs.borrow_mut();
            let used: usize = logs.iter().map(|log| log.message.len()).sum();
            if logs.len() < 128 && used < MAX_LOGS { logs.push(ScriptLog { level, message: bounded(&message, (MAX_LOGS - used).min(8192)) }); }
        }).map_err(|error| error.to_string())?;
        ctx.globals().set("__log", log).map_err(|error| error.to_string())?;
        let bootstrap = format!(r#"
const api = Object.freeze({{
  context: {context_json},
  ...Object.fromEntries(['readText','writeText','listDir','run'].map(name => [name, (...args) => {{
    const response = JSON.parse(__host(name, JSON.stringify(args)));
    if (!response.ok) throw new Error(response.error);
    return response.value;
  }}]))
}});
const console = Object.freeze(Object.fromEntries(['log','info','warn','error'].map(level => [level, (...args) => __log(level,args.map(value => typeof value === 'string' ? value : JSON.stringify(value) ?? String(value)).join(' '))])));
"#);
        ctx.eval::<(),_>(bootstrap).map_err(|error| error.to_string())?;
        let code = format!(r#"JSON.stringify((() => {{ 'use strict'; const value = (() => {{
{}
}})(); if (value && typeof value.then === 'function') throw new Error('Scripts are synchronous. Return a value directly; api.run is synchronous.'); return value === undefined ? null : value; }})())"#,request.code);
        match ctx.eval::<String,_>(code) {
            Ok(value) if value.len() <= MAX_RESULT => serde_json::from_str(&value).map_err(|error| error.to_string()),
            Ok(_) => Err("Automation result exceeds the 1 MiB limit.".into()),
            Err(error) => {
                let exception = ctx.catch();
                let message = if let Some(object) = exception.as_object() {
                    let message = object.get::<_,String>("message").unwrap_or_else(|_| error.to_string());
                    let stack = object.get::<_,String>("stack").unwrap_or_default();
                    format!("{message}\n{stack}")
                } else if let Some(string) = exception.as_string() { string.to_string().unwrap_or_else(|_| error.to_string()) } else { error.to_string() };
                Err(if Instant::now() >= deadline { "Automation exceeded its time limit.".into() } else { bounded(&message,8192) })
            }
        }
    });
    let logs = logs.borrow().clone();
    match result {
        Ok(result) => ScriptResponse {
            id: request.id,
            ok: true,
            logs,
            result,
            error: None,
        },
        Err(error) => ScriptResponse {
            id: request.id,
            ok: false,
            logs,
            result: Value::Null,
            error: Some(error),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request(code: &str) -> ScriptRequest {
        ScriptRequest {
            id: "test".into(),
            code: code.into(),
            cwd: None,
            document: ScriptDocument {
                name: "note.md".into(),
                path: None,
                text: "hello".into(),
                selection: "ell".into(),
                from: 1,
                to: 4,
            },
            script_id: None,
        }
    }
    #[test]
    fn evaluates_javascript_context_and_captured_logs() {
        let response = execute(request("console.log('answer', 6 * 7); return {text: api.context.document.selection.toUpperCase(), answer:42};"),DEFAULT_TIMEOUT);
        assert!(response.ok, "{:?}", response.error);
        assert_eq!(response.result, json!({"text":"ELL","answer":42}));
        assert_eq!(response.logs[0].message, "answer 42");
    }
    #[test]
    fn reads_writes_and_lists_relative_files() {
        let directory = tempfile::tempdir().unwrap();
        let mut input = request("api.writeText('nota.md', 'Hola 日本語'); return {text:api.readText('nota.md'), files:api.listDir('.')};");
        input.cwd = Some(directory.path().to_string_lossy().into());
        let response = execute(input, DEFAULT_TIMEOUT);
        assert!(response.ok, "{:?}", response.error);
        assert_eq!(response.result["text"], "Hola 日本語");
        assert_eq!(response.result["files"][0]["name"], "nota.md");
        assert_eq!(
            std::fs::read_to_string(directory.path().join("nota.md")).unwrap(),
            "Hola 日本語"
        );
    }
    #[cfg(unix)]
    #[test]
    fn commands_receive_literal_args_and_capture_output_exit_code() {
        let response = execute(
            request("return api.run('sh', ['-c', 'printf hello; printf problem >&2; exit 7']);"),
            DEFAULT_TIMEOUT,
        );
        assert!(response.ok, "{:?}", response.error);
        assert_eq!(
            response.result,
            json!({"exitCode":7,"stdout":"hello","stderr":"problem","timedOut":false})
        );
        let literal = execute(
            request("return api.run('printf', ['%s', '$(echo unsafe)']);"),
            DEFAULT_TIMEOUT,
        );
        assert_eq!(literal.result["stdout"], "$(echo unsafe)");
    }
    #[test]
    fn reports_js_and_host_errors_and_preserves_prior_logs() {
        for code in [
            "console.log('before'); throw new Error('broken script');",
            "console.log('before'); api.readText('/definitely-missing-notation-file');",
        ] {
            let response = execute(request(code), DEFAULT_TIMEOUT);
            assert!(!response.ok);
            assert!(response.error.is_some());
            assert_eq!(response.logs[0].message, "before");
        }
        assert!(
            execute(request("return Promise.resolve(42);"), DEFAULT_TIMEOUT)
                .error
                .unwrap()
                .contains("synchronous")
        );
    }
    #[test]
    fn interrupts_infinite_loops_and_limits_logs_and_results() {
        let started = Instant::now();
        let response = execute(request("while(true) {}"), Duration::from_millis(30));
        assert!(!response.ok);
        assert!(started.elapsed() < Duration::from_secs(2));
        let response = execute(
            request("for(let i=0;i<200;i++) console.log('x'.repeat(9000)); return 1;"),
            DEFAULT_TIMEOUT,
        );
        assert!(response.ok);
        assert!(response.logs.len() <= 128);
        assert!(
            response
                .logs
                .iter()
                .map(|log| log.message.len())
                .sum::<usize>()
                < MAX_LOGS + 200
        );
        assert!(!execute(request("return 'x'.repeat(1100000);"), DEFAULT_TIMEOUT).ok);
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn command_timeout_kills_normal_descendants() {
        let response = execute(
            request("return api.run('sh', ['-c', 'sleep 10 & wait'], {timeoutMs:30});"),
            DEFAULT_TIMEOUT,
        );
        assert!(response.ok, "{:?}", response.error);
        assert_eq!(response.result["timedOut"], true);
    }
}
