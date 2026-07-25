use std::{
    collections::{HashMap, HashSet, VecDeque},
    io::Read as StdRead,
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
    io::{AsyncReadExt, AsyncWriteExt},
    process::{Child, ChildStdin, Command},
    sync::{Mutex, Notify, RwLock, mpsc, oneshot},
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
const MAX_IMAGES_PER_PROMPT: usize = 8;
const MAX_STDERR_LINES: usize = 200;
const MAX_STDERR_LINE_BYTES: usize = 64 * 1024;
const MAX_BLOCKING_DIALOGS: usize = 16;
const EVENT_CHANNEL_CAPACITY: usize = 256;
const RPC_TIMEOUT: Duration = Duration::from_secs(30);
const PROCESS_STOP_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_BACKGROUND_RUNTIMES_PER_PROJECT: usize = 3;

enum ProcessControl {
    Stop,
}

struct ProcessWaitState {
    control: mpsc::Receiver<ProcessControl>,
    termination: oneshot::Sender<()>,
    job: JobGuard,
}

struct ProjectRuntime {
    token: String,
    session_id: ParkingRwLock<Option<String>>,
    session_path: ParkingRwLock<Option<PathBuf>>,
    stdin: Mutex<ChildStdin>,
    pending: Mutex<HashMap<String, oneshot::Sender<AppResult<Value>>>>,
    command_catalog: ParkingMutex<Option<Vec<Value>>>,
    bootstrap_generation: AtomicU64,
    session_switch_generation: AtomicU64,
    session_transition: Mutex<()>,
    session_transition_pending: AtomicBool,
    settled_signal: Notify,
    control: mpsc::Sender<ProcessControl>,
    termination: Mutex<Option<oneshot::Receiver<()>>>,
    settled: AtomicBool,
    has_queue: AtomicBool,
    blocking_dialogs: ParkingMutex<HashSet<String>>,
    last_touched: AtomicU64,
    expected_exit: AtomicBool,
    terminated: AtomicBool,
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

    fn session_id(&self) -> Option<String> {
        self.session_id.read().clone()
    }

    fn session_path(&self) -> Option<PathBuf> {
        self.session_path.read().clone()
    }

    fn set_session_identity(&self, session_id: Option<String>, session_path: Option<PathBuf>) {
        *self.session_id.write() = session_id;
        *self.session_path.write() = session_path;
    }
}

struct SessionTransitionGuard {
    runtime: Arc<ProjectRuntime>,
}

impl SessionTransitionGuard {
    fn begin(runtime: Arc<ProjectRuntime>) -> AppResult<Self> {
        runtime
            .session_transition_pending
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| AppError::Message("A session change is already in progress".into()))?;
        runtime
            .session_switch_generation
            .fetch_add(1, Ordering::AcqRel);
        Ok(Self { runtime })
    }
}

impl Drop for SessionTransitionGuard {
    fn drop(&mut self) {
        self.runtime
            .session_transition_pending
            .store(false, Ordering::Release);
    }
}

pub struct ProjectManager {
    pub config: Arc<ConfigStore>,
    pub credentials: Arc<CredentialStore>,
    runtimes: RwLock<HashMap<String, Arc<ProjectRuntime>>>,
    background_runtimes: RwLock<HashMap<String, HashMap<String, Arc<ProjectRuntime>>>>,
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
            background_runtimes: RwLock::new(HashMap::new()),
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

    async fn active_runtime(&self, project_id: &str) -> AppResult<Arc<ProjectRuntime>> {
        self.runtimes
            .read()
            .await
            .get(project_id)
            .cloned()
            .ok_or(AppError::PiNotRunning)
    }

    pub async fn is_running(&self, project_id: &str) -> bool {
        if self.runtimes.read().await.contains_key(project_id) {
            return true;
        }
        self.background_runtimes
            .read()
            .await
            .get(project_id)
            .is_some_and(|runtimes| !runtimes.is_empty())
    }

    pub async fn restart_running_projects(self: &Arc<Self>) {
        let mut ids = self
            .runtimes
            .read()
            .await
            .keys()
            .cloned()
            .collect::<HashSet<_>>();
        ids.extend(self.background_runtimes.read().await.keys().cloned());
        for id in ids {
            let _ = self.restart_project(&id).await;
        }
    }

    pub async fn quiesce_for_package_change(
        self: &Arc<Self>,
        project_id: Option<&str>,
    ) -> AppResult<Vec<String>> {
        let active = self.runtimes.read().await;
        let backgrounds = self.background_runtimes.read().await;
        let mut targets = active
            .keys()
            .chain(backgrounds.keys())
            .filter(|id| project_id.is_none_or(|target| target == id.as_str()))
            .cloned()
            .collect::<HashSet<_>>();
        let busy = targets
            .iter()
            .filter(|id| {
                active
                    .get(*id)
                    .is_some_and(|runtime| !runtime.can_suspend())
                    || backgrounds.get(*id).is_some_and(|runtimes| {
                        runtimes.values().any(|runtime| !runtime.can_suspend())
                    })
            })
            .map(|id| {
                self.config
                    .project(id)
                    .map_or_else(|| id.clone(), |project| project.name)
            })
            .collect::<Vec<_>>();
        drop(backgrounds);
        drop(active);
        if !busy.is_empty() {
            return Err(AppError::Message(format!(
                "Wait for these Pi projects to settle before changing packages: {}",
                busy.join(", ")
            )));
        }
        let ids = targets.drain().collect::<Vec<_>>();
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

        self.emit(
            project_id,
            None,
            AppEventKind::Connection {
                state: "connecting".into(),
                message: None,
            },
        );

        let runtime = self
            .spawn_runtime(project_id, project.active_session.clone())
            .await?;
        let mut runtimes = self.runtimes.write().await;
        if runtimes.contains_key(project_id) {
            drop(runtimes);
            stop_runtime_process(runtime).await?;
            return Ok(());
        }
        runtimes.insert(project_id.to_owned(), runtime.clone());
        drop(runtimes);

        self.emit(
            project_id,
            runtime.session_id(),
            AppEventKind::Connection {
                state: "connected".into(),
                message: None,
            },
        );

        let manager = self.clone();
        let project_id = project_id.to_owned();
        tokio::spawn(async move {
            if let Err(error) = manager.bootstrap_runtime(&project_id, &runtime).await {
                manager.emit_runtime(
                    &project_id,
                    &runtime,
                    AppEventKind::Connection {
                        state: "error".into(),
                        message: Some(error.to_string()),
                    },
                );
            }
        });
        Ok(())
    }

