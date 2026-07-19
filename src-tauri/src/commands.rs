use std::{path::PathBuf, sync::Arc};

use serde_json::{Map, Value};
use tauri::{State, ipc::Channel};
use uuid::Uuid;

use crate::{
    credentials::pi_agent_dir,
    diagnostics::resolve_pi,
    error::{AppError, AppResult},
    manager::ProjectManager,
    models::{
        AppEvent, AppSettings, BootstrapState, PackageCatalogPage, PackageCatalogQuery,
        PackageOperationRequest, PackageOperationResult, PackageProgress, PackageScope,
        PiEnvironmentReport, PiPackageRecord, ProjectRecord, PromptImage, ProviderCredentialStatus,
        SessionPage, SessionSummary, SettingsPatch,
    },
    packages::PiPackageManager,
    sessions,
};

pub struct AppState {
    pub manager: Arc<ProjectManager>,
    pub packages: Arc<PiPackageManager>,
}

#[tauri::command]
pub async fn initialize(
    on_event: Channel<AppEvent>,
    state: State<'_, AppState>,
) -> AppResult<BootstrapState> {
    state.manager.set_channel(on_event);
    let config = state.manager.config.snapshot();
    Ok(BootstrapState {
        settings: config.settings,
        projects: config.projects,
        environment: state.manager.diagnose_pi(),
        providers: state.manager.credentials.list_statuses(),
        dismissed_notification_keys: config.dismissed_notification_keys,
    })
}

#[tauri::command]
pub fn diagnose_pi(state: State<'_, AppState>) -> PiEnvironmentReport {
    state.manager.diagnose_pi()
}

#[tauri::command]
pub async fn add_project(
    path: PathBuf,
    trusted: bool,
    state: State<'_, AppState>,
) -> AppResult<ProjectRecord> {
    let path = std::fs::canonicalize(path)?;
    if !path.is_dir() {
        return Err(AppError::Message("Choose a project folder".into()));
    }
    let now = chrono::Utc::now().to_rfc3339();
    state.manager.config.mutate(|config| {
        if let Some(existing) = config
            .projects
            .iter_mut()
            .find(|project| project.path == path)
        {
            existing.trusted = trusted;
            existing.last_opened_at = now.clone();
            config.settings.active_project_id = Some(existing.id.clone());
            return Ok(existing.clone());
        }
        let project = ProjectRecord {
            id: Uuid::new_v4().to_string(),
            name: path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("Project")
                .to_owned(),
            path: path.clone(),
            trusted,
            active_session: None,
            created_at: now.clone(),
            last_opened_at: now.clone(),
        };
        config.settings.active_project_id = Some(project.id.clone());
        config.projects.push(project.clone());
        Ok(project)
    })
}

#[tauri::command]
pub async fn remove_project(project_id: String, state: State<'_, AppState>) -> AppResult<()> {
    state.manager.stop_project(&project_id).await?;
    state.manager.config.mutate(|config| {
        let original = config.projects.len();
        config.projects.retain(|project| project.id != project_id);
        if original == config.projects.len() {
            return Err(AppError::ProjectNotFound);
        }
        if config.settings.active_project_id.as_deref() == Some(project_id.as_str()) {
            config.settings.active_project_id =
                config.projects.first().map(|project| project.id.clone());
        }
        Ok(())
    })
}

#[tauri::command]
pub async fn update_project_trust(
    project_id: String,
    trusted: bool,
    state: State<'_, AppState>,
) -> AppResult<ProjectRecord> {
    let project = state.manager.config.mutate(|config| {
        let project = config
            .projects
            .iter_mut()
            .find(|project| project.id == project_id)
            .ok_or(AppError::ProjectNotFound)?;
        project.trusted = trusted;
        Ok(project.clone())
    })?;
    if state.manager.is_running(&project_id).await {
        state.manager.restart_project(&project_id).await?;
    }
    Ok(project)
}

#[tauri::command]
pub async fn activate_project(project_id: String, state: State<'_, AppState>) -> AppResult<()> {
    state.manager.activate_project(&project_id).await
}

#[tauri::command]
pub async fn restart_project(project_id: String, state: State<'_, AppState>) -> AppResult<()> {
    state.manager.restart_project(&project_id).await
}

#[tauri::command]
pub async fn stop_project(project_id: String, state: State<'_, AppState>) -> AppResult<()> {
    state.manager.stop_project(&project_id).await
}

