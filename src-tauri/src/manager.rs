use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use base64::Engine;
use parking_lot::{Mutex as ParkingMutex, RwLock as ParkingRwLock};
use serde_json::{Map, Value, json};
use tauri::ipc::Channel;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{Mutex, RwLock, mpsc, oneshot},
    time::{MissedTickBehavior, interval, timeout},
};
use uuid::Uuid;

use crate::{
    config::ConfigStore,
    credentials::CredentialStore,
    diagnostics::{command_for, diagnose, resolve_pi},
    error::{AppError, AppResult},
    models::{AppEvent, AppEventKind, PiEnvironmentReport, PromptImage},
    projection, sessions,
    windows_job::JobGuard,
};

const MAX_RPC_RECORD_BYTES: usize = 32 * 1024 * 1024;
const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;
const MAX_STDERR_LINES: usize = 200;
const MAX_BLOCKING_DIALOGS: usize = 16;
const RPC_TIMEOUT: Duration = Duration::from_secs(30);
const PROCESS_STOP_TIMEOUT: Duration = Duration::from_secs(15);

enum ProcessControl {
    Stop,
}

struct ProcessWaitState {
    control: mpsc::Receiver<ProcessControl>,
    termination: oneshot::Sender<()>,
    job: Option<JobGuard>,
}

struct ProjectRuntime {
    token: String,
    stdin: Mutex<ChildStdin>,
    pending: Mutex<HashMap<String, oneshot::Sender<AppResult<Value>>>>,
    control: mpsc::Sender<ProcessControl>,
    termination: Mutex<Option<oneshot::Receiver<()>>>,
    settled: AtomicBool,
    has_queue: AtomicBool,
    blocking_dialogs: ParkingMutex<HashSet<String>>,
    last_touched: AtomicU64,
    expected_exit: AtomicBool,
    stderr: Mutex<VecDeque<String>>,
}

impl ProjectRuntime {
    fn can_suspend(&self) -> bool {
        self.settled.load(Ordering::Relaxed)
            && !self.has_queue.load(Ordering::Relaxed)
            && self.blocking_dialogs.lock().is_empty()
    }

    fn touch(&self) {
        self.last_touched.store(now_millis(), Ordering::Relaxed);
    }
}

pub struct ProjectManager {
    pub config: Arc<ConfigStore>,
    pub credentials: Arc<CredentialStore>,
    runtimes: RwLock<HashMap<String, Arc<ProjectRuntime>>>,
    channel: ParkingRwLock<Option<Channel<AppEvent>>>,
    sequence: AtomicU64,
    crash_restarts: Mutex<HashMap<String, u64>>,
}

impl ProjectManager {
    pub fn new(config: Arc<ConfigStore>, credentials: Arc<CredentialStore>) -> Arc<Self> {
        Arc::new(Self {
            config,
            credentials,
            runtimes: RwLock::new(HashMap::new()),
            channel: ParkingRwLock::new(None),
            sequence: AtomicU64::new(1),
            crash_restarts: Mutex::new(HashMap::new()),
        })
    }

    pub fn set_channel(&self, channel: Channel<AppEvent>) {
        *self.channel.write() = Some(channel);
    }

    pub fn diagnose_pi(&self) -> PiEnvironmentReport {
        diagnose(self.config.settings().pi_path)
    }

    pub async fn is_running(&self, project_id: &str) -> bool {
        self.runtimes.read().await.contains_key(project_id)
    }

    pub async fn restart_running_projects(self: &Arc<Self>) {
        let ids = self
            .runtimes
            .read()
            .await
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        for id in ids {
            let _ = self.restart_project(&id).await;
        }
    }

