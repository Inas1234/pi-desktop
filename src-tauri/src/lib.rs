#![cfg_attr(not(feature = "desktop"), allow(dead_code))]

mod commands;
mod config;
mod credentials;
mod diagnostics;
mod error;
mod manager;
mod models;
mod providers;
mod sessions;
mod windows_job;

#[cfg(feature = "desktop")]
use std::sync::Arc;

#[cfg(feature = "desktop")]
use commands::AppState;
#[cfg(feature = "desktop")]
use config::ConfigStore;
#[cfg(feature = "desktop")]
use credentials::CredentialStore;
#[cfg(feature = "desktop")]
use manager::ProjectManager;

#[cfg(feature = "desktop")]
pub fn run() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .with_target(false)
        .try_init();

    let config = Arc::new(ConfigStore::load().expect("unable to load Pi Desktop configuration"));
    let credentials = Arc::new(CredentialStore);
    let manager = ProjectManager::new(config, credentials);
    let setup_manager = manager.clone();
    let shutdown_manager = manager.clone();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(AppState { manager })
        .setup(move |_| {
            setup_manager.start_idle_reaper();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::initialize,
            commands::diagnose_pi,
            commands::add_project,
            commands::remove_project,
            commands::update_project_trust,
            commands::activate_project,
            commands::restart_project,
            commands::stop_project,
            commands::list_sessions,
            commands::open_session,
            commands::new_session,
            commands::rename_session,
            commands::trash_session,
            commands::load_session_page,
            commands::send_prompt,
            commands::steer,
            commands::follow_up,
            commands::abort,
            commands::list_models,
            commands::set_model,
            commands::set_thinking_level,
            commands::respond_extension_ui,
            commands::list_provider_credentials,
            commands::set_provider_key,
            commands::delete_provider_key,
            commands::get_settings,
            commands::update_settings,
            commands::open_pi_login,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Pi Desktop");

    app.run(move |_handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            tauri::async_runtime::block_on(shutdown_manager.shutdown_all());
        }
    });
}
