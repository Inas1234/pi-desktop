use std::{fs, path::PathBuf};

use directories::ProjectDirs;
use parking_lot::RwLock;

use crate::{
    error::{AppError, AppResult},
    models::{AppConfig, AppSettings, ProjectRecord, SettingsPatch},
};

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
        let config = if path.exists() {
            serde_json::from_slice(&fs::read(&path)?)?
        } else {
            AppConfig::default()
        };

        Ok(Self {
            path,
            config: RwLock::new(config),
        })
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