    pub async fn quiesce_for_package_change(
        self: &Arc<Self>,
        project_id: Option<&str>,
    ) -> AppResult<Vec<String>> {
        let runtimes = self.runtimes.read().await;
        let targets = runtimes
            .iter()
            .filter(|(id, _)| project_id.is_none_or(|target| target == id.as_str()))
            .map(|(id, runtime)| (id.clone(), runtime.clone()))
            .collect::<Vec<_>>();
        let busy = targets
            .iter()
            .filter(|(_, runtime)| !runtime.can_suspend())
            .map(|(id, _)| {
                self.config
                    .project(id)
                    .map_or_else(|| id.clone(), |project| project.name)
            })
            .collect::<Vec<_>>();
        drop(runtimes);
        if !busy.is_empty() {
            return Err(AppError::Message(format!(
                "Wait for these Pi projects to settle before changing packages: {}",
                busy.join(", ")
            )));
        }
        let ids = targets.into_iter().map(|(id, _)| id).collect::<Vec<_>>();
        let mut stopped = Vec::new();
        for id in &ids {
            if let Err(error) = self.stop_project(id).await {
                let warnings = self.restore_quiesced_projects(&stopped).await;
                return Err(AppError::Message(if warnings.is_empty() {
                    format!("Unable to stop {id} before changing packages: {error}")
                } else {
                    format!(
                        "Unable to stop {id} before changing packages: {error}. {}",
                        warnings.join(" ")
                    )
                }));
            }
            stopped.push(id.clone());
        }
        Ok(stopped)
    }

    pub async fn restore_quiesced_projects(self: &Arc<Self>, ids: &[String]) -> Vec<String> {
        let mut warnings = Vec::new();
        for id in ids {
            if let Err(error) = self.start_project(id).await {
                warnings.push(format!("Unable to restart {id}: {error}"));
            }
        }
        warnings
    }

    pub async fn activate_project(self: &Arc<Self>, project_id: &str) -> AppResult<()> {
        let now = chrono::Utc::now().to_rfc3339();
        self.config.mutate(|config| {
            let project = config
                .projects
                .iter_mut()
                .find(|project| project.id == project_id)
                .ok_or(AppError::ProjectNotFound)?;
            project.last_opened_at = now;
            config.settings.active_project_id = Some(project_id.to_owned());
            Ok(())
        })?;

        if let Some(runtime) = self.runtimes.read().await.get(project_id).cloned() {
            runtime.touch();
            self.emit(
                project_id,
                None,
                AppEventKind::Connection {
                    state: "connected".into(),
                    message: None,
                },
            );
            return Ok(());
        }
        self.start_project(project_id).await
    }

    pub async fn start_project(self: &Arc<Self>, project_id: &str) -> AppResult<()> {
        if self.runtimes.read().await.contains_key(project_id) {
            return Ok(());
        }
        let project = self
            .config
            .project(project_id)
            .ok_or(AppError::ProjectNotFound)?;
        let pi_path = resolve_pi(self.config.settings().pi_path)
            .ok_or_else(|| AppError::Message("Pi is not installed or configured".into()))?;

        self.emit(
            project_id,
            None,
            AppEventKind::Connection {
                state: "connecting".into(),
                message: None,
            },
        );

        let mut base = command_for(&pi_path);
        base.current_dir(&project.path)
            .arg("--mode")
            .arg("rpc")
            .arg(if project.trusted {
                "--approve"
            } else {
                "--no-approve"
            })
            .env("PI_SKIP_VERSION_CHECK", "1")
            .env("PI_TELEMETRY", "0")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(session) = project.active_session.as_ref().filter(|path| path.exists()) {
            base.arg("--session").arg(session);
        }
        for (name, secret) in self.credentials.environment() {
            base.env(name, secret.as_str());
        }

        let mut command = Command::from(base);
        command.kill_on_drop(true);
        let mut child = command
            .spawn()
            .map_err(|error| AppError::Message(format!("Unable to start Pi: {error}")))?;
        let process_id = child
            .id()
            .ok_or_else(|| AppError::Message("Pi did not expose a process id".into()))?;
        let job = JobGuard::attach(process_id).ok();
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| AppError::Message("Pi stdin is unavailable".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AppError::Message("Pi stdout is unavailable".into()))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| AppError::Message("Pi stderr is unavailable".into()))?;
        let (control_tx, control_rx) = mpsc::channel(2);
        let (termination_tx, termination_rx) = oneshot::channel();
        let (event_tx, event_rx) = mpsc::unbounded_channel();

