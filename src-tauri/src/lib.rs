pub mod assets;
pub mod automation;
pub mod documents;
pub mod engine_process;
pub mod engines;
pub mod explorer;
pub mod frontmatter;
pub mod git;
pub mod mcp;
pub mod search_graph;
pub mod storage;
pub mod wiki;
pub mod workspace;

#[cfg(feature = "desktop")]
mod desktop {
    use super::{
        assets, automation, documents, engines, explorer, frontmatter, git, mcp, search_graph,
        storage, wiki, workspace,
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
        tauri::async_runtime::spawn_blocking(move || storage::read_with_metadata(&path, &database))
            .await
            .map_err(|error| format!("Could not open file: {error}"))?
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
    async fn git_status(database: State<'_, DatabaseState>) -> Result<git::Status, String> {
        database_work(database.get()?, move |database| Ok(git::status(&database))).await
    }
    #[tauri::command]
    async fn git_history(
        limit: Option<usize>,
        database: State<'_, DatabaseState>,
    ) -> Result<Vec<git::Commit>, String> {
        database_work(database.get()?, move |database| {
            git::history(&database, limit)
        })
        .await
    }
    #[tauri::command]
    async fn git_diff(
        path: String,
        staged: Option<bool>,
        database: State<'_, DatabaseState>,
    ) -> Result<git::Diff, String> {
        database_work(database.get()?, move |database| {
            git::diff(&database, &path, staged.unwrap_or(false))
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

    pub fn run() {
        tauri::Builder::default()
            .manage(automation::ScriptManager::default())
            .setup(|app| {
                app.manage(engines::Runtime::discover(app.path().resource_dir().ok()));
                let data_directory = app
                    .path()
                    .app_data_dir()
                    .map_err(|error| format!("Could not locate local data directory: {error}"));
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
            .invoke_handler(tauri::generate_handler![
                read_document,
                resolve_document_path,
                write_document,
                run_script,
                stop_script,
                bootstrap_state,
                persist_state,
                save_script,
                delete_script,
                list_scripts,
                list_script_runs,
                list_revisions,
                get_revision,
                set_workspace,
                index_workspace,
                search_workspace,
                search_workspace_advanced,
                graph_workspace,
                read_workspace_note,
                read_workspace_asset,
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
                git_status,
                git_history,
                git_diff,
                agent_ready,
                agent_status,
                complete_agent_request,
                parse_frontmatter,
                get_frontmatter,
                query_properties,
                resolve_wiki_link,
                wiki_candidates,
                create_wiki_note
            ])
            .run(tauri::generate_context!())
            .expect("Notation could not start");
    }
}
#[cfg(feature = "desktop")]
pub use desktop::run;
