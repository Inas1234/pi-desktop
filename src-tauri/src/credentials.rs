use std::{collections::HashMap, fs, path::PathBuf};

use keyring::Entry;
use zeroize::{Zeroize, Zeroizing};

use crate::{
    error::{AppError, AppResult},
    models::ProviderCredentialStatus,
    providers::simple_key_providers,
};

const SERVICE: &str = "Pi Desktop";

#[derive(Default)]
pub struct CredentialStore;

impl CredentialStore {
    pub fn list_statuses(&self) -> Vec<ProviderCredentialStatus> {
        let pi_auth = pi_auth_provider_ids();
        simple_key_providers()
            .into_iter()
            .map(|provider| {
                let configured_in_app = self.has_secret(provider.id);
                let configured_in_pi = pi_auth.contains_key(provider.id);
                let effective_source = if configured_in_pi {
                    "pi".to_owned()
                } else if configured_in_app {
                    "app".to_owned()
                } else if std::env::var_os(provider.environment_variable).is_some() {
                    "environment".to_owned()
                } else {
                    "none".to_owned()
                };
                ProviderCredentialStatus {
                    id: provider.id.to_owned(),
                    name: provider.name.to_owned(),
                    environment_variable: provider.environment_variable.to_owned(),
                    configured_in_app,
                    configured_in_pi,
                    effective_source,
                }
            })
            .collect()
    }

    pub fn set_secret(&self, provider_id: &str, mut secret: String) -> AppResult<()> {
        if secret.trim().is_empty() || !is_known_provider(provider_id) {
            secret.zeroize();
            return Err(AppError::Message(
                "A valid provider and key are required".into(),
            ));
        }
        let entry = Entry::new(SERVICE, provider_id).map_err(|_| AppError::Credential)?;
        let result = entry
            .set_password(secret.trim())
            .map_err(|_| AppError::Credential);
        secret.zeroize();
        result
    }

    pub fn delete_secret(&self, provider_id: &str) -> AppResult<()> {
        if !is_known_provider(provider_id) {
            return Err(AppError::Message("Unknown provider".into()));
        }
        let entry = Entry::new(SERVICE, provider_id).map_err(|_| AppError::Credential)?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(AppError::Credential),
        }
    }

    pub fn environment(&self) -> HashMap<String, Zeroizing<String>> {
        simple_key_providers()
            .into_iter()
            .filter_map(|provider| {
                let value = self.get_secret(provider.id)?;
                Some((provider.environment_variable.to_owned(), value))
            })
            .collect()
    }

    fn has_secret(&self, provider_id: &str) -> bool {
        self.get_secret(provider_id).is_some()
    }

    fn get_secret(&self, provider_id: &str) -> Option<Zeroizing<String>> {
        Entry::new(SERVICE, provider_id)
            .ok()?
            .get_password()
            .ok()
            .map(Zeroizing::new)
    }
}

fn is_known_provider(provider_id: &str) -> bool {
    simple_key_providers()
        .iter()
        .any(|provider| provider.id == provider_id)
}

fn pi_auth_provider_ids() -> HashMap<String, ()> {
    let path = pi_agent_dir().join("auth.json");
    let Ok(bytes) = fs::read(path) else {
        return HashMap::new();
    };
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return HashMap::new();
    };
    value
        .as_object()
        .map(|object| object.keys().map(|key| (key.clone(), ())).collect())
        .unwrap_or_default()
}

pub fn pi_agent_dir() -> PathBuf {
    if let Some(path) = std::env::var_os("PI_CODING_AGENT_DIR") {
        return PathBuf::from(path);
    }
    directories::UserDirs::new()
        .map(|dirs| dirs.home_dir().join(".pi").join("agent"))
        .unwrap_or_else(|| PathBuf::from(".pi").join("agent"))
}