        let runtime = Arc::new(ProjectRuntime {
            token: Uuid::new_v4().to_string(),
            stdin: Mutex::new(stdin),
            pending: Mutex::new(HashMap::new()),
            control: control_tx,
            termination: Mutex::new(Some(termination_rx)),
            settled: AtomicBool::new(true),
            has_queue: AtomicBool::new(false),
            blocking_dialogs: ParkingMutex::new(HashSet::new()),
            last_touched: AtomicU64::new(now_millis()),
            expected_exit: AtomicBool::new(false),
            stderr: Mutex::new(VecDeque::with_capacity(MAX_STDERR_LINES)),
        });
        self.runtimes
            .write()
            .await
            .insert(project_id.to_owned(), runtime.clone());

        tokio::spawn(event_batch_loop(
            self.clone(),
            project_id.to_owned(),
            event_rx,
        ));
        tokio::spawn(stdout_loop(
            self.clone(),
            project_id.to_owned(),
            runtime.clone(),
            stdout,
            event_tx,
        ));
        tokio::spawn(stderr_loop(runtime.clone(), stderr));
        tokio::spawn(wait_loop(
            self.clone(),
            project_id.to_owned(),
            runtime.token.clone(),
            runtime.clone(),
            child,
            ProcessWaitState {
                control: control_rx,
                termination: termination_tx,
                job,
            },
        ));

        self.emit(
            project_id,
            None,
            AppEventKind::Connection {
                state: "connected".into(),
                message: None,
            },
        );

