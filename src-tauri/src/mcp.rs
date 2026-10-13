//! Local stdio MCP adapter plus a private, per-user bridge to the live editor.
//! Implements the tools subset of 2026-07-28 and legacy 2025-11-25.
use crate::{
    explorer, git,
    storage::{self, Database},
};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;
const MODERN: &str = "2026-07-28";
const LEGACY: &str = "2025-11-25";
const FRAME_LIMIT: usize = 32 * 1024 * 1024;
const TEXT_LIMIT: usize = 4 * 1024 * 1024;
type Reply = Result<Value, String>;
type Emitter = Arc<dyn Fn(Value) -> Result<(), String> + Send + Sync>;
#[cfg(unix)]
struct ConnectionPermit(Arc<std::sync::atomic::AtomicUsize>);
#[cfg(unix)]
impl Drop for ConnectionPermit {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}
#[derive(Clone, Default)]
pub struct AgentBridge {
    ready: Arc<AtomicBool>,
    sequence: Arc<AtomicU64>,
    pending: Arc<Mutex<HashMap<String, mpsc::Sender<Reply>>>>,
}
impl AgentBridge {
    pub fn set_ready(&self, ready: bool) {
        self.ready.store(ready, Ordering::SeqCst);
    }
    pub fn ready(&self) -> bool {
        self.ready.load(Ordering::SeqCst)
    }
    pub fn complete(&self, id: &str, result: Option<Value>, error: Option<String>) -> bool {
        self.pending
            .lock()
            .unwrap()
            .remove(id)
            .is_some_and(|sender| {
                sender
                    .send(match error {
                        Some(error) => Err(error),
                        None => Ok(result.unwrap_or(Value::Null)),
                    })
                    .is_ok()
            })
    }
    pub fn request(&self, operation: &str, args: &Value, emit: &Emitter) -> Reply {
        if !self.ready() {
            return Err(
                "The editor is still opening. Wait until the MCP connection is ready in Settings."
                    .into(),
            );
        }
        let id = format!("agent-{}", self.sequence.fetch_add(1, Ordering::SeqCst));
        let (sender, receiver) = mpsc::channel();
        {
            let mut pending = self.pending.lock().unwrap();
            if pending.len() >= 16 {
                return Err("Too many editor requests are in progress.".into());
            }
            pending.insert(id.clone(), sender);
        }
        let mut event = args.as_object().cloned().unwrap_or_default();
        event.insert("id".into(), json!(id));
        event.insert("operation".into(), json!(operation));
        event.insert("expiresAt".into(), json!(storage::now() + 10_000));
        if let Err(error) = emit(Value::Object(event)) {
            self.pending.lock().unwrap().remove(&id);
            return Err(error);
        }
        let response=receiver.recv_timeout(Duration::from_secs(10)).map_err(|_|"The editor did not answer within 10 seconds. No late edits should be applied; retry after checking the app.".to_string());
        self.pending.lock().unwrap().remove(&id);
        response?
    }
}
#[derive(Clone)]
pub struct Backend {
    pub database: Result<Database, String>,
    pub bridge: AgentBridge,
    pub emit: Emitter,
}
impl Backend {
    fn database(&self) -> Result<&Database, String> {
        self.database.as_ref().map_err(Clone::clone)
    }
    pub fn edits_enabled(&self) -> Result<bool, String> {
        Ok(self
            .database()?
            .json_value("settings")?
            .and_then(|settings| settings.get("agentEditsEnabled").and_then(Value::as_bool))
            .unwrap_or(true))
    }
    pub fn call(&self, name: &str, args: &Value) -> Reply {
        if !self.bridge.ready() {
            return Err("The editor is still opening or its agent bridge is unavailable.".into());
        }
        match name {
            "workspace_info" => Ok(
                json!({"workspace":self.database()?.workspace()?,"editsEnabled":self.edits_enabled()?}),
            ),
            "list_directory" => to_value(explorer::list_directory(
                self.database()?,
                args.get("path").and_then(Value::as_str),
            )?),
            "search_documents" => to_value(
                self.database()?.search_workspace(
                    string(args, "query")?,
                    args.get("limit")
                        .and_then(Value::as_u64)
                        .map(|value| value as usize),
                )?,
            ),
            "read_file" => to_value(explorer::read_workspace_file(
                self.database()?,
                string(args, "path")?,
            )?),
            "git_status" => to_value(git::status(self.database()?)),
            "git_history" => to_value(git::history(
                self.database()?,
                args.get("limit")
                    .and_then(Value::as_u64)
                    .map(|value| value as usize),
            )?),
            "git_diff" => to_value(git::diff(
                self.database()?,
                string(args, "path")?,
                args.get("staged").and_then(Value::as_bool).unwrap_or(false),
            )?),
            "list_tabs" => self.bridge.request(name, &json!({}), &self.emit),
            "read_tab" => {
                string(args, "tabId")?;
                self.bridge.request(name, args, &self.emit)
            }
            "open_document" => {
                let document =
                    explorer::read_workspace_file(self.database()?, string(args, "path")?)?;
                self.bridge
                    .request(name, &json!({"path":document.path}), &self.emit)
            }
            "edit_document" => {
                if !self.edits_enabled()? {
                    return Err(
                        "Agent edits are disabled in Settings. Reading is still available.".into(),
                    );
                }
                string(args, "tabId")?;
                for field in ["expectedContent", "content"] {
                    if string(args, field)?.len() > TEXT_LIMIT {
                        return Err("Agent edit text exceeds the 4 MiB limit.".into());
                    }
                }
                self.bridge.request(name, args, &self.emit)
            }
            _ => Err(format!("Unknown tool: {name}")),
        }
    }
}
fn string<'a>(args: &'a Value, key: &str) -> Result<&'a str, String> {
    args.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{key} must be a string."))
}
fn to_value(value: impl Serialize) -> Reply {
    serde_json::to_value(value).map_err(|error| error.to_string())
}
fn tool(
    name: &str,
    description: &str,
    properties: Value,
    required: &[&str],
    read_only: bool,
) -> Value {
    json!({"name":name,"description":description,"inputSchema":{"type":"object","properties":properties,"required":required,"additionalProperties":false},"annotations":{"readOnlyHint":read_only,"destructiveHint":false,"idempotentHint":read_only,"openWorldHint":false}})
}
pub fn tools() -> Vec<Value> {
    let text = json!({"type":"string"});
    let path = json!({"type":"string","description":"Absolute path or path relative to the selected workspace."});
    vec![
        tool("workspace_info","Read the selected workspace and whether guarded agent edits are enabled.",json!({}),&[],true),
        tool("list_directory","List immediate workspace children. Symlinks and hidden/build directories are excluded.",json!({"path":path}),&[],true),
        tool("search_documents","Search the rebuildable workspace index. An empty query lists notes; refresh the index in the app after external edits.",json!({"query":text,"limit":{"type":"integer","minimum":1,"maximum":500}}),&["query"],true),
        tool("read_file","Read bounded UTF-8 text from disk inside the workspace. Use read_tab for an unsaved open buffer.",json!({"path":path}),&["path"],true),
        tool("list_tabs","Read metadata for all currently open tabs. Use read_tab to obtain exact text and selection.",json!({}),&[],true),
        tool("read_tab","Read one live tab, including exact unsaved content and selection for guarded edits.",json!({"tabId":text}),&["tabId"],true),
        tool("open_document","Open or focus a workspace document in the editor without replacing dirty tabs or saving files.",json!({"path":path}),&["path"],true),
        tool("edit_document","Apply an undoable live-buffer edit only if expectedContent exactly matches the current tab. Never saves files, never steals focus from another tab. Disabled by the user's agent-edit setting.",json!({"tabId":text,"expectedContent":{"type":"string","maxLength":TEXT_LIMIT},"content":{"type":"string","maxLength":TEXT_LIMIT}}),&["tabId","expectedContent","content"],false),
        tool("git_status","Read local Git status and branches without mutating the repository.",json!({}),&[],true),
        tool("git_history","Read recent local commits and their parent hashes for graph visualization. No network operations.",json!({"limit":{"type":"integer","minimum":1,"maximum":200}}),&[],true),
        tool("git_diff","Read a bounded local file diff, optionally from the index. Never runs external diff programs.",json!({"path":path,"staged":{"type":"boolean"}}),&["path"],true),
    ]
}
fn rpc_error(id: Value, code: i64, message: &str, data: Option<Value>) -> Value {
    let mut error = json!({"code":code,"message":message});
    if let Some(data) = data {
        error["data"] = data;
    }
    json!({"jsonrpc":"2.0","id":id,"error":error})
}
fn result(id: Value, mut body: Value, modern: bool) -> Value {
    if modern {
        body["resultType"] = json!("complete");
        body["_meta"] = json!({"io.modelcontextprotocol/serverInfo":{"name":"Notation","version":env!("CARGO_PKG_VERSION")}});
    }
    json!({"jsonrpc":"2.0","id":id,"result":body})
}
#[derive(Default)]
pub struct Protocol {
    legacy_initialized: bool,
}
impl Protocol {
    pub fn handle(
        &mut self,
        message: Value,
        call: impl FnOnce(&str, &Value) -> Reply,
    ) -> Option<Value> {
        let id = message.get("id").cloned();
        let method = message.get("method").and_then(Value::as_str);
        if message.get("jsonrpc").and_then(Value::as_str) != Some("2.0")
            || method.is_none()
            || id
                .as_ref()
                .is_some_and(|id| !id.is_string() && !id.is_i64() && !id.is_u64())
        {
            return Some(rpc_error(
                id.unwrap_or(Value::Null),
                -32600,
                "Invalid JSON-RPC request",
                None,
            ));
        }
        let method = method.unwrap();
        let id = id?;
        let params = message.get("params").cloned().unwrap_or_else(|| json!({}));
        if !params.is_object() {
            return Some(rpc_error(
                id,
                -32602,
                "Request params must be an object",
                None,
            ));
        }
        if method == "initialize" {
            if !params.get("protocolVersion").is_some_and(Value::is_string)
                || !params.get("capabilities").is_some_and(Value::is_object)
                || !params.get("clientInfo").is_some_and(|info| {
                    info.get("name").is_some_and(Value::is_string)
                        && info.get("version").is_some_and(Value::is_string)
                })
            {
                return Some(rpc_error(id,-32602,"Initialize requires protocolVersion, capabilities, and clientInfo name/version",None));
            }
            self.legacy_initialized = true;
            return Some(result(
                id,
                json!({"protocolVersion":LEGACY,"capabilities":{"tools":{}},"serverInfo":{"name":"Notation","version":env!("CARGO_PKG_VERSION")},"instructions":"Tools connect to the running Notation app. Use read_tab before edit_document; edits require exact expectedContent and remain unsaved/undoable."}),
                false,
            ));
        }
        let meta = params.get("_meta");
        let version = meta
            .and_then(|meta| meta.get("io.modelcontextprotocol/protocolVersion"))
            .and_then(Value::as_str);
        let modern = version.is_some() || method == "server/discover";
        if modern {
            if let Some(version) = version {
                if version != MODERN {
                    return Some(rpc_error(
                        id,
                        -32022,
                        "Unsupported protocol version",
                        Some(json!({"supported":[MODERN,LEGACY],"requested":version})),
                    ));
                }
            }
            if version.is_none()
                || !meta
                    .and_then(|meta| meta.get("io.modelcontextprotocol/clientCapabilities"))
                    .is_some_and(Value::is_object)
            {
                return Some(rpc_error(id,-32602,"Modern requests require protocolVersion and clientCapabilities in params._meta",None));
            }
        } else if !self.legacy_initialized {
            return Some(rpc_error(
                id,
                -32600,
                "Initialize the legacy MCP connection first, or supply modern per-request metadata",
                None,
            ));
        }
        let body = match method {
            "server/discover" => {
                json!({"supportedVersions":[MODERN,LEGACY],"capabilities":{"tools":{}},"instructions":"Live Notation editor tools. Guard edits with exact read_tab content; the user controls agent edit permissions."})
            }
            "ping" => json!({}),
            "tools/list" => json!({"tools":tools()}),
            "tools/call" => {
                let Some(name) = params.get("name").and_then(Value::as_str) else {
                    return Some(rpc_error(id, -32602, "Tool name must be a string", None));
                };
                let args = params
                    .get("arguments")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                let Some(tool) = tools().into_iter().find(|tool| tool["name"] == name) else {
                    return Some(rpc_error(id, -32602, "Unknown tool", None));
                };
                if let Err(error) = validate_arguments(&tool["inputSchema"], &args) {
                    return Some(rpc_error(id, -32602, &error, None));
                }
                match call(name, &args) {
                    Ok(value) => {
                        json!({"content":[{"type":"text","text":value.to_string()}],"structuredContent":if value.is_object(){value}else{json!({"data":value})},"isError":false})
                    }
                    Err(error) => json!({"content":[{"type":"text","text":error}],"isError":true}),
                }
            }
            _ => return Some(rpc_error(id, -32601, "Method not found", None)),
        };
        Some(result(id, body, modern))
    }
}
fn validate_arguments(schema: &Value, args: &Value) -> Result<(), String> {
    let object = args
        .as_object()
        .ok_or("Tool arguments must be an object.")?;
    for required in schema["required"].as_array().unwrap() {
        let field = required.as_str().unwrap();
        if !object.contains_key(field) {
            return Err(format!("Missing required argument: {field}"));
        }
    }
    for (key, value) in object {
        let property = &schema["properties"][key];
        let valid = match property["type"].as_str() {
            Some("string") => value.is_string(),
            Some("boolean") => value.is_boolean(),
            Some("integer") => value.as_u64().is_some(),
            _ => false,
        };
        if !valid {
            return Err(format!("Invalid or unexpected argument: {key}"));
        }
        if let Some(number) = value.as_u64() {
            if property["minimum"].as_u64().is_some_and(|min| number < min)
                || property["maximum"].as_u64().is_some_and(|max| number > max)
            {
                return Err(format!("Argument {key} is out of range."));
            }
        }
        if value.as_str().is_some_and(|text| text.len() > TEXT_LIMIT) {
            return Err(format!("Argument {key} exceeds the 4 MiB text limit."));
        }
    }
    Ok(())
}
#[cfg(unix)]
pub fn serve(path: &Path, backend: Backend) -> Result<(), String> {
    use std::os::unix::{
        fs::{FileTypeExt, MetadataExt, PermissionsExt},
        net::{UnixListener, UnixStream},
    };
    let parent = path.parent().ok_or("Socket needs a parent directory.")?;
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))
        .map_err(|error| error.to_string())?;
    if let Ok(metadata) = std::fs::symlink_metadata(path) {
        if !metadata.file_type().is_socket() || metadata.uid() != unsafe { libc::geteuid() } {
            return Err("Agent socket path is occupied by an unexpected file. It was kept.".into());
        }
        if UnixStream::connect(path).is_ok() {
            return Err("Another Notation instance already owns the agent socket.".into());
        }
        std::fs::remove_file(path).map_err(|error| error.to_string())?;
    }
    let listener = UnixListener::bind(path)
        .map_err(|error| format!("Could not create agent socket: {error}"))?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .map_err(|error| error.to_string())?;
    let active = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    std::thread::spawn(move || {
        for mut stream in listener.incoming().flatten() {
            if active
                .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |count| {
                    (count < 16).then_some(count + 1)
                })
                .is_err()
            {
                let _ = stream.set_write_timeout(Some(Duration::from_millis(100)));
                let _ = writeln!(
                    stream,
                    "{}",
                    json!({"ok":false,"error":"The local agent bridge is busy. Retry shortly."})
                );
                continue;
            }
            let permit = ConnectionPermit(active.clone());
            let backend = backend.clone();
            std::thread::spawn(move || {
                let _permit = permit;
                let _ = stream.set_read_timeout(Some(Duration::from_secs(15)));
                let _ = stream.set_write_timeout(Some(Duration::from_secs(15)));
                let mut reader = BufReader::new(&stream);
                let mut line = String::new();
                let response = match reader
                    .by_ref()
                    .take((FRAME_LIMIT + 1) as u64)
                    .read_line(&mut line)
                {
                    Ok(_) if line.len() <= FRAME_LIMIT => serde_json::from_str::<Value>(&line)
                        .map_err(|error| error.to_string())
                        .and_then(|request| {
                            let name = request
                                .get("name")
                                .and_then(Value::as_str)
                                .ok_or("Missing tool name.")?;
                            backend.call(name, request.get("arguments").unwrap_or(&json!({})))
                        }),
                    _ => Err("Agent request exceeded its size/time limit.".into()),
                };
                let output = match response {
                    Ok(value) => json!({"ok":true,"value":value}),
                    Err(error) => json!({"ok":false,"error":error}),
                };
                let mut stream = stream;
                let _ = writeln!(stream, "{output}");
            });
        }
    });
    Ok(())
}
#[cfg(not(unix))]
pub fn serve(_path: &Path, _backend: Backend) -> Result<(), String> {
    Err("The local agent bridge currently requires Unix domain sockets.".into())
}
pub fn default_socket() -> Result<PathBuf, String> {
    if let Some(directory) = std::env::var_os("XDG_DATA_HOME").filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(directory).join("local.notation.app/agent.sock"));
    }
    let home = std::env::var_os("HOME")
        .ok_or("HOME is unavailable; pass --socket with the live app's socket path.")?;
    Ok(PathBuf::from(home).join(".local/share/local.notation.app/agent.sock"))
}
pub fn launch_command() -> String {
    let appimage = std::env::var_os("APPIMAGE").map(PathBuf::from);
    let appdir = std::env::var_os("APPDIR").map(PathBuf::from);
    let executable = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("notation"));
    launch_command_for(appimage.as_deref(), appdir.as_deref(), &executable)
        .to_string_lossy()
        .into_owned()
}
/// Extracted AppDirs also need AppRun's bundled-library environment. Prefer
/// their launcher instead of exposing the inner binary as a runnable command.
pub fn launch_command_for(
    appimage: Option<&Path>,
    appdir: Option<&Path>,
    executable: &Path,
) -> PathBuf {
    if let Some(image) = appimage.filter(|path| path.is_absolute()) {
        return image.to_path_buf();
    }
    if let Some(launcher) = appdir
        .map(|path| path.join("AppRun"))
        .filter(|path| path.is_file())
    {
        return launcher;
    }
    if let Some(bin) = executable
        .parent()
        .filter(|path| path.file_name().is_some_and(|name| name == "bin"))
    {
        if let Some(usr) = bin
            .parent()
            .filter(|path| path.file_name().is_some_and(|name| name == "usr"))
        {
            if let Some(launcher) = usr
                .parent()
                .map(|path| path.join("AppRun"))
                .filter(|path| path.is_file())
            {
                return launcher;
            }
        }
    }
    executable.to_path_buf()
}
#[cfg(unix)]
pub fn forward(path: &Path, name: &str, args: &Value) -> Reply {
    use std::os::unix::net::UnixStream;
    let mut stream = UnixStream::connect(path).map_err(|error| {
        format!(
            "Could not connect to the running Notation app at {}: {error}. Open Notation first.",
            path.display()
        )
    })?;
    stream
        .set_read_timeout(Some(Duration::from_secs(15)))
        .map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(15)))
        .map_err(|error| error.to_string())?;
    writeln!(stream, "{}", json!({"name":name,"arguments":args}))
        .map_err(|error| error.to_string())?;
    let mut response = String::new();
    BufReader::new(stream)
        .take((FRAME_LIMIT + 1) as u64)
        .read_line(&mut response)
        .map_err(|error| error.to_string())?;
    if response.len() > FRAME_LIMIT {
        return Err("Agent response exceeds the 32 MiB limit.".into());
    }
    let response: Value = serde_json::from_str(&response).map_err(|error| error.to_string())?;
    if response["ok"] == true {
        Ok(response["value"].clone())
    } else {
        Err(response["error"]
            .as_str()
            .unwrap_or("Agent request failed.")
            .into())
    }
}
#[cfg(not(unix))]
pub fn forward(_path: &Path, _name: &str, _args: &Value) -> Reply {
    Err("The local agent bridge currently requires Unix domain sockets.".into())
}
pub fn stdio_main() {
    let arguments = std::env::args().collect::<Vec<_>>();
    let path = arguments
        .iter()
        .position(|argument| argument == "--socket")
        .and_then(|index| arguments.get(index + 1))
        .map(PathBuf::from)
        .map(Ok)
        .unwrap_or_else(default_socket);
    let mut protocol = Protocol::default();
    let stdin = std::io::stdin();
    let mut input = stdin.lock();
    let mut output = std::io::stdout().lock();
    loop {
        let mut line = String::new();
        match input
            .by_ref()
            .take((FRAME_LIMIT + 1) as u64)
            .read_line(&mut line)
        {
            Ok(0) => break,
            Ok(_) if line.len() <= FRAME_LIMIT => {}
            _ => {
                let _ = writeln!(
                    output,
                    "{}",
                    rpc_error(
                        Value::Null,
                        -32700,
                        "MCP input exceeded its size limit",
                        None
                    )
                );
                let _ = output.flush();
                break;
            }
        }
        let response = match serde_json::from_str(&line) {
            Ok(message) => protocol.handle(message, |name, args| {
                path.as_ref()
                    .map_err(Clone::clone)
                    .and_then(|path| forward(path, name, args))
            }),
            Err(_) => Some(rpc_error(Value::Null, -32700, "Invalid JSON", None)),
        };
        if let Some(response) = response {
            if writeln!(output, "{response}")
                .and_then(|_| output.flush())
                .is_err()
            {
                break;
            }
        }
    }
}
