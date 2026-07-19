use std::{fs, path::PathBuf};

use directories::ProjectDirs;
use parking_lot::RwLock;

use crate::{
    error::{AppError, AppResult},
    models::{AppConfig, AppSettings, ProjectRecord, SettingsPatch},
};

const MAX_DISMISSED_NOTIFICATIONS: usize = 256;
const MAX_NOTIFICATION_KEY_BYTES: usize = 96;

pub struct ConfigStore {
    path: PathBuf,
    config: RwLock<AppConfig>,
}

impl ConfigStore {
    pub fn load() -> AppResult<Self> {
        let dirs = ProjectDirs::from("dev", "pi", "Pi Desktop").ok_or_else(|| {
            AppError::Message("Unable to resolve the app config directory".into())
        })?;
        let dir = dirs.config_dir();
        fs::create_dir_all(dir)?;
        let path = dir.join("config.json");
        let mut config = if path.exists() {
            serde_json::from_slice(&fs::read(&path)?)?
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
        })
    }

    #[cfg(test)]
    pub fn for_test(path: PathBuf, config: AppConfig) -> Self {
        Self {
            path,
            config: RwLock::new(config),
        }
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
        let result = update(&mut guard)?;
        self.persist(&guard)?;
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
}