        let manager = self.clone();
        let project_id = project_id.to_owned();
        tokio::spawn(async move {
            if let Err(error) = manager.bootstrap_project(&project_id).await {
                manager.emit(
                    &project_id,
                    None,
                    AppEventKind::ProtocolWarning {
                        message: error.to_string(),
                    },
                );
            }
        });
        Ok(())
    }

    pub async fn stop_project(&self, project_id: &str) -> AppResult<()> {
        let runtime = self.runtimes.write().await.remove(project_id);
        if let Some(runtime) = runtime {
            let termination = runtime.termination.lock().await.take();
            runtime.expected_exit.store(true, Ordering::Relaxed);
            let _ = runtime.control.send(ProcessControl::Stop).await;
            fail_pending(&runtime, "Pi was stopped").await;
            self.emit(
                project_id,
                None,
                AppEventKind::Connection {
                    state: "disconnected".into(),
                    message: None,
                },
            );
            if let Some(termination) = termination
                && timeout(PROCESS_STOP_TIMEOUT, termination).await.is_err()
            {
                return Err(AppError::Message(format!(
                    "Pi did not stop within {} seconds for project {project_id}",
                    PROCESS_STOP_TIMEOUT.as_secs()
                )));
            }
        }
        Ok(())
    }

    pub async fn restart_project(self: &Arc<Self>, project_id: &str) -> AppResult<()> {
        self.crash_restarts.lock().await.remove(project_id);
        self.stop_project(project_id).await?;
        self.start_project(project_id).await
    }

    pub async fn shutdown_all(&self) {
        let ids = self
            .runtimes
            .read()
            .await
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        for id in ids {
            let _ = self.stop_project(&id).await;
        }
    }

    pub fn start_idle_reaper(self: &Arc<Self>) {
        let manager = self.clone();
        tauri::async_runtime::spawn(async move {
            let mut ticker = interval(Duration::from_secs(30));
            ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
            loop {
                ticker.tick().await;
                let settings = manager.config.settings();
                let cutoff = settings.idle_timeout_minutes.saturating_mul(60_000);
                let now = now_millis();
                let runtimes = manager.runtimes.read().await;
                let to_stop = runtimes
                    .iter()
                    .filter(|(id, runtime)| {
                        settings.active_project_id.as_deref() != Some(id.as_str())
                            && runtime.can_suspend()
                            && now.saturating_sub(runtime.last_touched.load(Ordering::Relaxed))
                                >= cutoff
                    })
                    .map(|(id, _)| id.clone())
                    .collect::<Vec<_>>();
                drop(runtimes);
                for id in to_stop {
                    let _ = manager.stop_project(&id).await;
                }
            }
        });
    }

    pub async fn rpc(&self, project_id: &str, mut command: Map<String, Value>) -> AppResult<Value> {
        let runtime = self
            .runtimes
            .read()
            .await
            .get(project_id)
            .cloned()
            .ok_or(AppError::PiNotRunning)?;
        runtime.touch();
        let id = Uuid::new_v4().to_string();
        command.insert("id".into(), Value::String(id.clone()));
        let (sender, receiver) = oneshot::channel();
        runtime.pending.lock().await.insert(id, sender);

        let mut bytes = serde_json::to_vec(&command)?;
        bytes.push(b'\n');
        if let Err(error) = async {
            let mut stdin = runtime.stdin.lock().await;
            stdin.write_all(&bytes).await?;
            stdin.flush().await
        }
        .await
        {
            return Err(AppError::Io(error));
        }

        let response = timeout(RPC_TIMEOUT, receiver)
            .await
            .map_err(|_| AppError::Timeout)?
            .map_err(|_| AppError::Message("Pi response channel closed".into()))??;
        if response.get("success").and_then(Value::as_bool) == Some(false) {
            return Err(AppError::Message(
                response
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("Pi rejected the command")
                    .to_owned(),
            ));
        }
        Ok(response)
    }

    pub async fn send_prompt(
        &self,
        project_id: &str,
        command_type: &str,
        text: String,
        images: Vec<PromptImage>,
    ) -> AppResult<()> {
        if text.trim().is_empty() && images.is_empty() {
            return Err(AppError::Message("A message or image is required".into()));
        }
        let mut command = Map::new();
        command.insert("type".into(), Value::String(command_type.to_owned()));
        command.insert("message".into(), Value::String(text));
        if !images.is_empty() {
            let encoded = images
                .iter()
                .map(|image| encode_image(&image.path))
                .collect::<AppResult<Vec<_>>>()?;
            command.insert("images".into(), Value::Array(encoded));
        }
        self.rpc(project_id, command).await?;
        Ok(())
    }

    pub async fn abort(&self, project_id: &str) -> AppResult<()> {
        self.rpc(project_id, object("abort")).await?;
        Ok(())
    }

    pub async fn new_session(&self, project_id: &str) -> AppResult<()> {
        self.rpc(project_id, object("new_session")).await?;
        self.bootstrap_project(project_id).await
    }

    pub async fn open_session(self: &Arc<Self>, project_id: &str, path: &Path) -> AppResult<()> {
        let project = self
            .config
            .project(project_id)
            .ok_or(AppError::ProjectNotFound)?;
        let path = sessions::ensure_session_owned(&project, path)?;
        self.config.mutate(|config| {
            let project = config
                .projects
                .iter_mut()
                .find(|project| project.id == project_id)
                .ok_or(AppError::ProjectNotFound)?;
            project.active_session = Some(path.clone());
            Ok(())
        })?;
        if self.runtimes.read().await.contains_key(project_id) {
            let mut command = object("switch_session");
            command.insert(
                "sessionPath".into(),
                Value::String(path.to_string_lossy().into_owned()),
            );
            self.rpc(project_id, command).await?;
            self.bootstrap_project(project_id).await
        } else {
            self.start_project(project_id).await
        }
    }

    pub async fn rename_session(&self, project_id: &str, name: String) -> AppResult<()> {
        let mut command = object("set_session_name");
        command.insert("name".into(), Value::String(name.trim().to_owned()));
        self.rpc(project_id, command).await?;
        self.bootstrap_project(project_id).await
    }

    pub async fn set_model(
        &self,
        project_id: &str,
        provider: String,
        model_id: String,
    ) -> AppResult<()> {
        let mut command = object("set_model");
        command.insert("provider".into(), Value::String(provider));
        command.insert("modelId".into(), Value::String(model_id));
        self.rpc(project_id, command).await?;
        self.bootstrap_project(project_id).await
    }

    pub async fn set_thinking_level(&self, project_id: &str, level: String) -> AppResult<()> {
        if !matches!(
            level.as_str(),
            "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
        ) {
            return Err(AppError::Message("Unsupported thinking level".into()));
        }
        let mut command = object("set_thinking_level");
        command.insert("level".into(), Value::String(level));
        self.rpc(project_id, command).await?;
        self.bootstrap_project(project_id).await
    }

    pub async fn respond_extension_ui(
        &self,
        project_id: &str,
        request_id: String,
        response: Value,
    ) -> AppResult<()> {
        let mut command = response.as_object().cloned().unwrap_or_default();
        command.insert("type".into(), Value::String("extension_ui_response".into()));
        command.insert("id".into(), Value::String(request_id.clone()));
        let runtime = self
            .runtimes
            .read()
            .await
            .get(project_id)
            .cloned()
            .ok_or(AppError::PiNotRunning)?;
        let mut bytes = serde_json::to_vec(&command)?;
        bytes.push(b'\n');
        let mut stdin = runtime.stdin.lock().await;
        stdin.write_all(&bytes).await?;
        stdin.flush().await?;
        runtime.blocking_dialogs.lock().remove(&request_id);
        Ok(())
    }

    async fn bootstrap_project(&self, project_id: &str) -> AppResult<()> {
        let state = data(self.rpc(project_id, object("get_state")).await?);
        let models_response = data(self.rpc(project_id, object("get_available_models")).await?);
        let commands_response = data(self.rpc(project_id, object("get_commands")).await?);
        let stats =
            data(self.rpc(project_id, object("get_session_stats")).await?).unwrap_or(Value::Null);

        let state = state.unwrap_or(Value::Null);
        let session_path = state
            .get("sessionFile")
            .and_then(Value::as_str)
            .map(PathBuf::from);
        let page = if let Some(path) = session_path.clone().filter(|path| path.exists()) {
            tokio::task::spawn_blocking(move || sessions::load_message_page(&path, None, 200))
                .await
                .ok()
                .and_then(Result::ok)
        } else {
            None
        };
        let (messages, history_cursor, has_older) = if let Some(page) = page {
            (page.messages, page.cursor, page.has_older)
        } else {
            let messages_response = data(self.rpc(project_id, object("get_messages")).await?);
            let mut messages = array_field(messages_response.as_ref(), "messages");
            if messages.len() > 200 {
                messages = messages.split_off(messages.len() - 200);
            }
            for message in &mut messages {
                projection::project_message(message);
            }
            (messages, None, false)
        };
        let models = array_field(models_response.as_ref(), "models");
        let commands = array_field(commands_response.as_ref(), "commands");
        let session_id = state
            .get("sessionId")
            .and_then(Value::as_str)
            .map(str::to_owned);
        if let Some(path) = session_path {
            self.config.mutate(|config| {
                if let Some(project) = config
                    .projects
                    .iter_mut()
                    .find(|project| project.id == project_id)
                {
                    project.active_session = Some(path);
                }
                Ok(())
            })?;
        }
        self.emit(
            project_id,
            session_id,
            AppEventKind::Snapshot {
                state,
                messages,
                models,
                commands,
                stats,
                history_cursor,
                has_older,
            },
        );
        Ok(())
    }

    fn emit(&self, project_id: &str, session_id: Option<String>, event: AppEventKind) {
        let Some(channel) = self.channel.read().as_ref().cloned() else {
            return;
        };
        let _ = channel.send(AppEvent {
            seq: self.sequence.fetch_add(1, Ordering::Relaxed),
            project_id: project_id.to_owned(),
            session_id,
            event,
        });
    }

    async fn handle_exit(
        self: &Arc<Self>,
        project_id: &str,
        token: &str,
        code: Option<i32>,
        expected: bool,
    ) {
        let mut runtimes = self.runtimes.write().await;
        if runtimes
            .get(project_id)
            .is_some_and(|runtime| runtime.token == token)
            && let Some(runtime) = runtimes.remove(project_id)
        {
            fail_pending(&runtime, "Pi exited").await;
        }
        drop(runtimes);
        self.emit(
            project_id,
            None,
            AppEventKind::ProcessExited { code, expected },
        );
        if !expected {
            let now = now_millis();
            let should_restart = {
                let mut restarts = self.crash_restarts.lock().await;
                let recent = restarts
                    .get(project_id)
                    .is_some_and(|previous| now.saturating_sub(*previous) < 60_000);
                if !recent {
                    restarts.insert(project_id.to_owned(), now);
                }
                !recent
            };
            if should_restart {
                let manager = self.clone();
                let project_id = project_id.to_owned();
                tokio::spawn(restart_after_crash(manager, project_id));
            }
        }
    }
}

