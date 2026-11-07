mod active;
mod appconfig;
mod drafts;
mod projects;
mod remote;
mod runs;
mod sidecar;
mod spawn;
mod watch;

use std::path::{Path, PathBuf};
use tauri::Manager;

fn config_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path().app_config_dir().map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_runs(repo_path: String) -> Result<Vec<runs::RunSummary>, String> {
    runs::list_run_summaries(Path::new(&repo_path)).map_err(|e| e.to_string())
}

#[tauri::command]
async fn read_run(
    app: tauri::AppHandle,
    repo_path: String,
    task_id: String,
    timestamp: String,
    source: remote::RunSource,
) -> Result<runs::RunDetail, String> {
    let root = remote::resolve_root(&config_dir(&app)?, Path::new(&repo_path), &source);
    runs::read_run_detail(&root, &task_id, &timestamp).map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_projects(app: tauri::AppHandle) -> Result<Vec<projects::Project>, String> {
    projects::list(&config_dir(&app)?).map_err(|e| e.to_string())
}

#[tauri::command]
async fn add_project(app: tauri::AppHandle, path: String) -> Result<Vec<projects::Project>, String> {
    projects::add(&config_dir(&app)?, &path).map_err(|e| e.to_string())
}

#[tauri::command]
async fn remove_project(
    app: tauri::AppHandle,
    path: String,
) -> Result<Vec<projects::Project>, String> {
    projects::remove(&config_dir(&app)?, &path).map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_active(repo_path: String) -> Result<Vec<active::ActiveRun>, String> {
    active::list_active(Path::new(&repo_path)).map_err(|e| e.to_string())
}

#[tauri::command]
async fn read_session(session_file: String) -> Result<active::SessionRead, String> {
    if !active::is_session_path(&session_file) {
        return Err("invalid session path".into());
    }
    active::read_session(Path::new(&session_file)).map_err(|e| e.to_string())
}

#[tauri::command]
async fn read_app_config(repo_path: String) -> Result<appconfig::AppConfig, String> {
    // Passive read: collapse-to-default. TaskDraftScreen consumes this directly (chat model, task
    // source) and must keep degrading gracefully on an unreadable file — routing THIS command
    // through read_strict broke every chat turn on a hand-edit typo (review #341 r2 blocking).
    Ok(appconfig::read(Path::new(&repo_path)))
}

#[tauri::command]
async fn read_app_config_strict(repo_path: String) -> Result<appconfig::AppConfig, String> {
    // Settings' read (S6 guard b): a file that EXISTS but cannot be read/parsed is an error —
    // Save stays blocked instead of replacing the user's hand-edited JSON with defaults.
    appconfig::read_strict(Path::new(&repo_path))
}

#[tauri::command]
async fn write_app_config(repo_path: String, config: appconfig::AppConfig) -> Result<(), String> {
    appconfig::write(Path::new(&repo_path), &config).map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_drafts(repo_path: String) -> Result<Vec<String>, String> {
    Ok(drafts::list(Path::new(&repo_path)))
}

#[tauri::command]
async fn read_draft(repo_path: String, id: String) -> Result<String, String> {
    drafts::read(Path::new(&repo_path), &id)
}

#[tauri::command]
async fn write_draft(repo_path: String, id: String, content: String) -> Result<(), String> {
    drafts::write(Path::new(&repo_path), &id, &content)
}

#[tauri::command]
async fn delete_draft(repo_path: String, id: String) -> Result<(), String> {
    drafts::delete(Path::new(&repo_path), &id)
}

/// Persist a composer image attachment (Editor UX 7/7) under the draft's assets dir; returns the
/// absolute path the renderer forwards to `__complete`. Bytes arrive as a `Vec<u8>` (no base64
/// crate), decoded from the pasted image in the webview.
#[tauri::command]
async fn write_draft_asset(repo_path: String, id: String, name: String, bytes: Vec<u8>) -> Result<String, String> {
    drafts::write_asset(Path::new(&repo_path), &id, &name, &bytes)
}

/// Remove a draft's pasted-image assets dir (keeping the JSON) when the draft is filed — the images
/// already rode the chat that produced the task (review r5).
#[tauri::command]
async fn clear_draft_assets(repo_path: String, id: String) -> Result<(), String> {
    drafts::clear_assets(Path::new(&repo_path), &id)
}

#[tauri::command]
async fn list_remote_runs(app: tauri::AppHandle, repo_path: String) -> Result<Vec<remote::RemoteRun>, String> {
    remote::list_remote_runs(&config_dir(&app)?, Path::new(&repo_path))
}

/// Pull a CI run's record artifact into `<app config>/remote-runs/…` and parse it like local runs.
/// Shared command name/shape with the hub's `import_remote_run` (src/hub/rpc.ts) — each backend
/// resolves the `{kind: 'ci', runId}` source this hands back to its own root in `read_run`.
#[tauri::command]
async fn import_remote_run(
    app: tauri::AppHandle,
    repo_path: String,
    run_id: u64,
) -> Result<remote::RemoteImport, String> {
    remote::import_remote_run(&config_dir(&app)?, Path::new(&repo_path), run_id)
}

/// Board read path (S9): one brain — the transports live in core now. Same command name, new
/// body: a Timed query-pipe exchange (idempotent remote read); the old Rust implementations
/// (tasks.rs/spec.rs/taskid.rs) are deleted.
#[tauri::command(async)]
fn list_tasks(state: tauri::State<'_, sidecar::Sidecar>, repo_path: String) -> Result<serde_json::Value, String> {
    sidecar::board_request(&state, "listTasks", serde_json::json!({ "repoPath": repo_path }))
}

#[tauri::command(async)]
fn fetch_spec(state: tauri::State<'_, sidecar::Sidecar>, repo_path: String, task_id: String) -> Result<serde_json::Value, String> {
    sidecar::board_request(&state, "fetchSpec", serde_json::json!({ "repoPath": repo_path, "taskId": task_id }))
}

#[tauri::command]
async fn spawn_run(app: tauri::AppHandle, cwd: String, argv: Vec<String>) -> Result<u32, String> {
    spawn::spawn(app, cwd, argv).map_err(|e| e.to_string())
}

#[tauri::command]
async fn kill_run(state: tauri::State<'_, spawn::SpawnState>, pid: u32) -> Result<(), String> {
    spawn::kill(&state, pid);
    Ok(())
}

#[tauri::command]
async fn list_spawns(state: tauri::State<'_, spawn::SpawnState>) -> Result<Vec<spawn::SpawnInfo>, String> {
    Ok(spawn::list_spawns(&state))
}

#[tauri::command]
async fn watch_project(
    app: tauri::AppHandle,
    state: tauri::State<'_, watch::WatchState>,
    repo_path: String,
) -> Result<(), String> {
    watch::start(app, &state, repo_path).map_err(|e| e.to_string())
}

#[tauri::command]
async fn unwatch_project(
    state: tauri::State<'_, watch::WatchState>,
    repo_path: String,
) -> Result<(), String> {
    watch::stop(&state, &repo_path);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(watch::WatchState::default())
        .manage(spawn::SpawnState::default())
        .manage(sidecar::Sidecar::default())
        .invoke_handler(tauri::generate_handler![
            list_runs,
            read_run,
            list_projects,
            add_project,
            remove_project,
            list_active,
            read_session,
            read_app_config,
            read_app_config_strict,
            write_app_config,
            list_drafts,
            read_draft,
            write_draft,
            delete_draft,
            write_draft_asset,
            clear_draft_assets,
            list_remote_runs,
            import_remote_run,
            list_tasks,
            fetch_spec,
            spawn_run,
            kill_run,
            list_spawns,
            watch_project,
            unwatch_project,
            sidecar::api_capabilities,
            sidecar::api_complete,
            sidecar::api_cancel_complete,
            sidecar::api_create_run,
            sidecar::api_active_run,
            sidecar::api_run_backlog,
            sidecar::api_cancel,
            sidecar::api_create_task,
            sidecar::api_list_flows,
            sidecar::api_list_providers,
            sidecar::api_read_flow,
            sidecar::api_write_flow,
            sidecar::api_delete_flow,
            sidecar::api_list_repo_files,
            sidecar::api_read_repo_file,
            sidecar::api_repo_ok
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
