use std::{fs, path::PathBuf};

use directories::ProjectDirs;
use parking_lot::RwLock;
use serde_json::{Map, Value};
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    models::{AppConfig, AppSettings, ProjectRecord, SettingsPatch},
};

const MAX_DISMISSED_NOTIFICATIONS: usize = 256;
const MAX_NOTIFICATION_KEY_BYTES: usize = 96;
const MAX_CACHED_COMMANDS_PER_PROJECT: usize = 256;
const MAX_CACHED_SESSIONS_PER_PROJECT: usize = 200;

pub struct ConfigStore {
    path: PathBuf,
    config: RwLock<AppConfig>,
    startup_warning: Option<String>,
}

impl ConfigStore {
    pub fn load() -> Self {
        let path = std::env::var_os("PI_DESKTOP_CONFIG_DIR")
            .map(PathBuf::from)
            .map(|directory| directory.join("config.json"))
            .or_else(|| {
                ProjectDirs::from("dev", "pi", "Pi Desktop")
                    .map(|dirs| dirs.config_dir().join("config.json"))
            })
            .unwrap_or_else(|| std::env::temp_dir().join("Pi Desktop").join("config.json"));
        match Self::load_at(path.clone()) {
            Ok(store) => store,
            Err(error) => Self {
                path,
                config: RwLock::new(AppConfig::default()),
                startup_warning: Some(format!(
                    "Pi Desktop could not load its settings ({error}). Defaults are active, but changes may not persist."
                )),
            },
        }
    }

    fn load_at(path: PathBuf) -> AppResult<Self> {
        let parent = path
            .parent()
            .ok_or_else(|| AppError::Message("Invalid config path".into()))?;
        fs::create_dir_all(parent)?;
        let mut startup_warning = None;
        let mut config = if path.exists() {
            let bytes = fs::read(&path)?;
            match serde_json::from_slice(&bytes) {
                Ok(config) => config,
                Err(error) => {
                    let backup = path
                        .with_file_name(format!("config.invalid-{}.json", Uuid::new_v4().simple()));
                    fs::rename(&path, &backup)?;
                    startup_warning = Some(format!(
                        "Pi Desktop recovered from invalid settings ({error}). The original file was preserved at {}.",
                        backup.display()
                    ));
                    AppConfig::default()
                }
            }
        } else {
            AppConfig::default()
        };
        config
            .dismissed_notification_keys
            .retain(|key| !key.is_empty() && key.len() <= MAX_NOTIFICATION_KEY_BYTES);
        let overflow = config
            .dismissed_notification_keys
            .len()
            .saturating_sub(MAX_DISMISSED_NOTIFICATIONS);
        if overflow > 0 {
            config.dismissed_notification_keys.drain(..overflow);
        }
        let project_ids = config
            .projects
            .iter()
            .map(|project| project.id.as_str())
            .collect::<std::collections::HashSet<_>>();
        config
            .cached_command_catalogs
            .retain(|project_id, _| project_ids.contains(project_id.as_str()));
        for commands in config.cached_command_catalogs.values_mut() {
            *commands = bounded_command_catalog(commands);
        }
        config
            .cached_session_summaries
            .retain(|project_id, _| project_ids.contains(project_id.as_str()));
        for sessions in config.cached_session_summaries.values_mut() {
            *sessions = bounded_session_summaries(std::mem::take(sessions));
        }

        Ok(Self {
            path,
            config: RwLock::new(config),
            startup_warning,
        })
    }

    #[cfg(test)]
    pub fn for_test(path: PathBuf, config: AppConfig) -> Self {
        Self {
            path,
            config: RwLock::new(config),
            startup_warning: None,
        }
    }

    pub fn startup_warning(&self) -> Option<String> {
        self.startup_warning.clone()
    }

    pub fn snapshot(&self) -> AppConfig {
        self.config.read().clone()
    }

    pub fn settings(&self) -> AppSettings {
        self.config.read().settings.clone()
    }

    pub fn project(&self, project_id: &str) -> Option<ProjectRecord> {
        self.config
            .read()
            .projects
            .iter()
            .find(|project| project.id == project_id)
            .cloned()
    }