fn restart_after_crash(
    manager: Arc<ProjectManager>,
    project_id: String,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> {
    Box::pin(async move {
        tokio::time::sleep(Duration::from_millis(750)).await;
        if let Err(error) = manager.start_project(&project_id).await {
            manager.emit(
                &project_id,
                None,
                AppEventKind::Connection {
                    state: "error".into(),
                    message: Some(format!("Pi could not be restarted: {error}")),
                },
            );
        }
    })
}

async fn stdout_loop(
    manager: Arc<ProjectManager>,
    project_id: String,
    runtime: Arc<ProjectRuntime>,
    stdout: tokio::process::ChildStdout,
    events: mpsc::UnboundedSender<Value>,
) {
    let mut reader = BufReader::new(stdout);
    let mut buffer = Vec::new();
    loop {
        buffer.clear();
        let count = match reader.read_until(b'\n', &mut buffer).await {
            Ok(count) => count,
            Err(error) => {
                manager.emit(
                    &project_id,
                    None,
                    AppEventKind::ProtocolWarning {
                        message: format!("Unable to read Pi output: {error}"),
                    },
                );
                break;
            }
        };
        if count == 0 {
            break;
        }
        if buffer.len() > MAX_RPC_RECORD_BYTES {
            manager.emit(
                &project_id,
                None,
                AppEventKind::ProtocolWarning {
                    message: "Pi emitted an oversized protocol record".into(),
                },
            );
            continue;
        }
        if buffer.ends_with(b"\n") {
            buffer.pop();
        }
        if buffer.ends_with(b"\r") {
            buffer.pop();
        }
        if buffer.is_empty() {
            continue;
        }
        let mut value = match serde_json::from_slice::<Value>(&buffer) {
            Ok(value) => value,
            Err(error) => {
                manager.emit(
                    &project_id,
                    None,
                    AppEventKind::ProtocolWarning {
                        message: format!("Pi emitted invalid JSON: {error}"),
                    },
                );
                continue;
            }
        };

        if value.get("type").and_then(Value::as_str) == Some("response")
            && let Some(id) = value.get("id").and_then(Value::as_str)
            && let Some(sender) = runtime.pending.lock().await.remove(id)
        {
            let _ = sender.send(Ok(value));
            continue;
        }
        projection::project_event(&mut value);
        let settled = value.get("type").and_then(Value::as_str) == Some("agent_settled");
        if let Some(request_id) = overflowing_extension_request(&runtime, &value) {
            let result = cancel_extension_request(&runtime, &request_id).await;
            manager.emit(
                &project_id,
                None,
                AppEventKind::ProtocolWarning {
                    message: match result {
                        Ok(()) => format!(
                            "An extension dialog was cancelled because {MAX_BLOCKING_DIALOGS} requests are already queued"
                        ),
                        Err(error) => format!(
                            "Unable to cancel an extension dialog after the queue filled: {error}"
                        ),
                    },
                },
            );
            continue;
        }
        update_runtime_state(&runtime, &value);
        let request_timeout = extension_request_timeout(&value);
        if events.send(value).is_err() {
            break;
        }
        if let Some((request_id, timeout_ms)) = request_timeout {
            let manager = manager.clone();
            let project_id = project_id.clone();
            let runtime = runtime.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(timeout_ms)).await;
                if runtime.blocking_dialogs.lock().remove(&request_id) {
                    manager.emit(
                        &project_id,
                        None,
                        AppEventKind::ExtensionUiExpired { request_id },
                    );
                }
            });
        }
        if settled {
            let manager = manager.clone();
            let project_id = project_id.clone();
            tokio::spawn(async move {
                if let Err(error) = manager.bootstrap_project(&project_id).await {
                    manager.emit(
                        &project_id,
                        None,
                        AppEventKind::ProtocolWarning {
                            message: format!("Unable to refresh the settled session: {error}"),
                        },
                    );
                }
            });
        }
    }
}

