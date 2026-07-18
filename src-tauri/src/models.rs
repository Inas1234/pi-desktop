use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRecord {
    pub id: String,
    pub name: String,
    pub path: PathBuf,
    pub trusted: bool,
    pub active_session: Option<PathBuf>,
    pub created_at: String,
    pub last_opened_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub theme: String,
    pub idle_timeout_minutes: u64,
    pub sidebar_collapsed: bool,
    pub pi_path: Option<PathBuf>,
    pub active_project_id: Option<String>,
    pub show_reasoning: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            theme: "system".into(),
            idle_timeout_minutes: 10,
            sidebar_collapsed: false,
            pi_path: None,
            active_project_id: None,
            show_reasoning: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    #[serde(default)]
    pub settings: AppSettings,
    #[serde(default)]
    pub projects: Vec<ProjectRecord>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiEnvironmentReport {
    pub status: String,
    pub path: Option<PathBuf>,
    pub version: Option<String>,
    pub compatible: bool,
    pub node_path: Option<PathBuf>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderDefinition {
    pub id: &'static str,
    pub name: &'static str,
    pub environment_variable: &'static str,
    pub placeholder: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCredentialStatus {
    pub id: String,
    pub name: String,
    pub environment_variable: String,
    pub configured_in_app: bool,
    pub configured_in_pi: bool,
    pub effective_source: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapState {
    pub settings: AppSettings,
    pub projects: Vec<ProjectRecord>,
    pub environment: PiEnvironmentReport,
    pub providers: Vec<ProviderCredentialStatus>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub id: String,
    pub path: PathBuf,
    pub name: Option<String>,
    pub preview: Option<String>,
    pub message_count: usize,
    pub updated_at: String,
    pub is_active: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPage {
    pub messages: Vec<Value>,
    pub cursor: Option<String>,
    pub has_older: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptImage {
    pub path: PathBuf,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppEvent {
    pub seq: u64,
    pub project_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(flatten)]
    pub event: AppEventKind,
}

#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum AppEventKind {
    Connection {
        state: String,
        message: Option<String>,
    },
    Snapshot {
        state: Value,
        messages: Vec<Value>,
        models: Vec<Value>,
        commands: Vec<Value>,
        stats: Value,
        history_cursor: Option<String>,
        has_older: bool,
    },
    PiEvent {
        event: Value,
    },
    PiEvents {
        events: Vec<Value>,
    },
    ProcessExited {
        code: Option<i32>,
        expected: bool,
    },
    ProtocolWarning {
        message: String,
    },
    #[allow(dead_code)]
    ResyncRequired {
        reason: String,
    },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPatch {
    pub theme: Option<String>,
    pub idle_timeout_minutes: Option<u64>,
    pub sidebar_collapsed: Option<bool>,
    pub pi_path: Option<Option<PathBuf>>,
    pub active_project_id: Option<Option<String>>,
    pub show_reasoning: Option<bool>,
}
