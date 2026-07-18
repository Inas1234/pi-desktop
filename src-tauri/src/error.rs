use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    Message(String),
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Invalid data: {0}")]
    Json(#[from] serde_json::Error),
    #[error("Pi command timed out")]
    Timeout,
    #[error("Pi is not running for this project")]
    PiNotRunning,
    #[error("Project was not found")]
    ProjectNotFound,
    #[error("Credential operation failed")]
    Credential,
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

impl From<&str> for AppError {
    fn from(value: &str) -> Self {
        Self::Message(value.to_owned())
    }
}

impl From<String> for AppError {
    fn from(value: String) -> Self {
        Self::Message(value)
    }
}

pub type AppResult<T> = Result<T, AppError>;