async fn stderr_loop(runtime: Arc<ProjectRuntime>, stderr: tokio::process::ChildStderr) {
    let mut reader = BufReader::new(stderr);
    let mut buffer = String::new();
    loop {
        buffer.clear();
        match reader.read_line(&mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                let mut lines = runtime.stderr.lock().await;
                if lines.len() >= MAX_STDERR_LINES {
                    lines.pop_front();
                }
                lines.push_back(buffer.trim_end().to_owned());
            }
        }
    }
}

async fn wait_loop(
    manager: Arc<ProjectManager>,
    project_id: String,
    token: String,
    runtime: Arc<ProjectRuntime>,
    mut child: Child,
    wait: ProcessWaitState,
) {
    let ProcessWaitState {
        mut control,
        termination,
        job,
    } = wait;
    let status = tokio::select! {
        status = child.wait() => status.ok(),
        command = control.recv() => {
            if matches!(command, Some(ProcessControl::Stop)) {
                runtime.expected_exit.store(true, Ordering::Relaxed);
                let _ = child.kill().await;
            }
            child.wait().await.ok()
        }
    };
    drop(job);
    let _ = termination.send(());
    manager
        .handle_exit(
            &project_id,
            &token,
            status.and_then(|status| status.code()),
            runtime.expected_exit.load(Ordering::Relaxed),
        )
        .await;
}

