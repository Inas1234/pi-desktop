use std::{
    collections::{HashMap, VecDeque},
    fs::{self, File},
    io::{BufRead, BufReader, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{Arc, OnceLock},
    time::SystemTime,
};

use parking_lot::RwLock;
use serde_json::{Value, json};

use crate::{
    credentials::pi_agent_dir,
    error::{AppError, AppResult},
    models::{ProjectRecord, SessionPage, SessionSummary},
    projection,
};

const MAX_SESSION_LINE_BYTES: usize = 32 * 1024 * 1024;
const MAX_CACHED_SESSION_INDEXES: usize = 32;
static SESSION_INDEXES: OnceLock<RwLock<SessionIndexCache>> = OnceLock::new();

#[derive(Default)]
struct SessionIndexCache {
    entries: HashMap<PathBuf, Arc<SessionIndex>>,
    order: VecDeque<PathBuf>,
}

impl SessionIndexCache {
    fn get(
        &mut self,
        path: &Path,
        modified: Option<SystemTime>,
        file_size: u64,
    ) -> Option<Arc<SessionIndex>> {
        let index = self
            .entries
            .get(path)
            .filter(|index| index.modified == modified && index.file_size == file_size)
            .cloned();
        if index.is_some() {
            self.order.retain(|entry| entry != path);
            self.order.push_back(path.to_path_buf());
        } else if self.entries.contains_key(path) {
            self.remove(path);
        }
        index
    }

    fn insert(&mut self, path: PathBuf, index: Arc<SessionIndex>) {
        self.remove(&path);
        while self.entries.len() >= MAX_CACHED_SESSION_INDEXES {
            let Some(oldest) = self.order.pop_front() else {
                self.entries.clear();
                break;
            };
            self.entries.remove(&oldest);
        }
        self.order.push_back(path.clone());
        self.entries.insert(path, index);
    }

    fn remove(&mut self, path: &Path) {
        self.entries.remove(path);
        self.order.retain(|entry| entry != path);
    }
}

#[derive(Debug)]
struct IndexedEntry {
    offset: u64,
    length: usize,
    id: String,
    parent_id: Option<String>,
    is_transcript: bool,
}

#[derive(Debug)]
struct SessionIndex {
    modified: Option<SystemTime>,
    file_size: u64,
    entries: Vec<IndexedEntry>,
    active_messages: Vec<usize>,
}

pub fn list_sessions(
    project: &ProjectRecord,
    query: Option<&str>,
) -> AppResult<Vec<SessionSummary>> {
    let directory = project_session_dir(project);
    if !directory.exists() {
        return Ok(Vec::new());
    }
    let query = query.map(str::to_lowercase);
    let mut sessions = Vec::new();

    for item in fs::read_dir(directory)? {
        let item = item?;
        let path = item.path();
        if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
            continue;
        }
        if let Ok(summary) = read_summary(&path, project.active_session.as_deref()) {
            let matches = query.as_ref().is_none_or(|needle| {
                summary
                    .name
                    .as_deref()
                    .unwrap_or_default()
                    .to_lowercase()
                    .contains(needle)
                    || summary
                        .preview
                        .as_deref()
                        .unwrap_or_default()
                        .to_lowercase()
                        .contains(needle)
            });
            if matches {
                sessions.push(summary);
            }
        }
    }

    sessions.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    Ok(sessions)
}

pub fn ensure_session_owned(project: &ProjectRecord, candidate: &Path) -> AppResult<PathBuf> {
    let root = project_session_dir(project);
    let candidate = fs::canonicalize(candidate)?;
    let root = fs::canonicalize(root)?;
    if candidate.starts_with(root)
        && candidate.extension().and_then(|value| value.to_str()) == Some("jsonl")
    {
        Ok(candidate)
    } else {
        Err(AppError::Message(
            "Session path is outside this project".into(),
        ))
    }
}

pub fn trash_session(project: &ProjectRecord, candidate: &Path) -> AppResult<()> {
    let path = ensure_session_owned(project, candidate)?;
    if let Some(indexes) = SESSION_INDEXES.get() {
        indexes.write().remove(&path);
    }
    trash::delete(path).map_err(|error| {
        AppError::Message(format!("Unable to move session to Recycle Bin: {error}"))
    })
}

