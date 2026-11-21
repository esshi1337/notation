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
pub mod math_export;
pub mod mcp;
pub mod search_graph;
#[cfg(unix)]
pub mod single_instance;
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
    async fn document_fingerprint(path: String) -> Result<super::file_changes::Fingerprint, String> {
        tauri::async_runtime::spawn_blocking(move || super::file_changes::fingerprint(&path))
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
        known: Option<String>,
        database: State<'_, DatabaseState>,
    ) -> Result<assets::AssetResponse, String> {
        database_work(database.get()?, move |database| {
            assets::read_if_changed(&database, &path, source_path.as_deref(), known.as_deref())
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
        // macOS has no xdg-open; its `open` hands the URL to the default browser.
        let opener = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
        let mut child = std::process::Command::new(opener)
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
    async fn create_sticky_note(window: tauri::WebviewWindow, database: State<'_, DatabaseState>) -> Result<sticky::Metadata, String> {
        sticky::authorize_main(window.label())?;
        let database = database.get()?;
        // The admission lock is held across the database call; do that on the
        // blocking pool, never on an async worker or the UI thread.
        sticky_work(&window, move |manager| {
            let admission = manager.lock()?;
            admission.check_open()?;
            database.create_sticky()
        })
        .await
    }
    #[tauri::command]
    async fn delete_sticky_note(window: tauri::WebviewWindow, id: String, database: State<'_, DatabaseState>) -> Result<(), String> {
        sticky::authorize_main(window.label())?;
        let database = database.get()?;
        // Serialize deletion with reservation. Never hold this lock across window APIs.
        sticky_work(&window, move |manager| {
            let admission = manager.lock()?;
            admission.check_delete(&id)?;
            database.delete_sticky(&id)
        })
        .await
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
        let db = database.get()?;
        let reserved = {
            let (db, id) = (db.clone(), id.clone());
            sticky_work(&window, move |manager| {
                let mut admission = manager.lock()?;
                // Existence and reservation are atomic with respect to deletion.
                db.read_sticky(&id)?;
                admission.reserve(&id)
            })
            .await?
        };
        build_sticky_window(&app, &db, &manager, &id, reserved, false)
    }
    #[tauri::command]
    async fn new_sticky_note(window: tauri::WebviewWindow, id: String, app: tauri::AppHandle, database: State<'_, DatabaseState>, manager: State<'_, sticky::StickyManager>) -> Result<(), String> {
        sticky::authorize_note(window.label(), &id)?;
        let db = database.get()?;
        let note = {
            let db = db.clone();
            sticky_work(&window, move |manager| {
                let mut admission = manager.lock()?;
                db.read_sticky(&id)?;
                admission.reserve_new(&db)
            })
            .await?
        };
        build_sticky_window(&app, &db, &manager, &note.id, true, true)
    }
    #[tauri::command]
    async fn drag_sticky_note(window: tauri::WebviewWindow, id: String) -> Result<(), String> {
        sticky::authorize_note(window.label(), &id)?;
        window.start_dragging().map_err(|error| error.to_string())
    }
    /// Run a section that takes the sticky admission lock on the blocking pool.
    async fn sticky_work<T: Send + 'static>(
        window: &tauri::WebviewWindow,
        operation: impl FnOnce(&sticky::StickyManager) -> Result<T, String> + Send + 'static,
    ) -> Result<T, String> {
        let app = window.app_handle().clone();
        tauri::async_runtime::spawn_blocking(move || operation(&app.state::<sticky::StickyManager>()))
            .await
            .map_err(|error| format!("Sticky note task failed: {error}"))?
    }
    // Main-list opens and the sticky plus button share focus, construction and cleanup.
    fn build_sticky_window(app: &tauri::AppHandle, database: &storage::Database, manager: &sticky::StickyManager, id: &str, reserved: bool, created: bool) -> Result<(), String> {
        let label = format!("sticky-{id}");
        if !reserved {
            let existing = app.get_webview_window(&label).ok_or("Sticky window is still opening. Try again shortly.")?;
            existing.unminimize().map_err(|e| e.to_string())?;
            return existing.set_focus().map_err(|e| e.to_string());
        }
        // No parent/owner: these windows stay independent when main is minimized.
        let builder = tauri::WebviewWindowBuilder::new(app, &label, tauri::WebviewUrl::App(format!("index.html?sticky={id}").into()))
            .title("Sticky note — Notation").inner_size(340.0, 380.0).min_inner_size(240.0, 200.0)
            .decorations(false).resizable(true).always_on_top(true).background_color(tauri::window::Color(0, 0, 0, 255));
        // On macOS a note should follow the user across Spaces and read as a
        // floating window; an undecorated window has no shadow by default.
        let builder = if cfg!(target_os = "macos") { builder.visible_on_all_workspaces(true).shadow(true) } else { builder };
        let result = builder.build();
        if let Err(error) = result {
            let cleanup = manager.lock()?.failed_open(database, id, created);
            return Err(match cleanup {
                Ok(()) => format!("Could not open sticky window: {error}"),
                Err(cleanup) => format!("Could not open sticky window: {error}. {cleanup}"),
            });
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
    // Asynchronous so it does not run on the UI thread: a sticky command may
    // hold the admission lock while it waits for the database.
    #[tauri::command]
    async fn set_launch_closing(
        window: tauri::WebviewWindow,
        closing: bool,
        launches: State<'_, launch::LaunchQueue>,
    ) -> Result<(), String> {
        sticky::authorize_main(window.label())?;
        let launches = launches.inner().clone();
        sticky_work(&window, move |manager| {
            manager.lock()?.close_with(closing, || launches.set_closing(closing))
        })
        .await
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

    /// App commands offered in the macOS menu bar. The identifiers are the
    /// frontend command ids; the main window runs them exactly like a
    /// keyboard shortcut. They carry no key equivalents: shortcuts are
    /// user-configurable and are handled (and shown) by the app itself, and a
    /// native key equivalent would run before the webview sees the key.
    const MENU_COMMAND_PREFIX: &str = "command:";
    const MENU_QUIT: &str = "notation:quit";
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    fn application_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
        use tauri::menu::{MenuBuilder, MenuItem, SubmenuBuilder};
        let command = |id: &str| format!("{MENU_COMMAND_PREFIX}{id}");
        // Quit asks the main window to close, so unsaved work is handled by
        // the same guard as the window's close button.
        let quit = MenuItem::with_id(app, MENU_QUIT, "Quit Notation", true, Some("CmdOrCtrl+Q"))?;
        let application = SubmenuBuilder::new(app, "Notation")
            .about(None)
            .separator()
            .text(command("app.settings"), "Settings…")
            .separator()
            .services()
            .separator()
            .hide()
            .hide_others()
            .show_all()
            .separator()
            .item(&quit)
            .build()?;
        // No "Close Window" item: its ⌘W would close the whole window before
        // the app could close the current tab.
        let file = SubmenuBuilder::new(app, "File")
            .text(command("file.new"), "New")
            .text(command("file.newCanvas"), "New Canvas")
            .text(command("sticky.new"), "New Sticky Note")
            .separator()
            .text(command("file.open"), "Open…")
            .separator()
            .text(command("file.save"), "Save")
            .text(command("file.saveAs"), "Save As…")
            .text(command("file.rename"), "Rename…")
            .text(command("panel.export"), "Export…")
            .separator()
            .text(command("tab.close"), "Close Tab")
            .build()?;
        // The system items give text fields in the webview their standard
        // clipboard and undo behaviour.
        let edit = SubmenuBuilder::new(app, "Edit")
            .undo()
            .redo()
            .separator()
            .cut()
            .copy()
            .paste()
            .select_all()
            .separator()
            .text(command("edit.find"), "Find…")
            .text(command("edit.replace"), "Find and Replace…")
            .build()?;
        let view = SubmenuBuilder::new(app, "View")
            .text(command("view.source"), "Source")
            .text(command("view.split"), "Split")
            .text(command("view.preview"), "Preview")
            .text(command("view.live"), "Live Preview")
            .separator()
            .text(command("view.focus"), "Focus Mode")
            .text(command("app.commands"), "Command Palette…")
            .separator()
            .fullscreen()
            .build()?;
        let window = SubmenuBuilder::new(app, "Window")
            .minimize()
            .maximize()
            .separator()
            .text(command("tab.next"), "Show Next Tab")
            .text(command("tab.previous"), "Show Previous Tab")
            .build()?;
        MenuBuilder::new(app)
            .items(&[&application, &file, &edit, &view, &window])
            .build()
    }
    /// Show the configured shortcuts next to their menu items. `shortcuts`
    /// maps frontend command ids to accelerators (`CmdOrCtrl+Shift+S`); menu
    /// commands without an entry lose theirs. Once an item has an accelerator
    /// the menu handles that key and sends the command, so the frontend
    /// clears them while it needs to see every key (shortcut capture).
    /// Without an application menu (every platform but macOS) this does
    /// nothing.
    #[tauri::command]
    fn set_menu_shortcuts(
        window: tauri::WebviewWindow,
        app: tauri::AppHandle,
        shortcuts: std::collections::HashMap<String, String>,
    ) -> Result<(), String> {
        sticky::authorize_main(window.label())?;
        fn apply(
            items: Vec<tauri::menu::MenuItemKind<tauri::Wry>>,
            shortcuts: &std::collections::HashMap<String, String>,
        ) {
            for item in items {
                match item {
                    tauri::menu::MenuItemKind::Submenu(submenu) => {
                        apply(submenu.items().unwrap_or_default(), shortcuts)
                    }
                    tauri::menu::MenuItemKind::MenuItem(item) => {
                        if let Some(command) = item.id().as_ref().strip_prefix(MENU_COMMAND_PREFIX) {
                            // An accelerator the menu library cannot parse is
                            // dropped; the key then still reaches the app.
                            let _ = item.set_accelerator(shortcuts.get(command));
                        }
                    }
                    _ => {}
                }
            }
        }
        if let Some(menu) = app.menu() {
            apply(menu.items().map_err(|error| error.to_string())?, &shortcuts);
        }
        Ok(())
    }
    /// `#rrggbb` as an opaque window colour.
    fn opaque_color(value: &str) -> Option<tauri::window::Color> {
        let digits = value.strip_prefix('#')?;
        if digits.len() != 6 || !digits.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return None;
        }
        let channel = |at: usize| u8::from_str_radix(&digits[at..at + 2], 16).ok();
        Some(tauri::window::Color(channel(0)?, channel(2)?, channel(4)?, 255))
    }
    /// The main window is created hidden so no unpainted, wrongly coloured
    /// window is ever shown. The frontend calls this after its first frame,
    /// and again when the theme changes: the native background (visible
    /// before paint and along the edges while resizing) and the light/dark
    /// appearance follow the theme, then the window is shown.
    #[tauri::command]
    fn present_main_window(
        window: tauri::WebviewWindow,
        background: String,
        theme: String,
    ) -> Result<(), String> {
        sticky::authorize_main(window.label())?;
        let color = opaque_color(&background).ok_or("Window background must be #rrggbb.")?;
        let appearance = match theme.as_str() {
            "light" => tauri::Theme::Light,
            "dark" => tauri::Theme::Dark,
            _ => return Err("Window theme must be light or dark.".into()),
        };
        // Appearance and colour are cosmetic; showing the window is not.
        let _ = window.set_background_color(Some(color));
        let _ = window.set_theme(Some(appearance));
        if !window.is_visible().unwrap_or(false) {
            window.show().map_err(|error| error.to_string())?;
            let _ = window.set_focus();
        }
        Ok(())
    }
    /// If the frontend never presents the window (it failed to start), show
    /// it anyway so the failure is visible rather than an invisible process.
    const PRESENT_FALLBACK: std::time::Duration = std::time::Duration::from_secs(4);
    fn present_fallback(handle: tauri::AppHandle) {
        std::thread::spawn(move || {
            std::thread::sleep(PRESENT_FALLBACK);
            if let Some(main) = handle.get_webview_window("main") {
                if !main.is_visible().unwrap_or(true) {
                    let _ = main.show();
                }
            }
        });
    }
    /// Whether closing has work to do that must not be skipped: app state is
    /// being written or the last write failed. Reported by the frontend.
    static QUIT_GUARD_NEEDED: std::sync::atomic::AtomicBool =
        std::sync::atomic::AtomicBool::new(false);
    /// Set once the app is on its way out, so nothing holds it back again.
    static EXITING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    #[tauri::command]
    fn set_quit_guard(window: tauri::WebviewWindow, needed: bool) -> Result<(), String> {
        sticky::authorize_main(window.label())?;
        QUIT_GUARD_NEEDED.store(needed, std::sync::atomic::Ordering::SeqCst);
        Ok(())
    }
    /// macOS sends Quit from the Dock menu, logout, shutdown and AppleScript
    /// straight to the application object. The window library has no
    /// `applicationShouldTerminate:` handler, so such a quit ends the process
    /// without the main window's close guard and without a preventable
    /// `RunEvent::ExitRequested`. This adds the handler to the existing
    /// application delegate: when the guard has work to do, the termination
    /// is cancelled and a normal main-window close is requested instead (the
    /// guard ends the app when it is done); otherwise the app terminates at
    /// once, so logout is not interrupted without reason.
    #[cfg(target_os = "macos")]
    mod quit_guard {
        use super::{EXITING, QUIT_GUARD_NEEDED};
        use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
        use objc2::{class, msg_send, sel};
        use std::sync::atomic::Ordering;
        use std::sync::OnceLock;
        use tauri::Manager;

        static APP: OnceLock<tauri::AppHandle> = OnceLock::new();
        // NSApplicationTerminateReply
        const TERMINATE_CANCEL: usize = 0;
        const TERMINATE_NOW: usize = 1;

        extern "C-unwind" fn should_terminate(
            _this: *mut AnyObject,
            _selector: Sel,
            _sender: *mut AnyObject,
        ) -> usize {
            if EXITING.load(Ordering::SeqCst) || !QUIT_GUARD_NEEDED.load(Ordering::SeqCst) {
                return TERMINATE_NOW;
            }
            let Some(main) = APP.get().and_then(|app| app.get_webview_window("main")) else {
                return TERMINATE_NOW;
            };
            let _ = main.unminimize();
            let _ = main.show();
            if main.close().is_err() {
                return TERMINATE_NOW;
            }
            TERMINATE_CANCEL
        }

        /// Call on the main thread once the application delegate exists.
        pub fn install(app: &tauri::AppHandle) {
            if APP.set(app.clone()).is_err() {
                return;
            }
            // SAFETY: plain Objective-C runtime calls on the main thread. The
            // method is added only if the delegate class does not define it,
            // and its signature (`NSUInteger (id, SEL, id)`, "Q@:@") matches
            // `applicationShouldTerminate:` on 64-bit macOS.
            unsafe {
                let application: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
                if application.is_null() {
                    return;
                }
                let delegate: *mut AnyObject = msg_send![application, delegate];
                if delegate.is_null() {
                    return;
                }
                let class = objc2::ffi::object_getClass(delegate) as *mut AnyClass;
                let handler: extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject) -> usize =
                    should_terminate;
                let implementation: Imp = std::mem::transmute(handler);
                let _ = objc2::ffi::class_addMethod(
                    class,
                    sel!(applicationShouldTerminate:),
                    implementation,
                    c"Q@:@".as_ptr(),
                );
            }
        }
    }
    fn handle_menu_event(app: &tauri::AppHandle, id: &str) {
        if let Some(command) = id.strip_prefix(MENU_COMMAND_PREFIX) {
            let _ = app.emit_to("main", "notation:menu-command", command);
        } else if id == MENU_QUIT {
            match app.get_webview_window("main") {
                // The frontend close guard flushes state, asks about unsaved
                // work and then destroys the window, which ends the app.
                Some(main) => {
                    let _ = main.unminimize();
                    let _ = main.show();
                    if main.close().is_err() {
                        app.exit(0);
                    }
                }
                None => app.exit(0),
            }
        }
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

    /// Queue documents for the main window and tell it when it is listening.
    fn deliver_launch(
        handle: &tauri::AppHandle,
        queue: &launch::LaunchQueue,
        request: launch::LaunchRequest,
    ) -> Result<(), String> {
        let outcome = queue.enqueue(request.clone())?;
        if outcome == launch::EnqueueOutcome::DuplicateCompleted {
            return Ok(());
        }
        if queue.ready()? {
            // Pending duplicates are deliberately re-emitted to
            // heal missed events. Failure rejects this handshake
            // as retryable; completed IDs are never re-opened.
            handle
                .emit_to("main", "notation:launch-request", request)
                .map_err(|error| format!("Could not deliver launch request: {error}"))?;
        }
        Ok(())
    }
    /// Finder double-clicks, Open With and Dock drops arrive as file URLs
    /// while the app runs (or right after it starts), never as arguments.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    fn open_file_urls(handle: &tauri::AppHandle, queue: &launch::LaunchQueue, urls: &[tauri::Url]) {
        let delivered = launch::from_file_urls(urls.iter().map(|url| url.as_str()))
            .and_then(|request| match request {
                Some(request) => deliver_launch(handle, queue, request),
                None => Ok(()),
            });
        if let Err(error) = delivered {
            eprintln!("Notation could not open the requested documents: {error}");
        }
        if let Some(main) = handle.get_webview_window("main") {
            let _ = main.unminimize();
            let _ = main.set_focus();
        }
    }
    /// One editor per profile on macOS. LaunchServices already reuses the
    /// running app for ordinary launches; this covers `open -n` and direct
    /// command-line starts, which would otherwise run a second process on the
    /// same database. The second process passes its documents to the running
    /// app through LaunchServices and exits.
    #[cfg(target_os = "macos")]
    fn claim_profile(
        app: &tauri::App,
        initial_request: Option<&launch::LaunchRequest>,
    ) -> Result<Option<super::single_instance::ProfileLock>, String> {
        let directory = app
            .path()
            .app_data_dir()
            .map_err(|error| format!("Could not locate local data directory: {error}"))?;
        if let Some(lock) = super::single_instance::acquire(&directory)? {
            return Ok(Some(lock));
        }
        let mut handoff = std::process::Command::new("open");
        handoff.arg("-b").arg(&app.config().identifier);
        if let Some(request) = initial_request {
            handoff.args(request.paths());
        }
        match handoff.status() {
            Ok(status) if status.success() => Ok(None),
            _ => Err("Notation is already running with this profile. Switch to it, or quit it first.".into()),
        }
    }

    pub fn run(initial_request: Option<launch::LaunchRequest>) {
        let launches = launch::LaunchQueue::default();
        if let Some(request) = initial_request.clone() {
            if let Err(error) = launches.enqueue(request) {
                eprintln!("Notation could not queue the requested documents: {error}");
                std::process::exit(1);
            }
        }
        let builder = tauri::Builder::default();
        // Only macOS has an application menu bar; elsewhere a menu would add
        // a menu bar to every window.
        #[cfg(target_os = "macos")]
        let builder = builder.menu(application_menu);
        let app = builder
            .on_menu_event(|app, event| handle_menu_event(app, event.id().as_ref()))
            .manage(automation::ScriptManager::default())
            .manage(launches.clone())
            .manage(sticky::StickyManager::default())
            .on_window_event(|window, event| {
                if matches!(event, tauri::WindowEvent::Destroyed) {
                    if let Some(id) = window.label().strip_prefix("sticky-") {
                        // This handler runs on the UI thread. If a sticky
                        // command holds the admission lock (it may be waiting
                        // for the database), release from a worker instead.
                        if !window.state::<sticky::StickyManager>().try_release(id) {
                            let (app, id) = (window.app_handle().clone(), id.to_string());
                            std::thread::spawn(move || {
                                if let Ok(mut admission) = app.state::<sticky::StickyManager>().lock() {
                                    admission.release(&id);
                                }
                            });
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
                present_fallback(app.handle().clone());
                #[cfg(target_os = "macos")]
                quit_guard::install(app.handle());
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
                document_fingerprint,
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
                set_menu_shortcuts,
                set_quit_guard,
                present_main_window,
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
                read_sticky_note, update_sticky_note, close_sticky_note, new_sticky_note, drag_sticky_note
                ];
                move |invoke: tauri::ipc::Invoke| {
                    // Custom app commands have no generated ACL. Keep sticky webviews
                    // out of ordinary drafts, files, scripts and lifecycle commands too.
                    if let Err(error) = sticky::authorize_command(invoke.message.webview_ref().label(), invoke.message.command()) {
                        invoke.resolver.reject(error);
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
                    move |request| deliver_launch(&launch_handle, &launch_queue, request),
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
        // Held until the process ends; a second launch hands over and exits.
        #[cfg(target_os = "macos")]
        let _profile = match claim_profile(&app, initial_request.as_ref()) {
            Ok(Some(lock)) => lock,
            Ok(None) => return,
            Err(error) => {
                eprintln!("Notation could not start: {error}");
                std::process::exit(1);
            }
        };
        #[cfg(target_os = "macos")]
        let opened_queue = launches.clone();
        app.run(move |handle, event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = &event {
                open_file_urls(handle, &opened_queue, urls);
            }
            if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
                // Nothing prevents this exit; a later system quit must pass.
                EXITING.store(true, std::sync::atomic::Ordering::SeqCst);
            }
            if matches!(event, tauri::RunEvent::Exit) {
                handle.state::<language_server::Service>().stop_all();
            }
        });
    }
}
#[cfg(feature = "desktop")]
pub use desktop::run;