async fn event_batch_loop(
    manager: Arc<ProjectManager>,
    project_id: String,
    mut receiver: mpsc::UnboundedReceiver<Value>,
) {
    let mut ticker = interval(Duration::from_millis(33));
    ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut pending = Vec::<Value>::new();
    loop {
        tokio::select! {
            _ = ticker.tick() => flush_events(&manager, &project_id, &mut pending),
            event = receiver.recv() => match event {
                Some(event) if is_high_frequency(&event) => merge_event(&mut pending, event),
                Some(event) => {
                    flush_events(&manager, &project_id, &mut pending);
                    manager.emit(&project_id, None, AppEventKind::PiEvent { event });
                }
                None => {
                    flush_events(&manager, &project_id, &mut pending);
                    break;
                }
            }
        }
    }
}

fn flush_events(manager: &ProjectManager, project_id: &str, pending: &mut Vec<Value>) {
    if !pending.is_empty() {
        manager.emit(
            project_id,
            None,
            AppEventKind::PiEvents {
                events: std::mem::take(pending),
            },
        );
    }
}

fn merge_event(pending: &mut Vec<Value>, event: Value) {
    let event_type = event.get("type").and_then(Value::as_str);
    if event_type == Some("tool_execution_update") {
        let call_id = event.get("toolCallId").and_then(Value::as_str);
        if let Some(existing) = pending.iter_mut().rev().find(|value| {
            value.get("type").and_then(Value::as_str) == event_type
                && value.get("toolCallId").and_then(Value::as_str) == call_id
        }) {
            *existing = event;
            return;
        }
    }

    if event_type == Some("message_update") {
        let delta_type = event
            .pointer("/assistantMessageEvent/type")
            .and_then(Value::as_str);
        let content_index = event
            .pointer("/assistantMessageEvent/contentIndex")
            .and_then(Value::as_u64);
        if matches!(delta_type, Some("text_delta" | "thinking_delta"))
            && let Some(existing) = pending.last_mut().filter(|value| {
                value
                    .pointer("/assistantMessageEvent/type")
                    .and_then(Value::as_str)
                    == delta_type
                    && value
                        .pointer("/assistantMessageEvent/contentIndex")
                        .and_then(Value::as_u64)
                        == content_index
            })
        {
            let addition = event
                .pointer("/assistantMessageEvent/delta")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if let Some(delta) = existing
                .pointer_mut("/assistantMessageEvent/delta")
                .and_then(|value| value.as_str())
            {
                let mut joined = delta.to_owned();
                joined.push_str(addition);
                if let Some(target) = existing.pointer_mut("/assistantMessageEvent/delta") {
                    *target = Value::String(joined);
                }
                if let Some(message) = event.get("message") {
                    existing["message"] = message.clone();
                }
                return;
            }
        }
    }
    pending.push(event);
}

fn is_high_frequency(value: &Value) -> bool {
    matches!(
        value.get("type").and_then(Value::as_str),
        Some("message_update" | "tool_execution_update")
    )
}