pub fn load_message_page(
    path: &Path,
    before: Option<&str>,
    limit: usize,
) -> AppResult<SessionPage> {
    let path = fs::canonicalize(path)?;
    let index = session_index(&path)?;
    let end = if let Some(cursor) = before {
        index
            .active_messages
            .iter()
            .position(|entry_index| index.entries[*entry_index].id == cursor)
            .ok_or_else(|| AppError::Message("The transcript cursor is no longer valid".into()))?
    } else {
        index.active_messages.len()
    };
    let start = end.saturating_sub(limit.clamp(1, 200));
    let mut file = File::open(&path)?;
    let mut messages = Vec::with_capacity(end - start);
    for entry_index in &index.active_messages[start..end] {
        let entry = &index.entries[*entry_index];
        file.seek(SeekFrom::Start(entry.offset))?;
        let mut bytes = vec![0; entry.length];
        file.read_exact(&mut bytes)?;
        while bytes
            .last()
            .is_some_and(|byte| matches!(byte, b'\n' | b'\r'))
        {
            bytes.pop();
        }
        let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
            continue;
        };
        let Some(mut message) = project_transcript_entry(&value) else {
            continue;
        };
        if let Some(object) = message.as_object_mut() {
            object
                .entry("id")
                .or_insert_with(|| Value::String(entry.id.clone()));
        }
        projection::project_message(&mut message);
        messages.push(message);
    }
    let has_older = start > 0;
    let cursor = has_older.then(|| index.entries[index.active_messages[start]].id.clone());
    Ok(SessionPage {
        messages,
        cursor,
        has_older,
    })
}

fn session_index(path: &Path) -> AppResult<Arc<SessionIndex>> {
    let metadata = fs::metadata(path)?;
    let modified = metadata.modified().ok();
    let file_size = metadata.len();
    let indexes = SESSION_INDEXES.get_or_init(|| RwLock::new(SessionIndexCache::default()));
    if let Some(index) = indexes.write().get(path, modified, file_size) {
        return Ok(index);
    }

    let index = Arc::new(build_index(path, modified, file_size)?);
    indexes.write().insert(path.to_path_buf(), index.clone());
    Ok(index)
}

fn build_index(
    path: &Path,
    modified: Option<SystemTime>,
    file_size: u64,
) -> AppResult<SessionIndex> {
    build_index_with_limit(path, modified, file_size, MAX_SESSION_LINE_BYTES)
}

fn build_index_with_limit(
    path: &Path,
    modified: Option<SystemTime>,
    file_size: u64,
    max_line_bytes: usize,
) -> AppResult<SessionIndex> {
    let mut reader = BufReader::new(File::open(path)?);
    let mut bytes = Vec::new();
    let mut entries = Vec::new();
    let mut leaf_id = None;

    loop {
        let offset = reader.stream_position()?;
        bytes.clear();
        let mut limited = Read::take(&mut reader, (max_line_bytes + 1) as u64);
        let length = limited.read_until(b'\n', &mut bytes)?;
        if length == 0 {
            break;
        }
        if length > max_line_bytes {
            return Err(AppError::Message(
                "Session contains an oversized record".into(),
            ));
        }
        let mut trimmed = bytes.as_slice();
        if let Some(value) = trimmed.strip_suffix(b"\n") {
            trimmed = value;
        }
        if let Some(value) = trimmed.strip_suffix(b"\r") {
            trimmed = value;
        }
        let Ok(value) = serde_json::from_slice::<Value>(trimmed) else {
            continue;
        };
        if value.get("parentId").is_none() {
            continue;
        }
        let Some(id) = value.get("id").and_then(Value::as_str) else {
            continue;
        };
        let id = id.to_owned();
        leaf_id = Some(id.clone());
        entries.push(IndexedEntry {
            offset,
            length,
            id,
            parent_id: value
                .get("parentId")
                .and_then(Value::as_str)
                .map(str::to_owned),
            is_transcript: is_transcript_entry(&value),
        });
    }

    let by_id = entries
        .iter()
        .enumerate()
        .map(|(index, entry)| (entry.id.as_str(), index))
        .collect::<HashMap<_, _>>();
    let mut active_messages = Vec::new();
    let mut current = leaf_id.as_deref();
    let mut visited = 0usize;
    while let Some(id) = current {
        let Some(entry_index) = by_id.get(id).copied() else {
            break;
        };
        let entry = &entries[entry_index];
        if entry.is_transcript {
            active_messages.push(entry_index);
        }
        current = entry.parent_id.as_deref();
        visited += 1;
        if visited > entries.len() {
            return Err(AppError::Message("Session contains a parent cycle".into()));
        }
    }
    active_messages.reverse();

    Ok(SessionIndex {
        modified,
        file_size,
        entries,
        active_messages,
    })
}