    async fn spawn_runtime(
        self: &Arc<Self>,
        project_id: &str,
        session_path: Option<PathBuf>,
    ) -> AppResult<Arc<ProjectRuntime>> {
        let project = self
            .config
            .project(project_id)
            .ok_or(AppError::ProjectNotFound)?;
        let pi_path = resolve_pi(self.config.settings().pi_path)
            .ok_or_else(|| AppError::Message("Pi is not installed or configured".into()))?;

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
        if let Some(session) = session_path.as_ref().filter(|path| path.exists()) {
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
        let job = match JobGuard::attach(process_id) {
            Ok(job) => job,
            Err(error) => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                return Err(AppError::Message(format!(
                    "Unable to secure the Pi process tree: {error}"
                )));
            }
        };
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
        let (event_tx, event_rx) = mpsc::channel(EVENT_CHANNEL_CAPACITY);

        let runtime = Arc::new(ProjectRuntime {
            token: Uuid::new_v4().to_string(),
            session_id: ParkingRwLock::new(None),
            session_path: ParkingRwLock::new(session_path),
            stdin: Mutex::new(stdin),
            pending: Mutex::new(HashMap::new()),
            command_catalog: ParkingMutex::new(self.config.cached_command_catalog(project_id)),
            bootstrap_generation: AtomicU64::new(0),
            session_switch_generation: AtomicU64::new(0),
            session_transition: Mutex::new(()),
            session_transition_pending: AtomicBool::new(false),
            settled_signal: Notify::new(),
            control: control_tx,
            termination: Mutex::new(Some(termination_rx)),
            settled: AtomicBool::new(true),
            has_queue: AtomicBool::new(false),
            blocking_dialogs: ParkingMutex::new(HashSet::new()),
            last_touched: AtomicU64::new(now_millis()),
            expected_exit: AtomicBool::new(false),
            terminated: AtomicBool::new(false),
            stderr: Mutex::new(VecDeque::with_capacity(MAX_STDERR_LINES)),
        });

        tokio::spawn(event_batch_loop(
            self.clone(),
            project_id.to_owned(),
            runtime.clone(),
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
        Ok(runtime)
    }

    pub async fn stop_project(&self, project_id: &str) -> AppResult<()> {
        let mut runtimes = Vec::new();
        if let Some(runtime) = self.runtimes.write().await.remove(project_id) {
            runtimes.push(runtime);
        }
        if let Some(backgrounds) = self.background_runtimes.write().await.remove(project_id) {
            runtimes.extend(backgrounds.into_values());
        }
        if !runtimes.is_empty() {
            self.emit(
                project_id,
                None,
                AppEventKind::Connection {
                    state: "disconnected".into(),
                    message: None,
                },
            );
            for runtime in runtimes {
                stop_runtime_process(runtime).await?;
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
        let mut ids = self
            .runtimes
            .read()
            .await
            .keys()
            .cloned()
            .collect::<HashSet<_>>();
        ids.extend(self.background_runtimes.read().await.keys().cloned());
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
                let background_to_stop = manager
                    .background_runtimes
                    .read()
                    .await
                    .iter()
                    .flat_map(|(project_id, runtimes)| {
                        runtimes
                            .iter()
                            .filter(|(_, runtime)| runtime.can_suspend())
                            .map(|(token, _)| (project_id.clone(), token.clone()))
                            .collect::<Vec<_>>()
                    })
                    .collect::<Vec<_>>();
                for (project_id, token) in background_to_stop {
                    let _ = manager.retire_background_runtime(&project_id, &token).await;
                }
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
        let runtime = self.active_runtime(project_id).await?;
        self.rpc_runtime(&runtime, &mut command).await
    }

    async fn rpc_runtime(
        &self,
        runtime: &ProjectRuntime,
        command: &mut Map<String, Value>,
    ) -> AppResult<Value> {
        runtime.touch();
        let id = Uuid::new_v4().to_string();
        command.insert("id".into(), Value::String(id.clone()));
        let mut bytes = serde_json::to_vec(&command)?;
        bytes.push(b'\n');
        let (sender, receiver) = oneshot::channel();
        runtime.pending.lock().await.insert(id.clone(), sender);
        if let Err(error) = async {
            let mut stdin = runtime.stdin.lock().await;
            stdin.write_all(&bytes).await?;
            stdin.flush().await
        }
        .await
        {
            runtime.pending.lock().await.remove(&id);
            return Err(AppError::Io(error));
        }

        let response = wait_for_rpc_response(&runtime.pending, &id, receiver, RPC_TIMEOUT).await?;
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
        if images.len() > MAX_IMAGES_PER_PROMPT {
            return Err(AppError::Message(format!(
                "Attach no more than {MAX_IMAGES_PER_PROMPT} images at once"
            )));
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
        let runtime = self.active_runtime(project_id).await?;
        let _session_transition = runtime.session_transition.lock().await;
        if runtime.session_transition_pending.load(Ordering::Acquire) {
            return Err(AppError::Message(
                "Wait for the pending session change before sending another message".into(),
            ));
        }
        let was_settled = runtime.settled.swap(false, Ordering::AcqRel);
        match self.rpc_runtime(&runtime, &mut command).await {
            Ok(_) => {
                if was_settled
                    && let Ok(state) = self.rpc_runtime(&runtime, &mut object("get_state")).await
                {
                    update_runtime_identity_from_response(&runtime, &state);
                    if rpc_reports_session_idle(&runtime, &state) {
                        runtime.settled.store(true, Ordering::Release);
                        runtime.settled_signal.notify_one();
                    }
                }
                Ok(())
            }
            Err(error) => {
                if matches!(&error, AppError::Message(_))
                    && !runtime.terminated.load(Ordering::Acquire)
                {
                    runtime.settled.store(was_settled, Ordering::Release);
                    if was_settled {
                        runtime.settled_signal.notify_one();
                    }
                }
                Err(error)
            }
        }
    }

    pub async fn abort(&self, project_id: &str) -> AppResult<()> {
        self.rpc(project_id, object("abort")).await?;
        Ok(())
    }

    pub async fn new_session(self: &Arc<Self>, project_id: &str) -> AppResult<()> {
        let runtime = self.active_runtime(project_id).await?;
        let _session_transition = runtime.session_transition.lock().await;
        self.reconcile_runtime_idle(&runtime).await?;
        if !runtime.can_suspend() {
            return self
                .start_parallel_session(project_id, runtime.clone(), None)
                .await;
        }
        let _pending = SessionTransitionGuard::begin(runtime.clone())?;
        self.rpc_runtime(&runtime, &mut object("new_session"))
            .await?;
        self.persist_active_session(project_id, None)?;
        self.bootstrap_runtime(project_id, &runtime).await
    }

    pub async fn open_session(self: &Arc<Self>, project_id: &str, path: &Path) -> AppResult<()> {
        let project = self
            .config
            .project(project_id)
            .ok_or(AppError::ProjectNotFound)?;
        let path = sessions::ensure_session_owned(&project, path)?;
        let runtime = self.runtimes.read().await.get(project_id).cloned();
        let _session_transition = if let Some(runtime) = runtime.as_ref() {
            Some(runtime.session_transition.lock().await)
        } else {
            None
        };
        if self
            .promote_background_runtime(project_id, &path)
            .await?
            .is_some()
        {
            return Ok(());
        }
        if let Some(runtime) = runtime.as_ref() {
            if runtime
                .session_path()
                .is_some_and(|current| same_session_path(&current, &path))
            {
                return Ok(());
            }
            self.reconcile_runtime_idle(runtime).await?;
            if !runtime.can_suspend() {
                return self
                    .start_parallel_session(project_id, runtime.clone(), Some(path))
                    .await;
            }
            let _pending = SessionTransitionGuard::begin(runtime.clone())?;
            let mut command = object("switch_session");
            command.insert(
                "sessionPath".into(),
                Value::String(path.to_string_lossy().into_owned()),
            );
            self.rpc_runtime(runtime, &mut command).await?;
            self.persist_active_session(project_id, Some(path))?;
            self.bootstrap_runtime(project_id, runtime).await
        } else {
            self.persist_active_session(project_id, Some(path))?;
            self.start_project(project_id).await
        }
    }

    fn persist_active_session(&self, project_id: &str, path: Option<PathBuf>) -> AppResult<()> {
        let now = chrono::Utc::now().to_rfc3339();
        self.config.mutate(|config| {
            let project = config
                .projects
                .iter_mut()
                .find(|project| project.id == project_id)
                .ok_or(AppError::ProjectNotFound)?;
            project.active_session = path;
            project.last_opened_at = now;
            config.settings.active_project_id = Some(project_id.to_owned());
            Ok(())
        })
    }

    async fn reconcile_runtime_idle(&self, runtime: &ProjectRuntime) -> AppResult<()> {
        if runtime.settled.load(Ordering::Acquire) {
            return Ok(());
        }
        let state = self.rpc_runtime(runtime, &mut object("get_state")).await?;
        if rpc_reports_session_idle(runtime, &state) {
            runtime.settled.store(true, Ordering::Release);
        }
        Ok(())
    }

    async fn start_parallel_session(
        self: &Arc<Self>,
        project_id: &str,
        runtime: Arc<ProjectRuntime>,
        session_path: Option<PathBuf>,
    ) -> AppResult<()> {
        let previous_path = runtime.session_path();
        self.detach_active_runtime(project_id, &runtime).await?;
        if let Err(error) = self.persist_active_session(project_id, session_path) {
            self.restore_detached_runtime(project_id, &runtime).await;
            return Err(error);
        }
        if let Err(error) = self.start_project(project_id).await {
            self.restore_detached_runtime(project_id, &runtime).await;
            let _ = self.persist_active_session(project_id, previous_path);
            return Err(error);
        }
        Ok(())
    }

    async fn detach_active_runtime(
        &self,
        project_id: &str,
        runtime: &Arc<ProjectRuntime>,
    ) -> AppResult<()> {
        let (background_count, settled) = {
            let mut all_backgrounds = self.background_runtimes.write().await;
            if let Some(backgrounds) = all_backgrounds.get_mut(project_id) {
                let settled_tokens = backgrounds
                    .iter()
                    .filter(|(_, runtime)| runtime.can_suspend())
                    .map(|(token, _)| token.clone())
                    .collect::<Vec<_>>();
                let settled = settled_tokens
                    .into_iter()
                    .filter_map(|token| backgrounds.remove(&token))
                    .collect::<Vec<_>>();
                (backgrounds.len(), settled)
            } else {
                (0, Vec::new())
            }
        };
        for runtime in settled {
            tokio::spawn(async move {
                let _ = stop_runtime_process(runtime).await;
            });
        }
        if background_count >= MAX_BACKGROUND_RUNTIMES_PER_PROJECT {
            return Err(AppError::Message(format!(
                "Up to {} Pi chats can run at once in a project. Wait for one to finish before starting another.",
                MAX_BACKGROUND_RUNTIMES_PER_PROJECT + 1
            )));
        }
        let removed = self.runtimes.write().await.remove(project_id);
        if removed
            .as_ref()
            .is_none_or(|active| active.token != runtime.token)
        {
            if let Some(active) = removed {
                self.runtimes
                    .write()
                    .await
                    .insert(project_id.to_owned(), active);
            }
            return Err(AppError::Message("The active Pi session changed".into()));
        }
        self.background_runtimes
            .write()
            .await
            .entry(project_id.to_owned())
            .or_default()
            .insert(runtime.token.clone(), runtime.clone());
        Ok(())
    }

    async fn restore_detached_runtime(&self, project_id: &str, runtime: &Arc<ProjectRuntime>) {
        if let Some(backgrounds) = self.background_runtimes.write().await.get_mut(project_id) {
            backgrounds.remove(&runtime.token);
        }
        self.runtimes
            .write()
            .await
            .insert(project_id.to_owned(), runtime.clone());
    }

    async fn promote_background_runtime(
        self: &Arc<Self>,
        project_id: &str,
        path: &Path,
    ) -> AppResult<Option<Arc<ProjectRuntime>>> {
        let target = {
            let mut all_backgrounds = self.background_runtimes.write().await;
            let Some(backgrounds) = all_backgrounds.get_mut(project_id) else {
                return Ok(None);
            };
            let token = backgrounds.iter().find_map(|(token, runtime)| {
                runtime
                    .session_path()
                    .filter(|candidate| same_session_path(candidate, path))
                    .map(|_| token.clone())
            });
            token.and_then(|token| backgrounds.remove(&token))
        };
        let Some(target) = target else {
            return Ok(None);
        };

        if let Err(error) = self.persist_active_session(project_id, Some(path.to_path_buf())) {
            self.background_runtimes
                .write()
                .await
                .entry(project_id.to_owned())
                .or_default()
                .insert(target.token.clone(), target);
            return Err(error);
        }

        let previous = self
            .runtimes
            .write()
            .await
            .insert(project_id.to_owned(), target.clone());
        if let Some(previous) = previous.filter(|runtime| runtime.token != target.token) {
            if previous.can_suspend() {
                tokio::spawn(async move {
                    let _ = stop_runtime_process(previous).await;
                });
            } else {
                self.background_runtimes
                    .write()
                    .await
                    .entry(project_id.to_owned())
                    .or_default()
                    .insert(previous.token.clone(), previous);
            }
        }
        target.touch();
        let manager = self.clone();
        let project_id = project_id.to_owned();
        let runtime = target.clone();
        tokio::spawn(async move {
            if let Err(error) = manager.bootstrap_runtime(&project_id, &runtime).await {
                manager.emit_runtime(
                    &project_id,
                    &runtime,
                    AppEventKind::Connection {
                        state: "error".into(),
                        message: Some(error.to_string()),
                    },
                );
            }
        });
        Ok(Some(target))
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
        let runtime = self.active_runtime(project_id).await?;
        self.bootstrap_runtime(project_id, &runtime).await
    }

    async fn bootstrap_runtime(
        &self,
        project_id: &str,
        runtime: &Arc<ProjectRuntime>,
    ) -> AppResult<()> {
        let generation = runtime.bootstrap_generation.fetch_add(1, Ordering::Relaxed) + 1;
        let state = data(self.rpc_runtime(runtime, &mut object("get_state")).await?);
        let mut state = state.unwrap_or(Value::Null);
        if let Some(path) = state.get("sessionFile").and_then(Value::as_str) {
            let normalized = normalize_windows_verbatim_path(path);
            if normalized != path {
                state["sessionFile"] = Value::String(normalized);
            }
        }
        let session_path = state
            .get("sessionFile")
            .and_then(Value::as_str)
            .map(PathBuf::from)
            .or_else(|| runtime.session_path());
        if state.get("sessionFile").is_none()
            && let Some(path) = session_path.as_ref()
        {
            state["sessionFile"] = Value::String(path.to_string_lossy().into_owned());
        }
        let session_id = state
            .get("sessionId")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .or_else(|| runtime.session_id());
        runtime.set_session_identity(session_id.clone(), session_path.clone());
        let page_path = session_path.clone();
        let page = async move {
            let path = page_path.filter(|path| path.exists())?;
            tokio::task::spawn_blocking(move || sessions::load_message_page(&path, None, 200))
                .await
                .ok()
                .and_then(Result::ok)
        };
        let mut models_command = object("get_available_models");
        let mut stats_command = object("get_session_stats");
        let (models_response, commands, stats_response, page) = tokio::join!(
            self.rpc_runtime(runtime, &mut models_command),
            self.command_catalog_for_runtime(project_id, runtime),
            self.rpc_runtime(runtime, &mut stats_command),
            page,
        );
        let models_response = data(models_response?);
        let commands = commands?;
        let stats = data(stats_response?).unwrap_or(Value::Null);
        let (messages, history_cursor, has_older) = if let Some(page) = page {
            (page.messages, page.cursor, page.has_older)
        } else {
            let messages_response = data(
                self.rpc_runtime(runtime, &mut object("get_messages"))
                    .await?,
            );
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
        if runtime.bootstrap_generation.load(Ordering::Relaxed) != generation {
            return Ok(());
        }
        let is_active = self
            .runtimes
            .read()
            .await
            .get(project_id)
            .is_some_and(|active| active.token == runtime.token);
        if is_active
            && let Some(path) = session_path
            && self
                .config
                .project(project_id)
                .and_then(|project| project.active_session)
                .as_ref()
                .is_none_or(|current| !same_session_path(current, &path))
        {
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
        self.emit_runtime(
            project_id,
            runtime,
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

    async fn refresh_settled_runtime(
        self: &Arc<Self>,
        project_id: &str,
        runtime: Arc<ProjectRuntime>,
        session_generation: u64,
    ) -> AppResult<()> {
        let is_active = self
            .runtimes
            .read()
            .await
            .get(project_id)
            .is_some_and(|active| active.token == runtime.token);
        let is_background = self
            .background_runtimes
            .read()
            .await
            .get(project_id)
            .is_some_and(|runtimes| runtimes.contains_key(&runtime.token));
        if !is_active && !is_background {
            return Ok(());
        }
        let _session_transition = runtime.session_transition.lock().await;
        if runtime.terminated.load(Ordering::Acquire)
            || runtime.session_transition_pending.load(Ordering::Acquire)
            || runtime.session_switch_generation.load(Ordering::Acquire) != session_generation
        {
            return Ok(());
        }
        self.bootstrap_runtime(project_id, &runtime).await?;
        if is_background && runtime.can_suspend() {
            self.retire_background_runtime(project_id, &runtime.token)
                .await?;
        }
        Ok(())
    }

    async fn command_catalog_for_runtime(
        &self,
        project_id: &str,
        runtime: &ProjectRuntime,
    ) -> AppResult<Vec<Value>> {
        if let Some(commands) = runtime.command_catalog.lock().as_ref() {
            return Ok(commands.clone());
        }

        let response = match self
            .rpc_runtime(runtime, &mut object("get_command_catalog"))
            .await
        {
            Ok(response) => response,
            Err(error) if is_unknown_command(&error, "get_command_catalog") => {
                self.rpc_runtime(runtime, &mut object("get_commands"))
                    .await?
            }
            Err(error) => return Err(error),
        };
        let response_data = data(response);
        let commands = array_field(response_data.as_ref(), "commands");
        self.config.cache_command_catalog(project_id, &commands);
        *runtime.command_catalog.lock() = Some(commands.clone());
        Ok(commands)
    }

    async fn retire_background_runtime(&self, project_id: &str, token: &str) -> AppResult<()> {
        let runtime = self
            .background_runtimes
            .write()
            .await
            .get_mut(project_id)
            .and_then(|runtimes| runtimes.remove(token));
        if let Some(runtime) = runtime {
            stop_runtime_process(runtime).await?;
        }
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

    fn emit_runtime(&self, project_id: &str, runtime: &ProjectRuntime, event: AppEventKind) {
        self.emit(project_id, runtime.session_id(), event);
    }

    async fn handle_exit(
        self: &Arc<Self>,
        project_id: &str,
        token: &str,
        runtime: Arc<ProjectRuntime>,
        code: Option<i32>,
        expected: bool,
    ) {
        let mut runtimes = self.runtimes.write().await;
        let active = if runtimes
            .get(project_id)
            .is_some_and(|runtime| runtime.token == token)
        {
            runtimes.remove(project_id);
            true
        } else {
            false
        };
        drop(runtimes);
        if let Some(backgrounds) = self.background_runtimes.write().await.get_mut(project_id) {
            backgrounds.remove(token);
        }
        runtime.terminated.store(true, Ordering::Release);
        runtime.settled_signal.notify_one();
        fail_pending(&runtime, "Pi exited").await;
        self.emit_runtime(
            project_id,
            &runtime,
            AppEventKind::ProcessExited { code, expected },
        );
        if active && !expected {
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

#[derive(Debug, PartialEq, Eq)]
enum FramedLine {
    Line(Vec<u8>),
    Oversized,
}

struct BoundedLfFramer {
    limit: usize,
    record: Vec<u8>,
    oversized: bool,
}

impl BoundedLfFramer {
    fn new(limit: usize) -> Self {
        Self {
            limit,
            record: Vec::with_capacity(limit.min(8 * 1024)),
            oversized: false,
        }
    }

    fn push(&mut self, chunk: &[u8]) -> Vec<FramedLine> {
        let mut frames = Vec::new();
        for byte in chunk {
            if *byte == b'\n' {
                if let Some(frame) = self.complete() {
                    frames.push(frame);
                }
            } else if !self.oversized {
                if self.record.len() >= self.limit {
                    self.record.clear();
                    self.oversized = true;
                } else {
                    self.record.push(*byte);
                }
            }
        }
        frames
    }

    fn finish(&mut self) -> Option<FramedLine> {
        self.complete()
    }

    fn complete(&mut self) -> Option<FramedLine> {
        if self.oversized {
            self.oversized = false;
            self.record.clear();
            return Some(FramedLine::Oversized);
        }
        if self.record.last() == Some(&b'\r') {
            self.record.pop();
        }
        if self.record.is_empty() {
            return None;
        }
        Some(FramedLine::Line(std::mem::take(&mut self.record)))
    }
}

async fn stdout_loop(
    manager: Arc<ProjectManager>,
    project_id: String,
    runtime: Arc<ProjectRuntime>,
    mut stdout: tokio::process::ChildStdout,
    events: mpsc::Sender<Value>,
) {
    let mut chunk = [0_u8; 8 * 1024];
    let mut framer = BoundedLfFramer::new(MAX_RPC_RECORD_BYTES);
    loop {
        let count = match stdout.read(&mut chunk).await {
            Ok(count) => count,
            Err(error) => {
                manager.emit_runtime(
                    &project_id,
                    &runtime,
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
        for frame in framer.push(&chunk[..count]) {
            if !process_stdout_frame(&manager, &project_id, &runtime, &events, frame).await {
                return;
            }
        }
    }
    if let Some(frame) = framer.finish() {
        let _ = process_stdout_frame(&manager, &project_id, &runtime, &events, frame).await;
    }
}

async fn process_stdout_frame(
    manager: &Arc<ProjectManager>,
    project_id: &str,
    runtime: &Arc<ProjectRuntime>,
    events: &mpsc::Sender<Value>,
    frame: FramedLine,
) -> bool {
    let FramedLine::Line(buffer) = frame else {
        manager.emit_runtime(
            project_id,
            runtime,
            AppEventKind::ProtocolWarning {
                message: "Pi emitted an oversized protocol record".into(),
            },
        );
        return true;
    };
    let mut value = match serde_json::from_slice::<Value>(&buffer) {
        Ok(value) => value,
        Err(error) => {
            manager.emit_runtime(
                project_id,
                runtime,
                AppEventKind::ProtocolWarning {
                    message: format!("Pi emitted invalid JSON: {error}"),
                },
            );
            return true;
        }
    };

    if value.get("type").and_then(Value::as_str) == Some("response")
        && let Some(id) = value.get("id").and_then(Value::as_str)
        && let Some(sender) = runtime.pending.lock().await.remove(id)
    {
        let _ = sender.send(Ok(value));
        return true;
    }
    if value.get("type").and_then(Value::as_str) == Some("command_catalog_changed") {
        *runtime.command_catalog.lock() = None;
    }
    projection::project_event(&mut value);
    let settled = value.get("type").and_then(Value::as_str) == Some("agent_settled");
    if let Some(request_id) = overflowing_extension_request(runtime, &value) {
        let result = cancel_extension_request(runtime, &request_id).await;
        manager.emit_runtime(
            project_id,
            runtime,
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
        return true;
    }
    update_runtime_state(runtime, &value);
    let request_timeout = extension_request_timeout(&value);
    if events.send(value).await.is_err() {
        return false;
    }
    if let Some((request_id, timeout_ms)) = request_timeout {
        let manager = manager.clone();
        let project_id = project_id.to_owned();
        let runtime = runtime.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(timeout_ms)).await;
            if runtime.blocking_dialogs.lock().remove(&request_id) {
                manager.emit_runtime(
                    &project_id,
                    &runtime,
                    AppEventKind::ExtensionUiExpired { request_id },
                );
            }
        });
    }
    if settled {
        runtime.settled_signal.notify_one();
        if runtime.session_transition_pending.load(Ordering::Acquire) {
            return true;
        }
        let manager = manager.clone();
        let project_id = project_id.to_owned();
        let runtime = runtime.clone();
        let session_generation = runtime.session_switch_generation.load(Ordering::Acquire);
        tokio::spawn(async move {
            if let Err(error) = manager
                .refresh_settled_runtime(&project_id, runtime.clone(), session_generation)
                .await
            {
                manager.emit_runtime(
                    &project_id,
                    &runtime,
                    AppEventKind::ProtocolWarning {
                        message: format!("Unable to refresh the settled session: {error}"),
                    },
                );
            }
        });
    }
    true
}

async fn stderr_loop(runtime: Arc<ProjectRuntime>, mut stderr: tokio::process::ChildStderr) {
    let mut chunk = [0_u8; 8 * 1024];
    let mut framer = BoundedLfFramer::new(MAX_STDERR_LINE_BYTES);
    loop {
        let count = match stderr.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(count) => count,
        };
        for frame in framer.push(&chunk[..count]) {
            store_stderr_frame(&runtime, frame).await;
        }
    }
    if let Some(frame) = framer.finish() {
        store_stderr_frame(&runtime, frame).await;
    }
}

async fn store_stderr_frame(runtime: &ProjectRuntime, frame: FramedLine) {
    let line = match frame {
        FramedLine::Line(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        FramedLine::Oversized => "[oversized stderr line discarded]".into(),
    };
    let mut lines = runtime.stderr.lock().await;
    if lines.len() >= MAX_STDERR_LINES {
        lines.pop_front();
    }
    lines.push_back(line);
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
            runtime.clone(),
            status.and_then(|status| status.code()),
            runtime.expected_exit.load(Ordering::Relaxed),
        )
        .await;
}

async fn event_batch_loop(
    manager: Arc<ProjectManager>,
    project_id: String,
    runtime: Arc<ProjectRuntime>,
    mut receiver: mpsc::Receiver<Value>,
) {
    let mut ticker = interval(Duration::from_millis(33));
    ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut pending = Vec::<Value>::new();
    loop {
        tokio::select! {
            _ = ticker.tick() => flush_events(&manager, &project_id, &runtime, &mut pending),
            event = receiver.recv() => match event {
                Some(event) if is_high_frequency(&event) => merge_event(&mut pending, event),
                Some(event) => {
                    flush_events(&manager, &project_id, &runtime, &mut pending);
                    manager.emit_runtime(&project_id, &runtime, AppEventKind::PiEvent { event });
                }
                None => {
                    flush_events(&manager, &project_id, &runtime, &mut pending);
                    break;
                }
            }
        }
    }
}

fn flush_events(
    manager: &ProjectManager,
    project_id: &str,
    runtime: &ProjectRuntime,
    pending: &mut Vec<Value>,
) {
    if !pending.is_empty() {
        manager.emit_runtime(
            project_id,
            runtime,
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
            runtime.settled.store(false, Ordering::Release);
            runtime.touch();
        }
        Some("agent_settled") => {
            runtime.settled.store(true, Ordering::Release);
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

async fn stop_runtime_process(runtime: Arc<ProjectRuntime>) -> AppResult<()> {
    let termination = runtime.termination.lock().await.take();
    runtime.expected_exit.store(true, Ordering::Release);
    runtime.terminated.store(true, Ordering::Release);
    runtime.settled_signal.notify_one();
    let _ = runtime.control.send(ProcessControl::Stop).await;
    fail_pending(&runtime, "Pi was stopped").await;
    if let Some(termination) = termination
        && timeout(PROCESS_STOP_TIMEOUT, termination).await.is_err()
    {
        return Err(AppError::Message(format!(
            "Pi did not stop within {} seconds",
            PROCESS_STOP_TIMEOUT.as_secs()
        )));
    }
    Ok(())
}

fn rpc_reports_session_idle(runtime: &ProjectRuntime, response: &Value) -> bool {
    if !rpc_state_is_idle(response) {
        return false;
    }
    runtime.has_queue.store(false, Ordering::Release);
    runtime.blocking_dialogs.lock().clear();
    true
}

fn update_runtime_identity_from_response(runtime: &ProjectRuntime, response: &Value) {
    let Some(state) = response.get("data") else {
        return;
    };
    let session_id = state
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| runtime.session_id());
    let session_path = state
        .get("sessionFile")
        .and_then(Value::as_str)
        .map(normalize_windows_verbatim_path)
        .map(PathBuf::from)
        .or_else(|| runtime.session_path());
    runtime.set_session_identity(session_id, session_path);
}

fn rpc_state_is_idle(response: &Value) -> bool {
    let Some(state) = response.get("data") else {
        return false;
    };
    state.get("isStreaming").and_then(Value::as_bool) == Some(false)
        && state.get("isCompacting").and_then(Value::as_bool) != Some(true)
        && state
            .get("pendingMessageCount")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            == 0
}

async fn wait_for_rpc_response(
    pending: &Mutex<HashMap<String, oneshot::Sender<AppResult<Value>>>>,
    id: &str,
    receiver: oneshot::Receiver<AppResult<Value>>,
    wait: Duration,
) -> AppResult<Value> {
    match timeout(wait, receiver).await {
        Ok(Ok(response)) => response,
        Ok(Err(_)) => {
            pending.lock().await.remove(id);
            Err(AppError::Message("Pi response channel closed".into()))
        }
        Err(_) => {
            pending.lock().await.remove(id);
            Err(AppError::Timeout)
        }
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

fn normalize_windows_verbatim_path(path: &str) -> String {
    if let Some(path) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{path}")
    } else if let Some(path) = path.strip_prefix(r"\\?\") {
        path.to_owned()
    } else {
        path.to_owned()
    }
}

fn same_session_path(left: &Path, right: &Path) -> bool {
    match (std::fs::canonicalize(left), std::fs::canonicalize(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => normalize_windows_verbatim_path(&left.to_string_lossy())
            .eq_ignore_ascii_case(&normalize_windows_verbatim_path(&right.to_string_lossy())),
    }
}

fn array_field(value: Option<&Value>, field: &str) -> Vec<Value> {
    value
        .and_then(|value| value.get(field))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn is_unknown_command(error: &AppError, command: &str) -> bool {
    matches!(error, AppError::Message(message) if message == &format!("Unknown command: {command}"))
}

fn encode_image(path: &Path) -> AppResult<Value> {
    let mut file = std::fs::File::open(path)?;
    let metadata = file.metadata()?;
    if metadata.len() > MAX_IMAGE_BYTES {
        return Err(AppError::Message("Images must be 20 MB or smaller".into()));
    }
    let mime = mime_guess::from_path(path)
        .first_raw()
        .filter(|mime| mime.starts_with("image/"))
        .ok_or_else(|| AppError::Message("Only image attachments are supported".into()))?;
    let mut bytes = Vec::with_capacity(metadata.len().try_into().unwrap_or(0));
    let mut limited = StdRead::take(&mut file, MAX_IMAGE_BYTES + 1);
    StdRead::read_to_end(&mut limited, &mut bytes)?;
    if bytes.len() as u64 > MAX_IMAGE_BYTES {
        return Err(AppError::Message("Images must be 20 MB or smaller".into()));
    }
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
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
    use std::{
        collections::HashMap,
        sync::{Arc, atomic::Ordering},
        time::Duration,
    };

    use serde_json::json;
    use tokio::sync::{Mutex, oneshot};

    use crate::{
        config::ConfigStore,
        credentials::CredentialStore,
        error::AppError,
        models::{AppConfig, AppSettings, ProjectRecord},
    };

    use super::{
        BoundedLfFramer, FramedLine, ProjectManager, is_high_frequency, is_unknown_command,
        merge_event, normalize_windows_verbatim_path, object, same_session_path,
        wait_for_rpc_response,
    };

    #[test]
    fn normalizes_windows_verbatim_session_paths_for_the_frontend() {
        assert_eq!(
            normalize_windows_verbatim_path(r"\\?\C:\Users\pi\session.jsonl"),
            r"C:\Users\pi\session.jsonl"
        );
        assert_eq!(
            normalize_windows_verbatim_path(r"\\?\UNC\server\share\session.jsonl"),
            r"\\server\share\session.jsonl"
        );
    }

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

    #[test]
    fn frames_fragmented_utf8_and_lf_or_crlf_records() {
        let mut framer = BoundedLfFramer::new(128);
        assert!(framer.push(b"{\"text\":\"a\xE2").is_empty());
        let frames = framer.push(b"\x80\xA8b\"}\r\n{\"ok\":true}\n");
        assert_eq!(frames.len(), 2);
        let FramedLine::Line(first) = &frames[0] else {
            panic!("expected a record");
        };
        let first: serde_json::Value = serde_json::from_slice(first).unwrap();
        assert_eq!(first["text"], "a\u{2028}b");
        let FramedLine::Line(second) = &frames[1] else {
            panic!("expected a record");
        };
        let second: serde_json::Value = serde_json::from_slice(second).unwrap();
        assert_eq!(second["ok"], true);
    }

    #[test]
    fn discards_oversized_records_and_resumes_at_the_next_lf() {
        let mut framer = BoundedLfFramer::new(4);
        assert_eq!(
            framer.push(b"12345\nok\n"),
            vec![FramedLine::Oversized, FramedLine::Line(b"ok".to_vec())]
        );
        assert!(framer.finish().is_none());
    }

    #[tokio::test]
    async fn removes_pending_rpc_entries_after_timeout() {
        let pending = Mutex::new(HashMap::new());
        let (sender, receiver) = oneshot::channel();
        pending.lock().await.insert("request".into(), sender);

        let result =
            wait_for_rpc_response(&pending, "request", receiver, Duration::from_millis(1)).await;

        assert!(matches!(result, Err(AppError::Timeout)));
        assert!(pending.lock().await.is_empty());
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn correlates_fake_pi_responses_and_stops_the_process_tree() {
        let directory = tempfile::tempdir().unwrap();
        let script = directory.path().join("fake-pi.ps1");
        let executable = directory.path().join("fake-pi.cmd");
        std::fs::write(
            &script,
            r#"$ErrorActionPreference = 'Stop'
$streaming = $false
$sessionFile = $null
for ($index = 0; $index -lt $args.Count - 1; $index++) {
  if ($args[$index] -eq '--session') { $sessionFile = $args[$index + 1] }
}
$sessionId = if ($sessionFile) { [IO.Path]::GetFileNameWithoutExtension($sessionFile) } else { "new-$PID" }
while (($line = [Console]::In.ReadLine()) -ne $null) {
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  $request = $line | ConvertFrom-Json
  if ($request.type -eq 'prompt' -and $request.message -ne '/extension-command') {
    $streaming = $true
  } elseif ($request.type -eq 'new_session') {
    $streaming = $false
    $sessionFile = $null
    $sessionId = "new-$PID"
  } elseif ($request.type -eq 'switch_session') {
    $streaming = $false
    $sessionFile = $request.sessionPath
    $sessionId = [IO.Path]::GetFileNameWithoutExtension($sessionFile)
  }
  $response = [ordered]@{
    type = 'response'
    id = $request.id
    success = $true
    data = @{
      command = $request.type
      models = @()
      commands = @()
      messages = @()
      sessionId = $sessionId
      sessionFile = $sessionFile
      isStreaming = $streaming
      isCompacting = $false
      pendingMessageCount = 0
    }
  }
  [Console]::Out.WriteLine(($response | ConvertTo-Json -Compress -Depth 8))
  [Console]::Out.Flush()
}
"#,
        )
        .unwrap();
        std::fs::write(
            &executable,
            "@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File \"%~dp0fake-pi.ps1\" %*\r\n",
        )
        .unwrap();
        let session_directory = directory.path().join("sessions");
        std::fs::create_dir_all(directory.path().join(".pi")).unwrap();
        std::fs::create_dir_all(&session_directory).unwrap();
        std::fs::write(
            directory.path().join(".pi/settings.json"),
            format!(
                r#"{{"sessionDir":{}}}"#,
                serde_json::to_string(&session_directory).unwrap()
            ),
        )
        .unwrap();
        let parallel_session = session_directory.join("parallel.jsonl");
        std::fs::write(
            &parallel_session,
            r#"{"type":"session","id":"parallel","timestamp":"2026-07-24T00:00:00Z"}
"#,
        )
        .unwrap();
        let project = ProjectRecord {
            id: "project".into(),
            name: "Fake".into(),
            path: directory.path().to_path_buf(),
            trusted: true,
            active_session: None,
            created_at: String::new(),
            last_opened_at: String::new(),
        };
        let config = Arc::new(ConfigStore::for_test(
            directory.path().join("config.json"),
            AppConfig {
                settings: AppSettings {
                    pi_path: Some(executable),
                    ..AppSettings::default()
                },
                projects: vec![project],
                ..AppConfig::default()
            },
        ));
        let manager = ProjectManager::new(config, Arc::new(CredentialStore));

        manager.start_project("project").await.unwrap();
        let (first, second) = tokio::join!(
            manager.rpc("project", object("first")),
            manager.rpc("project", object("second"))
        );

        assert_eq!(first.unwrap().pointer("/data/command").unwrap(), "first");
        assert_eq!(second.unwrap().pointer("/data/command").unwrap(), "second");
        manager
            .send_prompt("project", "prompt", "/extension-command".into(), Vec::new())
            .await
            .unwrap();
        let runtime = manager
            .runtimes
            .read()
            .await
            .get("project")
            .cloned()
            .unwrap();
        assert!(runtime.settled.load(Ordering::Acquire));
        runtime.settled.store(false, Ordering::Release);
        runtime.has_queue.store(true, Ordering::Release);
        runtime.blocking_dialogs.lock().insert("stale".into());
        tokio::time::timeout(Duration::from_secs(1), manager.new_session("project"))
            .await
            .expect("idle state reconciliation should not leave the transition waiting")
            .unwrap();
        assert!(!runtime.has_queue.load(Ordering::Acquire));
        assert!(runtime.blocking_dialogs.lock().is_empty());

        manager
            .send_prompt("project", "prompt", "keep working".into(), Vec::new())
            .await
            .unwrap();
        assert!(!runtime.settled.load(Ordering::Acquire));
        let working_session = session_directory.join("working.jsonl");
        std::fs::write(
            &working_session,
            r#"{"type":"session","id":"working","timestamp":"2026-07-24T00:00:00Z"}
"#,
        )
        .unwrap();
        runtime.set_session_identity(Some("working".into()), Some(working_session.clone()));
        tokio::time::timeout(
            Duration::from_secs(1),
            manager.open_session("project", &parallel_session),
        )
        .await
        .expect("a busy chat should be detached instead of blocking the session switch")
        .unwrap();
        let active = manager.active_runtime("project").await.unwrap();
        assert_ne!(active.token, runtime.token);
        assert!(
            active
                .session_path()
                .is_some_and(|path| same_session_path(&path, &parallel_session))
        );
        assert!(
            manager
                .background_runtimes
                .read()
                .await
                .get("project")
                .is_some_and(|runtimes| runtimes.contains_key(&runtime.token))
        );
        tokio::time::timeout(
            Duration::from_secs(1),
            manager.open_session("project", &working_session),
        )
        .await
        .expect("reopening a working background chat should promote its existing process")
        .unwrap();
        assert_eq!(
            manager.active_runtime("project").await.unwrap().token,
            runtime.token
        );
        manager.stop_project("project").await.unwrap();
        assert!(!manager.is_running("project").await);
    }

    #[test]
    fn recognizes_only_the_expected_unknown_catalog_response() {
        assert!(is_unknown_command(
            &AppError::Message("Unknown command: get_command_catalog".into()),
            "get_command_catalog"
        ));
        assert!(!is_unknown_command(
            &AppError::Message("Catalog failed".into()),
            "get_command_catalog"
        ));
    }
}