fn update_runtime_state(runtime: &ProjectRuntime, value: &Value) {
    match value.get("type").and_then(Value::as_str) {
        Some("agent_start") => {
            runtime.settled.store(false, Ordering::Relaxed);
            runtime.touch();
        }
        Some("agent_settled") => {
            runtime.settled.store(true, Ordering::Relaxed);
            runtime.touch();
        }
        Some("queue_update") => {
            let steering = value
                .get("steering")
                .and_then(Value::as_array)
                .is_some_and(|queue| !queue.is_empty());
            let follow_up = value
                .get("followUp")
                .and_then(Value::as_array)
                .is_some_and(|queue| !queue.is_empty());
            runtime
                .has_queue
                .store(steering || follow_up, Ordering::Relaxed);
        }
        Some("extension_ui_request") => {
            if matches!(
                value.get("method").and_then(Value::as_str),
                Some("select" | "confirm" | "input" | "editor")
            ) && let Some(id) = value.get("id").and_then(Value::as_str)
            {
                runtime.blocking_dialogs.lock().insert(id.to_owned());
            }
        }
        _ => {}
    }
}

fn overflowing_extension_request(runtime: &ProjectRuntime, value: &Value) -> Option<String> {
    if value.get("type").and_then(Value::as_str) != Some("extension_ui_request")
        || !matches!(
            value.get("method").and_then(Value::as_str),
            Some("select" | "confirm" | "input" | "editor")
        )
    {
        return None;
    }
    let request_id = value.get("id")?.as_str()?;
    let requests = runtime.blocking_dialogs.lock();
    (!requests.contains(request_id) && requests.len() >= MAX_BLOCKING_DIALOGS)
        .then(|| request_id.to_owned())
}

async fn cancel_extension_request(runtime: &ProjectRuntime, request_id: &str) -> AppResult<()> {
    let mut response = object("extension_ui_response");
    response.insert("id".into(), Value::String(request_id.to_owned()));
    response.insert("cancelled".into(), Value::Bool(true));
    let mut bytes = serde_json::to_vec(&response)?;
    bytes.push(b'\n');
    let mut stdin = runtime.stdin.lock().await;
    stdin.write_all(&bytes).await?;
    stdin.flush().await?;
    Ok(())
}

fn extension_request_timeout(value: &Value) -> Option<(String, u64)> {
    if value.get("type").and_then(Value::as_str) != Some("extension_ui_request")
        || !matches!(
            value.get("method").and_then(Value::as_str),
            Some("select" | "confirm" | "input" | "editor")
        )
    {
        return None;
    }
    Some((
        value.get("id")?.as_str()?.to_owned(),
        value.get("timeout")?.as_u64()?,
    ))
}

async fn fail_pending(runtime: &ProjectRuntime, message: &str) {
    for (_, sender) in runtime.pending.lock().await.drain() {
        let _ = sender.send(Err(AppError::Message(message.to_owned())));
    }
}

fn object(command_type: &str) -> Map<String, Value> {
    let mut object = Map::new();
    object.insert("type".into(), Value::String(command_type.to_owned()));
    object
}

fn data(response: Value) -> Option<Value> {
    response.get("data").cloned()
}

fn array_field(value: Option<&Value>, field: &str) -> Vec<Value> {
    value
        .and_then(|value| value.get(field))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn encode_image(path: &Path) -> AppResult<Value> {
    let metadata = std::fs::metadata(path)?;
    if metadata.len() > MAX_IMAGE_BYTES {
        return Err(AppError::Message("Images must be 20 MB or smaller".into()));
    }
    let mime = mime_guess::from_path(path)
        .first_raw()
        .filter(|mime| mime.starts_with("image/"))
        .ok_or_else(|| AppError::Message("Only image attachments are supported".into()))?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(std::fs::read(path)?);
    Ok(json!({ "type": "image", "data": encoded, "mimeType": mime }))
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{is_high_frequency, merge_event};

    #[test]
    fn combines_adjacent_text_deltas() {
        let mut pending = Vec::new();
        merge_event(
            &mut pending,
            json!({"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"hello "}}),
        );
        merge_event(
            &mut pending,
            json!({"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"world"}}),
        );
        assert_eq!(pending.len(), 1);
        assert_eq!(
            pending[0].pointer("/assistantMessageEvent/delta").unwrap(),
            "hello world"
        );
        assert!(is_high_frequency(&pending[0]));
    }

    #[test]
    fn keeps_unicode_line_separators_inside_json_values() {
        let value: serde_json::Value =
            serde_json::from_slice(b"{\"text\":\"a\xE2\x80\xA8b\"}").unwrap();
        assert_eq!(value["text"], "a\u{2028}b");
    }
}