fn is_transcript_entry(value: &Value) -> bool {
    match value.get("type").and_then(Value::as_str) {
        Some("message" | "branch_summary" | "compaction") => true,
        Some("custom_message") => value.get("display").and_then(Value::as_bool) == Some(true),
        _ => false,
    }
}

fn project_transcript_entry(value: &Value) -> Option<Value> {
    match value.get("type").and_then(Value::as_str)? {
        "message" => value.get("message").cloned(),
        "custom_message" if value.get("display").and_then(Value::as_bool) == Some(true) => {
            Some(json!({
                "role": "custom",
                "customType": value.get("customType").and_then(Value::as_str).unwrap_or("extension"),
                "content": value.get("content").cloned().unwrap_or(Value::Array(Vec::new())),
                "details": value.get("details").cloned(),
                "display": true,
                "timestamp": value.get("timestamp").cloned(),
            }))
        }
        "branch_summary" => Some(json!({
            "role": "branchSummary",
            "summary": value.get("summary").and_then(Value::as_str).unwrap_or_default(),
            "fromId": value.get("fromId").cloned(),
            "timestamp": value.get("timestamp").cloned(),
        })),
        "compaction" => Some(json!({
            "role": "compactionSummary",
            "summary": value.get("summary").and_then(Value::as_str).unwrap_or_default(),
            "tokensBefore": value.get("tokensBefore").cloned(),
            "timestamp": value.get("timestamp").cloned(),
        })),
        _ => None,
    }
}

pub fn project_session_dir(project: &ProjectRecord) -> PathBuf {
    resolve_project_session_dir(
        configured_session_dir(project),
        pi_agent_dir(),
        &project.path,
    )
}

fn resolve_project_session_dir(
    configured: Option<PathBuf>,
    agent_dir: PathBuf,
    project_path: &Path,
) -> PathBuf {
    configured.unwrap_or_else(|| {
        agent_dir
            .join("sessions")
            .join(encode_project_path(project_path))
    })
}

fn configured_session_dir(project: &ProjectRecord) -> Option<PathBuf> {
    if let Some(value) = std::env::var_os("PI_CODING_AGENT_SESSION_DIR") {
        return Some(expand_home(PathBuf::from(value)));
    }

    if project.trusted {
        let local_dir = project.path.join(".pi");
        if let Some(path) = session_dir_from_settings(&local_dir.join("settings.json"), &local_dir)
        {
            return Some(path);
        }
    }

    let agent_dir = pi_agent_dir();
    session_dir_from_settings(&agent_dir.join("settings.json"), &agent_dir)
}

fn session_dir_from_settings(path: &Path, relative_to: &Path) -> Option<PathBuf> {
    let value: Value = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    let configured = value.get("sessionDir")?.as_str()?;
    let path = expand_home(PathBuf::from(configured));
    Some(if path.is_absolute() {
        path
    } else {
        relative_to.join(path)
    })
}

fn expand_home(path: PathBuf) -> PathBuf {
    let raw = path.to_string_lossy();
    if (raw == "~" || raw.starts_with("~/") || raw.starts_with("~\\"))
        && let Some(user_dirs) = directories::UserDirs::new()
    {
        return user_dirs
            .home_dir()
            .join(raw.trim_start_matches('~').trim_start_matches(['/', '\\']));
    }
    path
}

fn encode_project_path(path: &Path) -> String {
    let raw = path.to_string_lossy();
    let resolved = if let Some(path) = raw.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{path}")
    } else if let Some(path) = raw.strip_prefix(r"\\?\") {
        path.to_owned()
    } else {
        raw.into_owned()
    };
    let resolved = resolved
        .strip_prefix(['/', '\\'])
        .unwrap_or(resolved.as_str());
    let encoded = resolved
        .chars()
        .map(|character| match character {
            ':' | '/' | '\\' => '-',
            value => value,
        })
        .collect::<String>();
    format!("--{encoded}--")
}