    pub fn cached_command_catalog(&self, project_id: &str) -> Option<Vec<Value>> {
        self.config
            .read()
            .cached_command_catalogs
            .get(project_id)
            .cloned()
    }

    pub fn mutate<T>(&self, update: impl FnOnce(&mut AppConfig) -> AppResult<T>) -> AppResult<T> {
        let mut guard = self.config.write();
        let mut next = guard.clone();
        let result = update(&mut next)?;
        self.persist(&next)?;
        *guard = next;
        Ok(result)
    }

    pub fn update_settings(&self, patch: SettingsPatch) -> AppResult<AppSettings> {
        self.mutate(|config| {
            if let Some(theme) = patch.theme {
                if !matches!(theme.as_str(), "system" | "light" | "dark") {
                    return Err(AppError::Message(
                        "Theme must be system, light, or dark".into(),
                    ));
                }
                config.settings.theme = theme;
            }
            if let Some(minutes) = patch.idle_timeout_minutes {
                config.settings.idle_timeout_minutes = minutes.clamp(1, 240);
            }
            if let Some(collapsed) = patch.sidebar_collapsed {
                config.settings.sidebar_collapsed = collapsed;
            }
            if let Some(path) = patch.pi_path {
                config.settings.pi_path = path;
            }
            if let Some(project_id) = patch.active_project_id {
                config.settings.active_project_id = project_id;
            }
            if let Some(show) = patch.show_reasoning {
                config.settings.show_reasoning = show;
            }
            Ok(config.settings.clone())
        })
    }

    pub fn dismiss_notification(&self, key: String) -> AppResult<()> {
        if key.is_empty() || key.len() > MAX_NOTIFICATION_KEY_BYTES {
            return Err(AppError::Message("Invalid notification key".into()));
        }
        self.mutate(|config| {
            config
                .dismissed_notification_keys
                .retain(|existing| existing != &key);
            config.dismissed_notification_keys.push(key);
            let overflow = config
                .dismissed_notification_keys
                .len()
                .saturating_sub(MAX_DISMISSED_NOTIFICATIONS);
            if overflow > 0 {
                config.dismissed_notification_keys.drain(..overflow);
            }
            Ok(())
        })
    }

    pub fn cache_command_catalog(&self, project_id: &str, commands: &[Value]) {
        let commands = bounded_command_catalog(commands);
        if self.config.read().cached_command_catalogs.get(project_id) == Some(&commands) {
            return;
        }
        let _ = self.mutate(|config| {
            config
                .cached_command_catalogs
                .insert(project_id.to_owned(), commands);
            Ok(())
        });
    }

    pub fn cache_session_summaries(
        &self,
        project_id: &str,
        sessions: Vec<crate::models::SessionSummary>,
    ) {
        let sessions = bounded_session_summaries(sessions);
        if self.config.read().cached_session_summaries.get(project_id) == Some(&sessions) {
            return;
        }
        let _ = self.mutate(|config| {
            config
                .cached_session_summaries
                .insert(project_id.to_owned(), sessions);
            Ok(())
        });
    }

    fn persist(&self, config: &AppConfig) -> AppResult<()> {
        let parent = self
            .path
            .parent()
            .ok_or_else(|| AppError::Message("Invalid config path".into()))?;
        let mut temp = tempfile::NamedTempFile::new_in(parent)?;
        serde_json::to_writer_pretty(temp.as_file_mut(), config)?;
        temp.as_file_mut().sync_all()?;
        temp.persist(&self.path)
            .map_err(|error| AppError::Io(error.error))?;
        Ok(())
    }
}

pub fn bounded_command_catalog(commands: &[Value]) -> Vec<Value> {
    commands
        .iter()
        .filter_map(|command| {
            let source = command.as_object()?;
            let name = bounded_string(source.get("name")?, 128)?;
            if name.trim().is_empty() {
                return None;
            }
            let mut cached = Map::new();
            cached.insert("name".into(), Value::String(name));
            for (key, limit) in [
                ("description", 4_096),
                ("source", 64),
                ("argumentHint", 512),
                ("invocation", 64),
            ] {
                if let Some(value) = source
                    .get(key)
                    .and_then(|value| bounded_string(value, limit))
                {
                    cached.insert(key.into(), Value::String(value));
                }
            }
            Some(Value::Object(cached))
        })
        .take(MAX_CACHED_COMMANDS_PER_PROJECT)
        .collect()
}