#[tauri::command]
pub async fn list_sessions(
    project_id: String,
    query: Option<String>,
    state: State<'_, AppState>,
) -> AppResult<Vec<SessionSummary>> {
    let project = state
        .manager
        .config
        .project(&project_id)
        .ok_or(AppError::ProjectNotFound)?;
    tokio::task::spawn_blocking(move || sessions::list_sessions(&project, query.as_deref()))
        .await
        .map_err(|error| AppError::Message(format!("Session scan failed: {error}")))?
}

#[tauri::command]
pub async fn open_session(
    project_id: String,
    session_path: PathBuf,
    state: State<'_, AppState>,
) -> AppResult<()> {
    state.manager.open_session(&project_id, &session_path).await
}

#[tauri::command]
pub async fn new_session(project_id: String, state: State<'_, AppState>) -> AppResult<()> {
    state.manager.new_session(&project_id).await
}

#[tauri::command]
pub async fn rename_session(
    project_id: String,
    name: String,
    state: State<'_, AppState>,
) -> AppResult<()> {
    state.manager.rename_session(&project_id, name).await
}

#[tauri::command]
pub async fn trash_session(
    project_id: String,
    session_path: PathBuf,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let project = state
        .manager
        .config
        .project(&project_id)
        .ok_or(AppError::ProjectNotFound)?;
    if project.active_session.as_deref() == Some(session_path.as_path()) {
        return Err(AppError::Message(
            "Switch sessions before deleting the active session".into(),
        ));
    }
    tokio::task::spawn_blocking(move || sessions::trash_session(&project, &session_path))
        .await
        .map_err(|error| AppError::Message(format!("Unable to delete session: {error}")))?
}

#[tauri::command]
pub async fn load_session_page(
    project_id: String,
    before: Option<String>,
    limit: Option<usize>,
    state: State<'_, AppState>,
) -> AppResult<SessionPage> {
    let project = state
        .manager
        .config
        .project(&project_id)
        .ok_or(AppError::ProjectNotFound)?;
    let session = project
        .active_session
        .as_deref()
        .ok_or_else(|| AppError::Message("This session has not been written to disk yet".into()))?;
    let path = sessions::ensure_session_owned(&project, session)?;
    tokio::task::spawn_blocking(move || {
        sessions::load_message_page(&path, before.as_deref(), limit.unwrap_or(100))
    })
    .await
    .map_err(|error| AppError::Message(format!("Session page load failed: {error}")))?
}

#[tauri::command]
pub async fn send_prompt(
    project_id: String,
    text: String,
    images: Vec<PromptImage>,
    state: State<'_, AppState>,
) -> AppResult<()> {
    state
        .manager
        .send_prompt(&project_id, "prompt", text, images)
        .await
}

#[tauri::command]
pub async fn steer(
    project_id: String,
    text: String,
    images: Vec<PromptImage>,
    state: State<'_, AppState>,
) -> AppResult<()> {
    state
        .manager
        .send_prompt(&project_id, "steer", text, images)
        .await
}

#[tauri::command]
pub async fn follow_up(
    project_id: String,
    text: String,
    images: Vec<PromptImage>,
    state: State<'_, AppState>,
) -> AppResult<()> {
    state
        .manager
        .send_prompt(&project_id, "follow_up", text, images)
        .await
}

#[tauri::command]
pub async fn abort(project_id: String, state: State<'_, AppState>) -> AppResult<()> {
    state.manager.abort(&project_id).await
}

#[tauri::command]
pub async fn list_models(project_id: String, state: State<'_, AppState>) -> AppResult<Vec<Value>> {
    let response = state
        .manager
        .rpc(&project_id, command("get_available_models"))
        .await?;
    Ok(response
        .pointer("/data/models")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default())
}

#[tauri::command]
pub async fn set_model(
    project_id: String,
    provider: String,
    model_id: String,
    state: State<'_, AppState>,
) -> AppResult<()> {
    state
        .manager
        .set_model(&project_id, provider, model_id)
        .await
}

#[tauri::command]
pub async fn set_thinking_level(
    project_id: String,
    level: String,
    state: State<'_, AppState>,
) -> AppResult<()> {
    state.manager.set_thinking_level(&project_id, level).await
}

#[tauri::command]
pub async fn respond_extension_ui(
    project_id: String,
    request_id: String,
    response: Value,
    state: State<'_, AppState>,
) -> AppResult<()> {
    state
        .manager
        .respond_extension_ui(&project_id, request_id, response)
        .await
}