fn read_summary(path: &Path, active_session: Option<&Path>) -> AppResult<SessionSummary> {
    let file = File::open(path)?;
    let metadata = file.metadata()?;
    let mut reader = BufReader::new(file);
    let mut buffer = Vec::new();
    let mut id = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_owned();
    let mut name = None;
    let mut preview = None;
    let mut message_count = 0usize;
    let mut updated_at = metadata
        .modified()
        .ok()
        .map(chrono::DateTime::<chrono::Utc>::from)
        .map(|value| value.to_rfc3339())
        .unwrap_or_default();

    loop {
        buffer.clear();
        let count = reader.read_until(b'\n', &mut buffer)?;
        if count == 0 {
            break;
        }
        if buffer.len() > MAX_SESSION_LINE_BYTES {
            return Err(AppError::Message(
                "Session contains an oversized record".into(),
            ));
        }
        if buffer.ends_with(b"\n") {
            buffer.pop();
        }
        if buffer.ends_with(b"\r") {
            buffer.pop();
        }
        let Ok(value) = serde_json::from_slice::<Value>(&buffer) else {
            continue;
        };
        if let Some(timestamp) = value.get("timestamp").and_then(Value::as_str) {
            updated_at = timestamp.to_owned();
        }
        match value.get("type").and_then(Value::as_str) {
            Some("session") => {
                if let Some(session_id) = value.get("id").and_then(Value::as_str) {
                    id = session_id.to_owned();
                }
            }
            Some("session_info") => {
                name = value
                    .get("name")
                    .or_else(|| value.get("data").and_then(|data| data.get("name")))
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .or(name);
            }
            Some("message") => {
                message_count += 1;
                if preview.is_none()
                    && value
                        .get("message")
                        .and_then(|message| message.get("role"))
                        .and_then(Value::as_str)
                        == Some("user")
                {
                    preview = value
                        .get("message")
                        .and_then(|message| message.get("content"))
                        .and_then(extract_text)
                        .map(|text| truncate(&text, 120));
                }
            }
            _ => {}
        }
    }

    let is_active = active_session.is_some_and(|active| same_path(active, path));
    Ok(SessionSummary {
        id,
        path: path.to_path_buf(),
        name,
        preview,
        message_count,
        updated_at,
        is_active,
    })
}

fn extract_text(content: &Value) -> Option<String> {
    if let Some(text) = content.as_str() {
        return Some(text.to_owned());
    }
    content.as_array().map(|parts| {
        parts
            .iter()
            .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n")
    })
}

fn truncate(value: &str, max_chars: usize) -> String {
    let mut chars = value.chars();
    let truncated = chars.by_ref().take(max_chars).collect::<String>();
    if chars.next().is_some() {
        format!("{truncated}…")
    } else {
        truncated
    }
}

