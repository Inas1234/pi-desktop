use std::{fs, path::PathBuf};

use directories::ProjectDirs;
use parking_lot::RwLock;
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    models::{AppConfig, AppSettings, ProjectRecord, SettingsPatch},
};

const MAX_DISMISSED_NOTIFICATIONS: usize = 256;
const MAX_NOTIFICATION_KEY_BYTES: usize = 96;

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

#[cfg(test)]
mod tests {
    use super::*;

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
