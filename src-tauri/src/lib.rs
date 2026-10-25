pub mod assets;
pub mod automation;
pub mod documents;
pub mod engine_process;
pub mod engines;
pub mod explorer;
pub mod file_changes;
pub mod frontmatter;
pub mod git;
#[cfg(target_os = "linux")]
pub mod instance;
pub mod language_server;
pub mod launch;
pub mod mcp;
pub mod search_graph;
pub mod storage;
pub mod sticky;
pub mod wiki;
pub mod workspace;
pub mod workspace_catalog;

#[cfg(feature = "desktop")]
mod desktop {
    #[cfg(target_os = "linux")]
    use super::instance;
    use super::{
        assets, automation, documents, engines, explorer, frontmatter, git, language_server, launch,
        mcp, search_graph, storage, sticky, wiki, workspace,
    };
    use serde_json::Value;
    use tauri::{Emitter, Manager, State};

    #[derive(Clone)]
    struct AgentState {
        backend: mcp::Backend,
        endpoint: Result<std::path::PathBuf, String>,
    }

    struct DatabaseState(Result<storage::Database, String>);
    impl DatabaseState {
        fn get(&self) -> Result<storage::Database, String> {
            self.0.clone()
        }
    }
    async fn database_work<T: Send + 'static>(
        database: storage::Database,
        operation: impl FnOnce(storage::Database) -> Result<T, String> + Send + 'static,
    ) -> Result<T, String> {
        tauri::async_runtime::spawn_blocking(move || operation(database))
            .await
            .map_err(|error| format!("Local database task failed: {error}"))?
    }

    #[tauri::command]
    async fn run_script(
        request: automation::ScriptRequest,
        manager: State<'_, automation::ScriptManager>,
        database: State<'_, DatabaseState>,
    ) -> Result<automation::ScriptResponse, String> {
        let manager = manager.inner().clone();
        let database = database.get();
        tauri::async_runtime::spawn_blocking(move || {
            let executable = std::env::current_exe().map_err(|error| error.to_string())?;
            let started = storage::now();
            let history_request = request.clone();
            let mut response = manager.run(&executable, request)?;
            storage::record_run_optional(&database, &history_request, &mut response, started);
            Ok(response)
        })
        .await
        .map_err(|error| format!("Automation worker failed: {error}"))?
    }
    #[tauri::command]
    fn stop_script(id: String, manager: State<'_, automation::ScriptManager>) -> bool {
        manager.stop(&id)
    }
    #[tauri::command]
    async fn read_document(
        path: String,
        database: State<'_, DatabaseState>,
    ) -> Result<documents::Document, String> {
        let database = database.get();
        tauri::async_runtime::spawn_blocking(move || launch::read_with_metadata(&path, &database))
            .await
            .map_err(|error| format!("Could not open file: {error}"))?
    }
    #[tauri::command]
    async fn read_launch_document(
        path: String,
        database: State<'_, DatabaseState>,
    ) -> Result<documents::Document, String> {
        let database = database.get();
        tauri::async_runtime::spawn_blocking(move || launch::read_with_metadata(&path, &database))
            .await
            .map_err(|error| format!("Could not open launched file: {error}"))?
    }
    #[tauri::command]
    async fn resolve_document_path(path: String) -> Result<Value, String> {
        tauri::async_runtime::spawn_blocking(move || {
            documents::resolve_document_path(&path).map(|path| serde_json::json!({"path":path}))
        })
        .await
        .map_err(|error| error.to_string())?
    }
    #[tauri::command]
    async fn read_document_snapshot(path: String) -> Result<documents::Document, String> {
        tauri::async_runtime::spawn_blocking(move || launch::read_document(&path))
            .await
            .map_err(|error| error.to_string())?
    }
    #[tauri::command]
    async fn write_document_checked(
        path: String,
        content: String,
        expected_content: String,
        database: State<'_, DatabaseState>,
    ) -> Result<documents::Document, String> {
        let database = database.get();
        tauri::async_runtime::spawn_blocking(move || {
            super::file_changes::write_checked(&path, &content, &expected_content, &database)
        })
        .await
        .map_err(|error| error.to_string())?
    }
    #[tauri::command]
    fn lsp_typescript_path(
        service: State<'_, language_server::Service>,
    ) -> Result<String, String> {
        service.typescript_path()
    }
    #[tauri::command]
    async fn write_document(
        path: String,
        content: String,
        database: State<'_, DatabaseState>,
    ) -> Result<documents::Document, String> {
        let database = database.get();
        tauri::async_runtime::spawn_blocking(move || {
            storage::write_with_metadata(&path, &content, &database)
        })
        .await
        .map_err(|error| format!("Could not save file: {error}"))?
    }
    #[tauri::command]
    async fn bootstrap_state(
        legacy: Option<storage::LegacyState>,
        database: State<'_, DatabaseState>,
    ) -> Result<storage::BootstrapState, String> {
        database_work(database.get()?, move |database| database.bootstrap(legacy)).await
    }
    #[tauri::command]
    async fn metadata_summary(
        database: State<'_, DatabaseState>,
    ) -> Result<storage::MetadataSummary, String> {
        database_work(database.get()?, move |database| database.metadata_summary()).await
    }
    #[tauri::command]
    async fn persist_state(
        state: storage::StateUpdate,
        database: State<'_, DatabaseState>,
    ) -> Result<(), String> {
        database_work(database.get()?, move |database| database.persist(state)).await
    }
    #[tauri::command]
    async fn save_script(
        script: storage::ScriptInput,
        database: State<'_, DatabaseState>,
    ) -> Result<storage::SavedScript, String> {
        database_work(database.get()?, move |database| {
            database.save_script(script)
        })
        .await
    }
    #[tauri::command]
    async fn delete_script(id: String, database: State<'_, DatabaseState>) -> Result<bool, String> {
        database_work(database.get()?, move |database| database.delete_script(&id)).await
    }
    #[tauri::command]
    async fn list_scripts(
        database: State<'_, DatabaseState>,
    ) -> Result<Vec<storage::SavedScript>, String> {
        database_work(database.get()?, move |database| database.list_scripts()).await
    }
    #[tauri::command]
    async fn list_script_runs(
        script_id: Option<String>,
        database: State<'_, DatabaseState>,
    ) -> Result<Vec<storage::ScriptRun>, String> {
        database_work(database.get()?, move |database| {
            database.list_script_runs(script_id.as_deref())
        })
        .await
    }
    #[tauri::command]
    async fn list_revisions(
        document_key: String,
        database: State<'_, DatabaseState>,
    ) -> Result<Vec<storage::Revision>, String> {
        database_work(database.get()?, move |database| {
            database.list_revisions(&document_key)
        })
        .await
    }
    #[tauri::command]
    async fn get_revision(
        id: i64,
        database: State<'_, DatabaseState>,
    ) -> Result<storage::Revision, String> {
        database_work(database.get()?, move |database| database.get_revision(id)).await
    }
    #[tauri::command]
    async fn list_workspaces(
        database: State<'_, DatabaseState>,
    ) -> Result<crate::workspace_catalog::WorkspaceCatalog, String> {
        database_work(database.get()?, move |database| database.list_workspaces()).await
    }
    #[tauri::command]
    async fn create_workspace(
        name: String,
        database: State<'_, DatabaseState>,
    ) -> Result<crate::workspace_catalog::WorkspaceCatalog, String> {
        database_work(database.get()?, move |database| {
            database.create_workspace(&name)
        })
        .await
    }
    #[tauri::command]
    async fn select_workspace(
        id: String,
        database: State<'_, DatabaseState>,
    ) -> Result<crate::workspace_catalog::WorkspaceCatalog, String> {
        database_work(database.get()?, move |database| {
            database.select_workspace(&id)
        })
        .await
    }
    #[tauri::command]
    async fn rename_workspace(
        id: String,
        name: String,
        database: State<'_, DatabaseState>,
    ) -> Result<crate::workspace_catalog::WorkspaceCatalog, String> {
        database_work(database.get()?, move |database| {
            database.rename_workspace(&id, &name)
        })
        .await
    }
    #[tauri::command]
    async fn delete_workspace(
        id: String,
        database: State<'_, DatabaseState>,
    ) -> Result<crate::workspace_catalog::WorkspaceCatalog, String> {
        database_work(database.get()?, move |database| {
            database.delete_workspace(&id)
        })
        .await
    }
    #[tauri::command]
    async fn add_workspace_files(
        id: String,
        paths: Vec<String>,
        database: State<'_, DatabaseState>,
    ) -> Result<crate::workspace_catalog::WorkspaceCatalog, String> {
        database_work(database.get()?, move |database| {
            database.add_workspace_files(&id, &paths)
        })
        .await
    }
    #[tauri::command]
    async fn remove_workspace_file(
        id: String,
        path: String,
        database: State<'_, DatabaseState>,
    ) -> Result<crate::workspace_catalog::WorkspaceCatalog, String> {
        database_work(database.get()?, move |database| {
            database.remove_workspace_file(&id, &path)
        })
        .await
    }
    #[tauri::command]
    async fn set_workspace(
        path: String,
        database: State<'_, DatabaseState>,
    ) -> Result<Value, String> {
        database_work(database.get()?, move |database| {
            database.set_workspace(&path)
        })
        .await
    }
    #[tauri::command]
    async fn index_workspace(
        database: State<'_, DatabaseState>,
    ) -> Result<workspace::IndexReport, String> {
        database_work(database.get()?, move |database| database.index_workspace()).await
    }
    #[tauri::command]
    async fn search_workspace(
        query: String,
        limit: Option<usize>,
        database: State<'_, DatabaseState>,
    ) -> Result<Vec<workspace::SearchResult>, String> {
        database_work(database.get()?, move |database| {
            database.search_workspace(&query, limit)
        })
        .await
    }
    #[tauri::command]
    async fn search_workspace_advanced(
        request: search_graph::SearchRequest,
        database: State<'_, DatabaseState>,
    ) -> Result<search_graph::SearchPage, String> {
        database_work(database.get()?, move |database| {
            database.search_workspace_advanced(request)
        })
        .await
    }
    #[tauri::command]
    async fn graph_workspace(
        request: Option<search_graph::GraphRequest>,
        database: State<'_, DatabaseState>,
    ) -> Result<search_graph::GraphSnapshot, String> {
        database_work(database.get()?, move |database| {
            database.graph_workspace(request.unwrap_or_default())
        })
        .await
    }
    #[tauri::command]
    async fn read_workspace_note(
        path: String,
        database: State<'_, DatabaseState>,
    ) -> Result<documents::Document, String> {
        database_work(database.get()?, move |database| {
            explorer::read_workspace_file(&database, &path)
        })
        .await
    }
    #[tauri::command]
    async fn read_workspace_asset(
        path: String,
        source_path: Option<String>,
        database: State<'_, DatabaseState>,
    ) -> Result<assets::Asset, String> {
        database_work(database.get()?, move |database| {
            assets::read(&database, &path, source_path.as_deref())
        })
        .await
    }
    #[tauri::command]
    async fn lsp_start(
        path: String,
        language: String,
        service: State<'_, language_server::Service>,
    ) -> Result<language_server::StartInfo, String> {
        let service = service.inner().clone();
        tauri::async_runtime::spawn_blocking(move || service.start(path, language))
            .await
            .map_err(|error| format!("Language server start task failed: {error}"))?
    }

    #[tauri::command]
    async fn lsp_send(
        id: String,
        message: String,
        service: State<'_, language_server::Service>,
    ) -> Result<(), String> {
        let service = service.inner().clone();
        tauri::async_runtime::spawn_blocking(move || service.send(id, message))
            .await
            .map_err(|error| format!("Language server send task failed: {error}"))?
    }

    #[tauri::command]
    async fn lsp_stop(
        id: String,
        service: State<'_, language_server::Service>,
    ) -> Result<(), String> {
        let service = service.inner().clone();
        tauri::async_runtime::spawn_blocking(move || service.stop(id))
            .await
            .map_err(|error| format!("Language server stop task failed: {error}"))?
    }

    #[tauri::command]
    fn lsp_status(
        service: State<'_, language_server::Service>,
    ) -> Vec<language_server::ServerStatus> {
        service.status()
    }

    #[tauri::command]
    async fn engine_status(
        runtime: State<'_, engines::Runtime>,
    ) -> Result<engines::Status, String> {
        let runtime = runtime.inner().clone();
        tauri::async_runtime::spawn_blocking(move || runtime.status())
            .await
            .map_err(|error| error.to_string())
    }
    #[tauri::command]
    async fn render_diagram(
        engine: String,
        source: String,
        runtime: State<'_, engines::Runtime>,
    ) -> Result<String, String> {
        let runtime = runtime.inner().clone();
        tauri::async_runtime::spawn_blocking(move || runtime.render_diagram(&engine, &source))
            .await
            .map_err(|error| error.to_string())?
    }
    #[tauri::command]
    async fn export_document(
        request: engines::ExportRequest,
        runtime: State<'_, engines::Runtime>,
        database: State<'_, DatabaseState>,
    ) -> Result<engines::ExportResult, String> {
        let runtime = runtime.inner().clone();
        let database = database.get().ok();
        tauri::async_runtime::spawn_blocking(move || runtime.export(request, database.as_ref()))
            .await
            .map_err(|error| error.to_string())?
    }
    #[tauri::command]
    fn cancel_export(id: String, runtime: State<'_, engines::Runtime>) -> bool {
        runtime.cancel(&id)
    }
    #[tauri::command]
    async fn render_citations(
        content: String,
        source_path: Option<String>,
        citations: Option<Vec<String>>,
        runtime: State<'_, engines::Runtime>,
        database: State<'_, DatabaseState>,
    ) -> Result<engines::Citations, String> {
        let runtime = runtime.inner().clone();
        let database = database.get().ok();
        tauri::async_runtime::spawn_blocking(move || {
            runtime.citations(
                &content,
                source_path.as_deref(),
                citations.unwrap_or_default(),
                database.as_ref(),
            )
        })
        .await
        .map_err(|error| error.to_string())?
    }
    #[tauri::command]
    fn open_external(url: String) -> Result<(), String> {
        let parsed = url::Url::parse(&url).map_err(|_| "External resource URL is invalid.")?;
        if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
            return Err("Only explicit HTTP(S) external links can be opened.".into());
        }
        let mut child = std::process::Command::new("xdg-open")
            .arg(parsed.as_str())
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|error| format!("Could not open external browser: {error}"))?;
        std::thread::spawn(move || {
            let _ = child.wait();
        });
        Ok(())
    }
    #[tauri::command]
    async fn get_tasks(
        checked: Option<bool>,
        database: State<'_, DatabaseState>,
    ) -> Result<Vec<workspace::Task>, String> {
        database_work(database.get()?, move |database| database.get_tasks(checked)).await
    }
    #[tauri::command]
    async fn get_tags(
        database: State<'_, DatabaseState>,
    ) -> Result<Vec<workspace::TagCount>, String> {
        database_work(database.get()?, move |database| database.get_tags()).await
    }
    #[tauri::command]
    async fn get_backlinks(
        path: String,
        database: State<'_, DatabaseState>,
    ) -> Result<Vec<workspace::Backlink>, String> {
        database_work(database.get()?, move |database| {
            database.get_backlinks(&path)
        })
        .await
    }
    #[tauri::command]
    async fn list_directory(
        path: Option<String>,
        database: State<'_, DatabaseState>,
    ) -> Result<explorer::Directory, String> {
        database_work(database.get()?, move |database| {
            explorer::list_directory(&database, path.as_deref())
        })
        .await
    }
    #[tauri::command]
    async fn git_repository(document_path: String) -> Result<Option<String>, String> {
        tauri::async_runtime::spawn_blocking(move || git::document_repository_root(&document_path))
            .await
            .map_err(|error| error.to_string())
    }
    #[tauri::command]
    async fn git_status(
        document_path: Option<String>,
        database: State<'_, DatabaseState>,
    ) -> Result<git::Status, String> {
        database_work(database.get()?, move |database| {
            Ok(git::status_for_document(
                &database,
                document_path.as_deref(),
            ))
        })
        .await
    }
    #[tauri::command]
    async fn git_history(
        limit: Option<usize>,
        document_path: Option<String>,
        database: State<'_, DatabaseState>,
    ) -> Result<Vec<git::Commit>, String> {
        database_work(database.get()?, move |database| {
            git::history_for_document(&database, limit, document_path.as_deref())
        })
        .await
    }
    #[tauri::command]
    async fn git_diff(
        path: String,
        staged: Option<bool>,
        document_path: Option<String>,
        database: State<'_, DatabaseState>,
    ) -> Result<git::Diff, String> {
        database_work(database.get()?, move |database| {
            git::diff_for_document(
                &database,
                &path,
                staged.unwrap_or(false),
                document_path.as_deref(),
            )
        })
        .await
    }
    #[tauri::command]
    async fn parse_frontmatter(content: String) -> Result<frontmatter::Frontmatter, String> {
        if content.len() > storage::MAX_CONTENT {
            return Err("Document exceeds the 4 MiB limit.".into());
        }
        tauri::async_runtime::spawn_blocking(move || frontmatter::parse(&content))
            .await
            .map_err(|error| error.to_string())
    }
    #[tauri::command]
    async fn get_frontmatter(
        path: Option<String>,
        database: State<'_, DatabaseState>,
    ) -> Result<Vec<wiki::PropertyDocument>, String> {
        database_work(database.get()?, move |database| {
            database.get_frontmatter(path.as_deref())
        })
        .await
    }
    #[tauri::command]
    async fn query_properties(
        query: wiki::PropertyQuery,
        database: State<'_, DatabaseState>,
    ) -> Result<Vec<wiki::PropertyDocument>, String> {
        database_work(database.get()?, move |database| {
            database.query_properties(query)
        })
        .await
    }
    #[tauri::command]
    async fn resolve_wiki_link(
        target: String,
        source_path: Option<String>,
        database: State<'_, DatabaseState>,
    ) -> Result<wiki::Resolution, String> {
        database_work(database.get()?, move |database| {
            database.resolve_wiki_link(&target, source_path.as_deref())
        })
        .await
    }
    #[tauri::command]
    async fn wiki_candidates(
        query: String,
        source_path: Option<String>,
        limit: Option<usize>,
        database: State<'_, DatabaseState>,
    ) -> Result<Vec<wiki::Candidate>, String> {
        database_work(database.get()?, move |database| {
            database.wiki_candidates(&query, source_path.as_deref(), limit)
        })
        .await
    }
    #[tauri::command]
    async fn create_wiki_note(
        target: String,
        source_path: Option<String>,
        content: Option<String>,
        database: State<'_, DatabaseState>,
    ) -> Result<documents::Document, String> {
        database_work(database.get()?, move |database| {
            database.create_wiki_note(&target, source_path.as_deref(), content.as_deref())
        })
        .await
    }
    #[tauri::command]
    async fn list_sticky_notes(window: tauri::WebviewWindow, database: State<'_, DatabaseState>) -> Result<Vec<sticky::Metadata>, String> {
        sticky::authorize_main(window.label())?;
        database_work(database.get()?, |db| db.list_stickies()).await
    }
    #[tauri::command]
    async fn create_sticky_note(window: tauri::WebviewWindow, database: State<'_, DatabaseState>, manager: State<'_, sticky::StickyManager>) -> Result<sticky::Metadata, String> {
        sticky::authorize_main(window.label())?;
        let admission = manager.lock()?;
        admission.check_open()?;
        database.get()?.create_sticky()
    }
    #[tauri::command]
    async fn delete_sticky_note(window: tauri::WebviewWindow, id: String, database: State<'_, DatabaseState>, manager: State<'_, sticky::StickyManager>) -> Result<(), String> {
        sticky::authorize_main(window.label())?;
        // Serialize deletion with reservation. Never hold this lock across window APIs.
        let admission = manager.lock()?;
        admission.check_delete(&id)?;
        database.get()?.delete_sticky(&id)
    }
    #[tauri::command]
    async fn read_sticky_note(window: tauri::WebviewWindow, id: String, database: State<'_, DatabaseState>) -> Result<sticky::Note, String> {
        sticky::authorize_note(window.label(), &id)?;
        database_work(database.get()?, move |db| db.read_sticky(&id)).await
    }
    #[tauri::command]
    async fn update_sticky_note(window: tauri::WebviewWindow, id: String, title: String, text: String, color: Option<String>, html: Option<String>, database: State<'_, DatabaseState>) -> Result<(), String> {
        sticky::authorize_note(window.label(), &id)?;
        database_work(database.get()?, move |db| db.update_sticky_content(&id, &title, &text, color.as_deref(), html.as_deref())).await
    }
    #[tauri::command]
    async fn close_sticky_note(window: tauri::WebviewWindow, id: String) -> Result<(), String> {
        sticky::authorize_note(window.label(), &id)?;
        window.destroy().map_err(|error| error.to_string())
    }
    #[tauri::command]
    async fn open_sticky_note(window: tauri::WebviewWindow, id: String, app: tauri::AppHandle, database: State<'_, DatabaseState>, manager: State<'_, sticky::StickyManager>) -> Result<(), String> {
        sticky::authorize_main(window.label())?;
        let reserved = {
            let mut admission = manager.lock()?;
            // Existence and reservation are atomic with respect to deletion.
            database.get()?.read_sticky(&id)?;
            admission.reserve(&id)?
        };
        let label = format!("sticky-{id}");
        if !reserved {
            let existing = app.get_webview_window(&label).ok_or("Sticky window is still opening. Try again shortly.")?;
            existing.unminimize().map_err(|e| e.to_string())?;
            return existing.set_focus().map_err(|e| e.to_string());
        }
        // No parent/owner: these windows stay independent when main is minimized.
        let result = tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::App(format!("index.html?sticky={id}").into()))
            .title("Sticky note — Notation").inner_size(340.0, 380.0).min_inner_size(240.0, 200.0)
            .resizable(true).always_on_top(true).build();
        if let Err(error) = result {
            manager.lock()?.release(&id);
            return Err(format!("Could not open sticky window: {error}"));
        }
        Ok(())
    }

    #[tauri::command]
    fn launch_ready(
        ready: bool,
        launches: State<'_, launch::LaunchQueue>,
    ) -> Result<Vec<launch::LaunchRequest>, String> {
        launches.set_ready(ready)
    }
    #[tauri::command]
    fn set_launch_closing(
        window: tauri::WebviewWindow,
        closing: bool,
        launches: State<'_, launch::LaunchQueue>,
        stickies: State<'_, sticky::StickyManager>,
    ) -> Result<(), String> {
        sticky::authorize_main(window.label())?;
        stickies.lock()?.close_with(closing, || launches.set_closing(closing))
    }
    #[tauri::command]
    fn complete_launch_request(
        id: String,
        launches: State<'_, launch::LaunchQueue>,
    ) -> Result<bool, String> {
        launches.complete(&id)
    }
    #[tauri::command]
    fn agent_ready(ready: bool, agent: State<'_, AgentState>) {
        agent.backend.bridge.set_ready(ready);
    }
    #[tauri::command]
    fn complete_agent_request(
        id: String,
        result: Option<Value>,
        error: Option<String>,
        agent: State<'_, AgentState>,
    ) -> bool {
        agent.backend.bridge.complete(&id, result, error)
    }
    #[tauri::command]
    async fn agent_status(agent: State<'_, AgentState>) -> Result<Value, String> {
        let agent = agent.inner().clone();
        tauri::async_runtime::spawn_blocking(move||{
            let enabled=agent.backend.edits_enabled();let error=agent.endpoint.as_ref().err().cloned().or_else(||enabled.as_ref().err().cloned());
            let args=agent.endpoint.as_ref().ok().map(|path|vec!["--mcp".to_string(),"--socket".to_string(),path.to_string_lossy().into_owned()]).unwrap_or_else(||vec!["--mcp".into()]);
            Ok(serde_json::json!({"available":agent.endpoint.is_ok(),"ready":agent.endpoint.is_ok()&&agent.backend.bridge.ready(),"socketPath":agent.endpoint.as_ref().ok().map(|path|path.to_string_lossy()),"dataDir":agent.backend.database.as_ref().ok().and_then(|database|database.path.parent()).map(|path|path.to_string_lossy()),"command":mcp::launch_command(),"args":args,"editsEnabled":enabled.unwrap_or(false),"protocolVersions":["2026-07-28","2025-11-25"],"error":error}))
        }).await.map_err(|error|error.to_string())?
    }

    #[cfg(target_os = "linux")]
    fn activate_main(handle: tauri::AppHandle) -> Result<(), String> {
        let (response, completed) = std::sync::mpsc::sync_channel(1);
        handle
            .clone()
            .run_on_main_thread(move || {
                let result = (|| {
                    let window = handle
                        .get_webview_window("main")
                        .ok_or("The existing Notation window is unavailable.")?;
                    window.show().map_err(|error| error.to_string())?;
                    window.unminimize().map_err(|error| error.to_string())?;
                    // Focus is a request to the compositor. Its refusal does not
                    // turn an acknowledged handoff into a second profile owner.
                    let _ = window.set_focus();
                    Ok(())
                })();
                let _ = response.send(result);
            })
            .map_err(|error| {
                format!("Could not dispatch activation to the main thread: {error}")
            })?;
        completed
            .recv_timeout(std::time::Duration::from_secs(2))
            .map_err(|error| format!("The existing window did not accept activation: {error}"))?
    }

    pub fn run(initial_request: Option<launch::LaunchRequest>) {
        let launches = launch::LaunchQueue::default();
        if let Some(request) = initial_request.clone() {
            if let Err(error) = launches.enqueue(request) {
                eprintln!("Notation could not queue the requested documents: {error}");
                std::process::exit(1);
            }
        }
        let app = tauri::Builder::default()
            .manage(automation::ScriptManager::default())
            .manage(launches.clone())
            .manage(sticky::StickyManager::default())
            .on_window_event(|window, event| {
                if matches!(event, tauri::WindowEvent::Destroyed) {
                    if let Some(id) = window.label().strip_prefix("sticky-") {
                        if let Ok(mut admission) = window.state::<sticky::StickyManager>().lock() {
                            admission.release(id);
                        }
                    }
                }
            })
            .setup(|app| {
                #[cfg(target_os = "linux")]
                let data_directory: Result<std::path::PathBuf, String> = Ok(app
                    .state::<instance::ProfileOwner>()
                    .profile_dir()
                    .to_path_buf());
                #[cfg(not(target_os = "linux"))]
                let data_directory = app
                    .path()
                    .app_data_dir()
                    .map_err(|error| format!("Could not locate local data directory: {error}"));
                app.manage(engines::Runtime::discover(app.path().resource_dir().ok()));
                app.manage(language_server::Service::discover(
                    data_directory.clone().ok(),
                    app.handle().clone(),
                ));
                let database = data_directory
                    .clone()
                    .and_then(|path| storage::Database::open(&path.join("state.sqlite3")));
                // Keep the editor bootable and surface the original initialization
                // error through state commands; never replace/delete a failed DB.
                let handle = app.handle().clone();
                let backend = mcp::Backend {
                    database: database.clone(),
                    bridge: mcp::AgentBridge::default(),
                    emit: std::sync::Arc::new(move |request| {
                        handle
                            .emit_to("main", "notation:agent-request", request)
                            .map_err(|error| error.to_string())
                    }),
                };
                let endpoint = data_directory.and_then(|path| {
                    let path = path.join("agent.sock");
                    mcp::serve(&path, backend.clone()).map(|_| path)
                });
                app.manage(AgentState { backend, endpoint });
                app.manage(DatabaseState(database));
                Ok(())
            })
            .plugin(tauri_plugin_dialog::init())
            .invoke_handler({
                let commands: fn(tauri::ipc::Invoke) -> bool = tauri::generate_handler![
                read_document,
                read_launch_document,
                resolve_document_path,
                write_document,
                write_document_checked,
                read_document_snapshot,
                lsp_typescript_path,
                run_script,
                stop_script,
                bootstrap_state,
                metadata_summary,
                persist_state,
                save_script,
                delete_script,
                list_scripts,
                list_script_runs,
                list_revisions,
                get_revision,
                set_workspace,
                list_workspaces,
                create_workspace,
                select_workspace,
                rename_workspace,
                delete_workspace,
                add_workspace_files,
                remove_workspace_file,
                index_workspace,
                search_workspace,
                search_workspace_advanced,
                graph_workspace,
                read_workspace_note,
                read_workspace_asset,
                lsp_start,
                lsp_send,
                lsp_stop,
                lsp_status,
                engine_status,
                render_diagram,
                export_document,
                cancel_export,
                render_citations,
                open_external,
                get_tasks,
                get_tags,
                get_backlinks,
                list_directory,
                git_repository,
                git_status,
                git_history,
                git_diff,
                launch_ready,
                set_launch_closing,
                complete_launch_request,
                agent_ready,
                agent_status,
                complete_agent_request,
                parse_frontmatter,
                get_frontmatter,
                query_properties,
                resolve_wiki_link,
                wiki_candidates,
                create_wiki_note,
                list_sticky_notes, create_sticky_note, open_sticky_note, delete_sticky_note,
                read_sticky_note, update_sticky_note, close_sticky_note
                ];
                move |invoke: tauri::ipc::Invoke| {
                    // Custom app commands have no generated ACL. Keep sticky webviews
                    // out of ordinary drafts, files, scripts and lifecycle commands too.
                    if invoke.message.webview_ref().label().starts_with("sticky-")
                        && !matches!(invoke.message.command(), "read_sticky_note" | "update_sticky_note" | "close_sticky_note")
                    {
                        invoke.resolver.reject("Sticky windows may only read, update and close their own note.");
                        return true;
                    }
                    commands(invoke)
                }
            })
            .build(tauri::generate_context!())
            .expect("Notation could not start");
        // Configured webviews are created on RunEvent::Ready. Claim ownership
        // before entering the event loop, so secondary launches create none.
        #[cfg(target_os = "linux")]
        match app
            .path()
            .app_data_dir()
            .map_err(|error| format!("Could not locate local data directory: {error}"))
            .and_then(|path| {
                let activation_handle = app.handle().clone();
                let launch_handle = activation_handle.clone();
                let launch_queue = launches.clone();
                instance::acquire_with_launch(
                    &path,
                    move || activate_main(activation_handle.clone()),
                    move |request| {
                        let outcome = launch_queue.enqueue(request.clone())?;
                        if outcome == launch::EnqueueOutcome::DuplicateCompleted {
                            return Ok(());
                        }
                        if launch_queue.ready()? {
                            // Pending duplicates are deliberately re-emitted to
                            // heal missed events. Failure rejects this handshake
                            // as retryable; completed IDs are never re-opened.
                            launch_handle
                                .emit_to("main", "notation:launch-request", request)
                                .map_err(|error| format!("Could not deliver launch request: {error}"))?;
                        }
                        Ok(())
                    },
                    initial_request.clone(),
                )
            }) {
            Ok(instance::Acquisition::Owner(owner)) => {
                app.manage(owner);
            }
            Ok(instance::Acquisition::Activated) => return,
            Err(error) => {
                eprintln!("Notation could not start: {error}");
                std::process::exit(1);
            }
        }
        app.run(|handle, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                handle.state::<language_server::Service>().stop_all();
            }
        });
    }
}
#[cfg(feature = "desktop")]
pub use desktop::run;