fn same_path(left: &Path, right: &Path) -> bool {
    match (fs::canonicalize(left), fs::canonicalize(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => left == right,
    }
}

#[cfg(test)]
mod tests {
    use std::{
        io::Write,
        path::{Path, PathBuf},
        sync::Arc,
    };

    use tempfile::NamedTempFile;

    use super::{
        MAX_CACHED_SESSION_INDEXES, SessionIndex, SessionIndexCache, build_index_with_limit,
        encode_project_path, load_message_page, read_summary, resolve_project_session_dir,
    };

    #[test]
    fn session_index_cache_evicts_the_oldest_entry() {
        let mut cache = SessionIndexCache::default();
        for index in 0..=MAX_CACHED_SESSION_INDEXES {
            cache.insert(
                PathBuf::from(format!("session-{index}.jsonl")),
                Arc::new(SessionIndex {
                    modified: None,
                    file_size: index as u64,
                    entries: Vec::new(),
                    active_messages: Vec::new(),
                }),
            );
        }

        assert_eq!(cache.entries.len(), MAX_CACHED_SESSION_INDEXES);
        assert!(!cache.entries.contains_key(Path::new("session-0.jsonl")));
        assert!(cache.entries.contains_key(Path::new(&format!(
            "session-{MAX_CACHED_SESSION_INDEXES}.jsonl"
        ))));
    }

    #[test]
    fn rejects_oversized_session_records_before_reading_the_remainder() {
        let mut file = NamedTempFile::new().unwrap();
        write!(file, "{}", "x".repeat(32)).unwrap();
        let result = build_index_with_limit(file.path(), None, 32, 16);
        assert!(result.is_err());
    }

    #[test]
    fn matches_pi_project_path_encoding_for_windows_verbatim_paths() {
        assert_eq!(
            encode_project_path(Path::new(r"\\?\D:\Programing\Web\pi-desktop")),
            "--D--Programing-Web-pi-desktop--"
        );
        assert_eq!(
            encode_project_path(Path::new("/home/pi/project")),
            "--home-pi-project--"
        );
    }

    #[test]
    fn uses_configured_session_directory_without_project_nesting() {
        let configured = Path::new("custom-sessions").to_path_buf();
        let resolved = resolve_project_session_dir(
            Some(configured.clone()),
            Path::new("agent").to_path_buf(),
            Path::new("project"),
        );
        assert_eq!(resolved, configured);
    }

    #[test]
    fn reads_tolerant_session_metadata() {
        let mut file = NamedTempFile::new().unwrap();
        writeln!(
            file,
            r#"{{"type":"session","id":"session-1","timestamp":"2026-01-01T00:00:00Z"}}"#
        )
        .unwrap();
        writeln!(file, r#"{{"type":"unknown_future_entry","value":1}}"#).unwrap();
        writeln!(file, r#"{{"type":"message","timestamp":"2026-01-02T00:00:00Z","message":{{"role":"user","content":"Build the app"}}}}"#).unwrap();

        let summary = read_summary(file.path(), None).unwrap();
        assert_eq!(summary.id, "session-1");
        assert_eq!(summary.preview.as_deref(), Some("Build the app"));
        assert_eq!(summary.message_count, 1);
    }

    #[test]
    fn pages_only_the_active_session_branch() {
        let mut file = NamedTempFile::new().unwrap();
        writeln!(file, r#"{{"type":"session","id":"session-1"}}"#).unwrap();
        writeln!(file, r#"{{"type":"message","id":"a","parentId":null,"message":{{"role":"user","content":"one"}}}}"#).unwrap();
        writeln!(file, r#"{{"type":"message","id":"b","parentId":"a","message":{{"role":"assistant","content":"two"}}}}"#).unwrap();
        writeln!(file, r#"{{"type":"message","id":"branch","parentId":"a","message":{{"role":"assistant","content":"branch"}}}}"#).unwrap();

        let page = load_message_page(file.path(), None, 1).unwrap();
        assert_eq!(page.messages.len(), 1);
        assert_eq!(page.messages[0]["id"], "branch");
        assert!(page.has_older);

        let older = load_message_page(file.path(), page.cursor.as_deref(), 10).unwrap();
        assert_eq!(older.messages.len(), 1);
        assert_eq!(older.messages[0]["id"], "a");
        assert!(!older.has_older);
    }

    #[test]
    fn pages_displayable_custom_messages_but_hides_state_only_entries() {
        let mut visible = NamedTempFile::new().unwrap();
        writeln!(visible, r#"{{"type":"session","id":"session-1"}}"#).unwrap();
        writeln!(visible, r#"{{"type":"message","id":"a","parentId":null,"message":{{"role":"user","content":"one"}}}}"#).unwrap();
        writeln!(visible, r#"{{"type":"custom_message","id":"custom","parentId":"a","customType":"subagents","content":"two complete","display":true,"details":{{"count":2}}}}"#).unwrap();

        let page = load_message_page(visible.path(), None, 10).unwrap();
        assert_eq!(page.messages.len(), 2);
        assert_eq!(page.messages[1]["role"], "custom");
        assert_eq!(page.messages[1]["customType"], "subagents");
        assert_eq!(page.messages[1]["details"]["count"], 2);

        let mut hidden = NamedTempFile::new().unwrap();
        writeln!(hidden, r#"{{"type":"session","id":"session-2"}}"#).unwrap();
        writeln!(hidden, r#"{{"type":"message","id":"a","parentId":null,"message":{{"role":"user","content":"one"}}}}"#).unwrap();
        writeln!(hidden, r#"{{"type":"custom_message","id":"state","parentId":"a","customType":"state","content":"hidden","display":false}}"#).unwrap();

        let page = load_message_page(hidden.path(), None, 10).unwrap();
        assert_eq!(page.messages.len(), 1);
        assert_eq!(page.messages[0]["role"], "user");
    }
}