fn bounded_string(value: &Value, max_chars: usize) -> Option<String> {
    let value = value.as_str()?;
    Some(value.chars().take(max_chars).collect())
}

fn bounded_session_summaries(
    sessions: Vec<crate::models::SessionSummary>,
) -> Vec<crate::models::SessionSummary> {
    sessions
        .into_iter()
        .filter(|session| session.path.to_string_lossy().chars().count() <= 32_768)
        .map(|mut session| {
            session.id = truncate_string(session.id, 256);
            session.name = session.name.map(|value| truncate_string(value, 256));
            session.preview = session.preview.map(|value| truncate_string(value, 256));
            session.updated_at = truncate_string(session.updated_at, 64);
            session
        })
        .take(MAX_CACHED_SESSIONS_PER_PROJECT)
        .collect()
}

fn truncate_string(value: String, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_cache_keeps_only_bounded_frontend_metadata() {
        let commands = vec![serde_json::json!({
            "name": "review",
            "description": "Review the project",
            "source": "prompt",
            "secretFutureField": "do not persist"
        })];

        assert_eq!(
            bounded_command_catalog(&commands),
            vec![serde_json::json!({
                "name": "review",
                "description": "Review the project",
                "source": "prompt"
            })]
        );
    }

    #[test]
    fn dismissed_notifications_are_deduplicated_bounded_and_persisted() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("config.json");
        let existing = (0..MAX_DISMISSED_NOTIFICATIONS)
            .map(|index| format!("key-{index}"))
            .collect();
        let store = ConfigStore::for_test(
            path.clone(),
            AppConfig {
                dismissed_notification_keys: existing,
                ..AppConfig::default()
            },
        );

        store.dismiss_notification("key-0".into()).unwrap();
        store.dismiss_notification("new-key".into()).unwrap();

        let snapshot = store.snapshot();
        let keys = &snapshot.dismissed_notification_keys;
        assert_eq!(keys.len(), MAX_DISMISSED_NOTIFICATIONS);
        assert!(!keys.contains(&"key-1".to_owned()));
        assert_eq!(keys.iter().filter(|key| key.as_str() == "key-0").count(), 1);
        assert_eq!(keys.last().map(String::as_str), Some("new-key"));

        let persisted: AppConfig = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        assert_eq!(persisted.dismissed_notification_keys, *keys);
    }

    #[test]
    fn older_configs_default_to_no_dismissed_notifications() {
        let config: AppConfig = serde_json::from_str(r#"{"projects": []}"#).unwrap();
        assert!(config.dismissed_notification_keys.is_empty());
        assert!(config.cached_command_catalogs.is_empty());
        assert!(config.cached_session_summaries.is_empty());
    }

    #[test]
    fn recovers_from_invalid_config_and_preserves_the_original() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("config.json");
        fs::write(&path, b"{invalid json").unwrap();

        let store = ConfigStore::load_at(path.clone()).unwrap();

        assert!(store.snapshot().projects.is_empty());
        assert!(store.startup_warning().is_some());
        assert!(!path.exists());
        let backups = fs::read_dir(directory.path())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("config.invalid-")
            })
            .count();
        assert_eq!(backups, 1);
    }

    #[test]
    fn does_not_commit_in_memory_changes_when_persistence_fails() {
        let directory = tempfile::tempdir().unwrap();
        let store = ConfigStore::for_test(
            directory.path().join("missing").join("config.json"),
            AppConfig::default(),
        );

        let result = store.update_settings(SettingsPatch {
            theme: Some("light".into()),
            idle_timeout_minutes: None,
            sidebar_collapsed: None,
            pi_path: None,
            active_project_id: None,
            show_reasoning: None,
        });

        assert!(result.is_err());
        assert_eq!(store.settings().theme, "system");
    }
}