#[tauri::command]
pub fn list_provider_credentials(state: State<'_, AppState>) -> Vec<ProviderCredentialStatus> {
    state.manager.credentials.list_statuses()
}

#[tauri::command]
pub async fn set_provider_key(
    provider_id: String,
    secret: String,
    state: State<'_, AppState>,
) -> AppResult<Vec<ProviderCredentialStatus>> {
    state.manager.credentials.set_secret(&provider_id, secret)?;
    state.manager.restart_running_projects().await;
    Ok(state.manager.credentials.list_statuses())
}

#[tauri::command]
pub async fn delete_provider_key(
    provider_id: String,
    state: State<'_, AppState>,
) -> AppResult<Vec<ProviderCredentialStatus>> {
    state.manager.credentials.delete_secret(&provider_id)?;
    state.manager.restart_running_projects().await;
    Ok(state.manager.credentials.list_statuses())
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> AppSettings {
    state.manager.config.settings()
}

#[tauri::command]
pub async fn update_settings(
    patch: SettingsPatch,
    state: State<'_, AppState>,
) -> AppResult<AppSettings> {
    let restart_running = patch.pi_path.is_some();
    let settings = state.manager.config.update_settings(patch)?;
    if restart_running {
        state.manager.restart_running_projects().await;
    }
    Ok(settings)
}

#[tauri::command]
pub fn dismiss_notification(key: String, state: State<'_, AppState>) -> AppResult<()> {
    state.manager.config.dismiss_notification(key)
}

#[tauri::command]
pub fn open_pi_login(state: State<'_, AppState>) -> AppResult<()> {
    let pi = resolve_pi(state.manager.config.settings().pi_path)
        .ok_or_else(|| AppError::Message("Pi is not installed".into()))?;
    let working_directory = pi_agent_dir();
    #[cfg(windows)]
    {
        if let Ok(terminal) = which::which("wt.exe") {
            std::process::Command::new(terminal)
                .arg("-d")
                .arg(&working_directory)
                .arg(pi)
                .env("PI_SKIP_VERSION_CHECK", "1")
                .env("PI_TELEMETRY", "0")
                .spawn()?;
            return Ok(());
        }
        std::process::Command::new("cmd.exe")
            .arg("/D")
            .arg("/K")
            .arg(pi)
            .current_dir(working_directory)
            .env("PI_SKIP_VERSION_CHECK", "1")
            .env("PI_TELEMETRY", "0")
            .spawn()?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = (pi, working_directory);
        Err(AppError::Message(
            "External login terminal is implemented for Windows in v1".into(),
        ))
    }
}

#[tauri::command]
pub async fn list_pi_packages(
    project_id: String,
    state: State<'_, AppState>,
) -> AppResult<Vec<PiPackageRecord>> {
    state.packages.list(&project_id).await
}

#[tauri::command]
pub async fn browse_pi_package_catalog(
    query: PackageCatalogQuery,
    state: State<'_, AppState>,
) -> AppResult<PackageCatalogPage> {
    state.packages.browse_catalog(query).await
}

#[tauri::command]
pub async fn run_pi_package_operation(
    project_id: String,
    request: PackageOperationRequest,
    on_progress: Channel<PackageProgress>,
    state: State<'_, AppState>,
) -> AppResult<PackageOperationResult> {
    state
        .packages
        .run_operation(state.manager.clone(), project_id, request, on_progress)
        .await
}

#[tauri::command]
pub async fn cancel_pi_package_operation(
    operation_id: String,
    state: State<'_, AppState>,
) -> AppResult<bool> {
    Ok(state.packages.cancel(&operation_id).await)
}

#[tauri::command]
pub async fn reload_pi_resources(
    project_id: String,
    state: State<'_, AppState>,
) -> AppResult<Vec<String>> {
    state
        .packages
        .reload_resources(state.manager.clone(), &project_id)
        .await
}

#[tauri::command]
pub fn open_pi_package_config(
    project_id: String,
    scope: PackageScope,
    state: State<'_, AppState>,
) -> AppResult<()> {
    state.packages.open_config(&project_id, scope)
}

fn command(command_type: &str) -> Map<String, Value> {
    let mut value = Map::new();
    value.insert("type".into(), Value::String(command_type.to_owned()));
    value
}
