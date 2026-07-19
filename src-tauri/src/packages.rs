use std::{
    collections::HashMap,
    path::Path,
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use tauri::ipc::Channel;
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::{Child, Command},
    sync::{Mutex, mpsc},
    time::timeout,
};
use uuid::Uuid;

use crate::{
    catalog::PackageCatalog,
    config::ConfigStore,
    diagnostics::{command_for, resolve_pi},
    error::{AppError, AppResult},
    manager::ProjectManager,
    models::{
        PackageCatalogPage, PackageCatalogQuery, PackageOperationKind, PackageOperationRequest,
        PackageOperationResult, PackageProgress, PackageScope, PiPackageRecord, ProjectRecord,
    },
    windows_job::JobGuard,
};

const PACKAGE_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const MAX_CAPTURE_BYTES: usize = 1024 * 1024;
const MAX_PROGRESS_LINES: usize = 200;
const MAX_PROGRESS_LINE_BYTES: usize = 4096;
const MAX_SOURCE_BYTES: usize = 4096;

pub struct PiPackageManager {
    config: Arc<ConfigStore>,
    catalog: PackageCatalog,
    operation_lock: Mutex<()>,
    cancellations: Mutex<HashMap<String, mpsc::Sender<()>>>,
}

impl PiPackageManager {
    pub fn new(config: Arc<ConfigStore>) -> Arc<Self> {
        Arc::new(Self {
            config,
            catalog: PackageCatalog::new(),
            operation_lock: Mutex::new(()),
            cancellations: Mutex::new(HashMap::new()),
        })
    }

    pub async fn list(&self, project_id: &str) -> AppResult<Vec<PiPackageRecord>> {
        let _guard = self.operation_lock.lock().await;
        self.list_unlocked(project_id).await
    }

    pub async fn browse_catalog(
        &self,
        query: PackageCatalogQuery,
    ) -> AppResult<PackageCatalogPage> {
        self.catalog.browse(query).await
    }

    async fn list_unlocked(&self, project_id: &str) -> AppResult<Vec<PiPackageRecord>> {
        let project = self.project(project_id)?;
        let args = vec!["list".to_owned(), trust_arg(project.trusted).to_owned()];
        let output = self.run_process(&project, &args, None, None).await?;
        if output.stdout_truncated {
            return Err(AppError::Message(
                "Pi package list exceeded the supported output limit. Use Pi config until the list is smaller."
                    .into(),
            ));
        }
        parse_package_list(&output.stdout)
    }

    pub async fn run_operation(
        self: &Arc<Self>,
        manager: Arc<ProjectManager>,
        project_id: String,
        request: PackageOperationRequest,
        progress: Channel<PackageProgress>,
    ) -> AppResult<PackageOperationResult> {
        let _guard = self.operation_lock.lock().await;
        let project = self.project(&project_id)?;
        let source = request.source.as_deref().map(validate_source).transpose()?;
        let scope = request.scope;

        match request.kind {
            PackageOperationKind::Install | PackageOperationKind::Remove => {
                if scope.is_none() || source.is_none() {
                    return Err(AppError::Message(
                        "A package source and scope are required".into(),
                    ));
                }
            }
            PackageOperationKind::Update => {
                if scope.is_none() || source.is_none() {
                    return Err(AppError::Message(
                        "A package source and scope are required".into(),
                    ));
                }
            }
            PackageOperationKind::UpdateAll => {
                if scope.is_some() || source.is_some() {
                    return Err(AppError::Message(
                        "Update all does not accept a package source or scope".into(),
                    ));
                }
            }
        }
        if scope == Some(PackageScope::Project) && !project.trusted {
            return Err(AppError::Message(
                "Trust this project before changing project-local Pi packages".into(),
            ));
        }

        let configured = self.list_unlocked(&project_id).await?;
        if matches!(
            request.kind,
            PackageOperationKind::Remove | PackageOperationKind::Update
        ) && !configured.iter().any(|package| {
            Some(package.scope) == scope && Some(package.source.as_str()) == source.as_deref()
        }) {
            return Err(AppError::Message(
                "The selected package is no longer configured in that scope".into(),
            ));
        }

        let affects_all = scope == Some(PackageScope::User)
            || matches!(request.kind, PackageOperationKind::UpdateAll);
        let targets = manager
            .quiesce_for_package_change((!affects_all).then_some(project_id.as_str()))
            .await?;

        let operation_id = Uuid::new_v4().to_string();
        let _ = progress.send(PackageProgress {
            operation_id: operation_id.clone(),
            phase: "started".into(),
            message: operation_message(&request.kind, source.as_deref()),
        });
        let (cancel_tx, cancel_rx) = mpsc::channel(1);
        self.cancellations
            .lock()
            .await
            .insert(operation_id.clone(), cancel_tx);

        let approve_project = match request.kind {
            PackageOperationKind::UpdateAll => project.trusted,
            _ => scope == Some(PackageScope::Project) && project.trusted,
        };
        let args = operation_args(&request.kind, source.as_deref(), scope, approve_project);
        let process_result = self
            .run_process(
                &project,
                &args,
                Some((operation_id.clone(), progress.clone())),
                Some(cancel_rx),
            )
            .await;
        self.cancellations.lock().await.remove(&operation_id);

        let _ = progress.send(PackageProgress {
            operation_id: operation_id.clone(),
            phase: "restarting".into(),
            message: "Reloading affected Pi projects".into(),
        });
        let warnings = manager.restore_quiesced_projects(&targets).await;

        if let Err(error) = process_result {
            return Err(if warnings.is_empty() {
                error
            } else {
                AppError::Message(format!("{error}. {}", warnings.join(" ")))
            });
        }

        let packages = self.list_unlocked(&project_id).await?;
        let _ = progress.send(PackageProgress {
            operation_id,
            phase: "complete".into(),
            message: "Pi packages refreshed".into(),
        });
        Ok(PackageOperationResult {
            packages,
            restarted_project_ids: targets,
            warnings,
        })
    }

    pub async fn cancel(&self, operation_id: &str) -> bool {
        let sender = self.cancellations.lock().await.get(operation_id).cloned();
        if let Some(sender) = sender {
            sender.send(()).await.is_ok()
        } else {
            false
        }
    }

    pub async fn reload_resources(
        &self,
        manager: Arc<ProjectManager>,
        project_id: &str,
    ) -> AppResult<Vec<String>> {
        let _guard = self.operation_lock.lock().await;
        self.project(project_id)?;
        let targets = manager.quiesce_for_package_change(None).await?;
        let warnings = manager.restore_quiesced_projects(&targets).await;
        if warnings.is_empty() {
            Ok(targets)
        } else {
            Err(AppError::Message(warnings.join(" ")))
        }
    }

    pub fn open_config(&self, project_id: &str, scope: PackageScope) -> AppResult<()> {
        let project = self.project(project_id)?;
        if scope == PackageScope::Project && !project.trusted {
            return Err(AppError::Message(
                "Trust this project before configuring project-local resources".into(),
            ));
        }
        let pi = resolve_pi(self.config.settings().pi_path)
            .ok_or_else(|| AppError::Message("Pi is not installed".into()))?;
        let args = config_args(scope, project.trusted);

        #[cfg(windows)]
        {
            let mut command = if let Ok(terminal) = which::which("wt.exe") {
                let mut command = std::process::Command::new(terminal);
                command.arg("-d").arg(&project.path).arg(&pi);
                command
            } else {
                let mut command = std::process::Command::new("cmd.exe");
                command
                    .arg("/D")
                    .arg("/K")
                    .arg(&pi)
                    .current_dir(&project.path);
                command
            };
            command
                .args(args)
                .env("PI_SKIP_VERSION_CHECK", "1")
                .env("PI_TELEMETRY", "0")
                .spawn()?;
            Ok(())
        }
        #[cfg(not(windows))]
        {
            let _ = (pi, args);
            Err(AppError::Message(
                "Pi package configuration is implemented for Windows in v1".into(),
            ))
        }
    }

    fn project(&self, project_id: &str) -> AppResult<ProjectRecord> {
        self.config
            .project(project_id)
            .ok_or(AppError::ProjectNotFound)
    }

    async fn run_process(
        &self,
        project: &ProjectRecord,
        args: &[String],
        progress: Option<(String, Channel<PackageProgress>)>,
        cancellation: Option<mpsc::Receiver<()>>,
    ) -> AppResult<ProcessOutput> {
        let pi = resolve_pi(self.config.settings().pi_path)
            .ok_or_else(|| AppError::Message("Pi is not installed".into()))?;
        let mut base = command_for(&pi);
        base.current_dir(&project.path)
            .args(args)
            .env("PI_SKIP_VERSION_CHECK", "1")
            .env("PI_TELEMETRY", "0")
            .env("NO_COLOR", "1")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env(
                "GIT_SSH_COMMAND",
                "ssh -o BatchMode=yes -o ConnectTimeout=5",
            )
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
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
                    "Unable to secure the Pi package process tree: {error}"
                )));
            }
        };
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AppError::Message("Pi package stdout is unavailable".into()))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| AppError::Message("Pi package stderr is unavailable".into()))?;
        let progress_lines = Arc::new(AtomicUsize::new(0));
        let stdout_progress = progress.clone();
        let stderr_progress = progress;
        let stdout_task =
            tokio::spawn(read_stream(stdout, stdout_progress, progress_lines.clone()));
        let stderr_task = tokio::spawn(read_stream(stderr, stderr_progress, progress_lines));

        let status = wait_for_process(&mut child, cancellation).await;
        drop(job);
        let stdout = stdout_task.await.unwrap_or_default();
        let stderr = stderr_task.await.unwrap_or_default();
        let status = status?;
        if !status.success() {
            let detail = if stderr.text.trim().is_empty() {
                stdout.text.trim()
            } else {
                stderr.text.trim()
            };
            return Err(AppError::Message(if detail.is_empty() {
                format!("Pi package command failed with {status}")
            } else {
                format!("Pi package command failed: {}", redact_output(detail))
            }));
        }
        Ok(ProcessOutput {
            stdout: stdout.text,
            stdout_truncated: stdout.truncated,
        })
    }
}

struct ProcessOutput {
    stdout: String,
    stdout_truncated: bool,
}

#[derive(Default)]
struct CapturedStream {
    text: String,
    truncated: bool,
}

async fn wait_for_process(
    child: &mut Child,
    cancellation: Option<mpsc::Receiver<()>>,
) -> AppResult<std::process::ExitStatus> {
    let wait = async {
        if let Some(mut cancellation) = cancellation {
            tokio::select! {
                status = child.wait() => status.map_err(AppError::Io),
                _ = cancellation.recv() => {
                    let _ = child.kill().await;
                    let _ = child.wait().await;
                    Err(AppError::Message("Package operation cancelled".into()))
                }
            }
        } else {
            child.wait().await.map_err(AppError::Io)
        }
    };
    match timeout(PACKAGE_TIMEOUT, wait).await {
        Ok(result) => result,
        Err(_) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            Err(AppError::Message(
                "Pi package command timed out after 15 minutes".into(),
            ))
        }
    }
}

async fn read_stream<R>(
    stream: R,
    progress: Option<(String, Channel<PackageProgress>)>,
    progress_lines: Arc<AtomicUsize>,
) -> CapturedStream
where
    R: AsyncRead + Unpin,
{
    let mut reader = stream;
    let mut chunk = [0_u8; 8192];
    let mut line = Vec::with_capacity(256);
    let mut output = Vec::new();
    let mut truncated = false;
    while let Ok(count) = reader.read(&mut chunk).await {
        if count == 0 {
            break;
        }
        let remaining = MAX_CAPTURE_BYTES.saturating_sub(output.len());
        output.extend_from_slice(&chunk[..count.min(remaining)]);
        truncated |= count > remaining;
        for byte in &chunk[..count] {
            if *byte == b'\n' {
                emit_progress_line(&line, progress.as_ref(), &progress_lines);
                line.clear();
            } else if line.len() < MAX_PROGRESS_LINE_BYTES {
                line.push(*byte);
            }
        }
    }
    if !line.is_empty() {
        emit_progress_line(&line, progress.as_ref(), &progress_lines);
    }
    CapturedStream {
        text: String::from_utf8_lossy(&output).into_owned(),
        truncated,
    }
}

fn emit_progress_line(
    line: &[u8],
    progress: Option<&(String, Channel<PackageProgress>)>,
    progress_lines: &AtomicUsize,
) {
    let Some((operation_id, channel)) = progress else {
        return;
    };
    let text = String::from_utf8_lossy(line);
    let text = redact_output(text.trim_end_matches('\r').trim());
    if !text.is_empty() && progress_lines.fetch_add(1, Ordering::Relaxed) < MAX_PROGRESS_LINES {
        let _ = channel.send(PackageProgress {
            operation_id: operation_id.clone(),
            phase: "output".into(),
            message: text,
        });
    }
}

fn trust_arg(trusted: bool) -> &'static str {
    if trusted { "--approve" } else { "--no-approve" }
}

fn operation_args(
    kind: &PackageOperationKind,
    source: Option<&str>,
    scope: Option<PackageScope>,
    trusted: bool,
) -> Vec<String> {
    let mut args = match kind {
        PackageOperationKind::Install => vec!["install".into(), source.unwrap_or_default().into()],
        PackageOperationKind::Remove => vec!["remove".into(), source.unwrap_or_default().into()],
        PackageOperationKind::Update => vec![
            "update".into(),
            "--extension".into(),
            source.unwrap_or_default().into(),
        ],
        PackageOperationKind::UpdateAll => vec!["update".into(), "--extensions".into()],
    };
    if matches!(
        kind,
        PackageOperationKind::Install | PackageOperationKind::Remove
    ) && scope == Some(PackageScope::Project)
    {
        args.push("-l".into());
    }
    args.push(trust_arg(trusted).into());
    args
}

fn config_args(scope: PackageScope, trusted: bool) -> Vec<String> {
    let mut args = vec!["config".to_owned()];
    if scope == PackageScope::Project {
        args.push("-l".into());
    }
    args.push(trust_arg(scope == PackageScope::Project && trusted).into());
    args
}

fn operation_message(kind: &PackageOperationKind, source: Option<&str>) -> String {
    match kind {
        PackageOperationKind::Install => format!("Installing {}", source.unwrap_or("package")),
        PackageOperationKind::Remove => format!("Removing {}", source.unwrap_or("package")),
        PackageOperationKind::Update => format!("Updating {}", source.unwrap_or("package")),
        PackageOperationKind::UpdateAll => "Updating installed Pi packages".into(),
    }
}

fn validate_source(source: &str) -> AppResult<String> {
    let source = source.trim();
    if source.is_empty() {
        return Err(AppError::Message("Enter a Pi package source".into()));
    }
    if source.len() > MAX_SOURCE_BYTES {
        return Err(AppError::Message("The package source is too long".into()));
    }
    if source.starts_with('-') || source.chars().any(char::is_control) {
        return Err(AppError::Message("The package source is invalid".into()));
    }
    let lower = source.to_ascii_lowercase();
    let normalized = lower.strip_prefix("git:").unwrap_or(lower.as_str());
    let http = normalized
        .strip_prefix("https://")
        .or_else(|| normalized.strip_prefix("http://"));
    if let Some(rest) = http {
        let authority = rest.split('/').next().unwrap_or_default();
        if authority.contains('@') {
            return Err(AppError::Message(
                "Do not embed credentials in package URLs; use Git or npm credential helpers"
                    .into(),
            ));
        }
    }
    if let Some(rest) = normalized
        .strip_prefix("ssh://")
        .or_else(|| normalized.strip_prefix("git://"))
    {
        let user_info = rest
            .split('/')
            .next()
            .unwrap_or_default()
            .split_once('@')
            .map(|(user_info, _)| user_info);
        if user_info.is_some_and(|value| value.contains(':')) {
            return Err(AppError::Message(
                "Do not embed credentials in package URLs; use configured SSH keys".into(),
            ));
        }
    }
    if ["token=", "password=", "access_token=", "api_key="]
        .iter()
        .any(|needle| lower.contains(needle))
    {
        return Err(AppError::Message(
            "Do not embed credentials in package URLs".into(),
        ));
    }
    Ok(source.to_owned())
}

fn parse_package_list(output: &str) -> AppResult<Vec<PiPackageRecord>> {
    let output = strip_ansi(output);
    if output
        .lines()
        .any(|line| line.trim() == "No packages installed.")
    {
        return Ok(Vec::new());
    }
    let mut scope = None;
    let mut packages: Vec<PiPackageRecord> = Vec::new();
    let mut saw_header = false;
    for line in output.lines() {
        let trimmed = line.trim();
        match trimmed {
            "User packages:" => {
                scope = Some(PackageScope::User);
                saw_header = true;
                continue;
            }
            "Project packages:" => {
                scope = Some(PackageScope::Project);
                saw_header = true;
                continue;
            }
            "" => continue,
            _ => {}
        }
        let Some(current_scope) = scope else {
            continue;
        };
        let indentation = line.len().saturating_sub(line.trim_start().len());
        if indentation >= 4 {
            if let Some(package) = packages.last_mut()
                && package.scope == current_scope
            {
                package.installed_path = Some(Path::new(trimmed).to_path_buf());
            }
        } else if indentation >= 2 {
            let filtered = trimmed.ends_with(" (filtered)");
            let source = trimmed
                .strip_suffix(" (filtered)")
                .unwrap_or(trimmed)
                .to_owned();
            packages.push(PiPackageRecord {
                source,
                scope: current_scope,
                installed_path: None,
                filtered,
            });
        }
    }
    if !saw_header {
        return Err(AppError::Message(
            "Pi returned an unrecognized package list. Use Pi config until Pi Desktop is updated."
                .into(),
        ));
    }
    Ok(packages)
}

fn strip_ansi(value: &str) -> String {
    let mut result = String::with_capacity(value.len());
    let mut chars = value.chars().peekable();
    while let Some(char) = chars.next() {
        if char == '\u{1b}' && chars.peek() == Some(&'[') {
            chars.next();
            for next in chars.by_ref() {
                if ('@'..='~').contains(&next) {
                    break;
                }
            }
        } else {
            result.push(char);
        }
    }
    result
}

fn redact_output(value: &str) -> String {
    value
        .split_whitespace()
        .map(|part| {
            let lower = part.to_ascii_lowercase();
            if [
                "token=",
                "password=",
                "access_token=",
                "api_key=",
                "secret=",
            ]
            .iter()
            .any(|needle| lower.contains(needle))
            {
                "[redacted-value]"
            } else if (part.starts_with("http://") || part.starts_with("https://"))
                && part.split_once("://").is_some_and(|(_, rest)| {
                    rest.split('/').next().unwrap_or_default().contains('@')
                })
            {
                "[redacted-url]"
            } else {
                part
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, atomic::AtomicUsize};

    use tokio::io::{AsyncWriteExt, duplex};

    use super::{
        MAX_CAPTURE_BYTES, config_args, operation_args, parse_package_list, read_stream,
        redact_output, validate_source,
    };
    use crate::models::{PackageOperationKind, PackageScope};

    #[cfg(windows)]
    use crate::{
        config::ConfigStore,
        models::{AppConfig, AppSettings, ProjectRecord},
    };

    #[test]
    fn parses_user_and_project_packages() {
        let packages = parse_package_list(
            "User packages:\r\n  npm:one\r\n    C:\\Users\\me\\one\r\n\r\nProject packages:\r\n  git:github.com/me/two (filtered)\r\n    D:\\repo\\.pi\\git\\two\r\n",
        )
        .unwrap();
        assert_eq!(packages.len(), 2);
        assert_eq!(packages[0].scope, PackageScope::User);
        assert_eq!(packages[0].source, "npm:one");
        assert_eq!(packages[1].scope, PackageScope::Project);
        assert!(packages[1].filtered);
    }

    #[test]
    fn handles_empty_and_rejects_unknown_lists() {
        assert!(
            parse_package_list("No packages installed.\n")
                .unwrap()
                .is_empty()
        );
        assert!(parse_package_list("Packages changed format\n").is_err());
    }

    #[test]
    fn validates_sources_without_blocking_ssh_usernames() {
        assert!(validate_source("npm:@scope/pkg").is_ok());
        assert!(validate_source("git:git@github.com:user/repo").is_ok());
        assert!(validate_source("ssh://git@github.com/user/repo").is_ok());
        assert!(validate_source("ssh://git:secret@github.com/user/repo").is_err());
        assert!(validate_source("https://token@github.com/user/repo").is_err());
        assert!(validate_source("--extension").is_err());
        assert!(validate_source("npm:pkg\n--force").is_err());
    }

    #[test]
    fn builds_scope_specific_commands_with_explicit_trust() {
        assert_eq!(
            operation_args(
                &PackageOperationKind::Install,
                Some("npm:one"),
                Some(PackageScope::User),
                false,
            ),
            ["install", "npm:one", "--no-approve"]
        );
        assert_eq!(
            operation_args(
                &PackageOperationKind::Install,
                Some(".\\local"),
                Some(PackageScope::Project),
                true,
            ),
            ["install", ".\\local", "-l", "--approve"]
        );
        assert_eq!(
            operation_args(
                &PackageOperationKind::Update,
                Some("git:host/repo"),
                Some(PackageScope::Project),
                true,
            ),
            ["update", "--extension", "git:host/repo", "--approve"]
        );
        assert_eq!(
            operation_args(&PackageOperationKind::UpdateAll, None, None, true),
            ["update", "--extensions", "--approve"]
        );
        assert_eq!(
            config_args(PackageScope::User, true),
            ["config", "--no-approve"]
        );
        assert_eq!(
            config_args(PackageScope::Project, true),
            ["config", "-l", "--approve"]
        );
    }

    #[test]
    fn redacts_credentials_from_process_output() {
        assert_eq!(
            redact_output("failed https://user:secret@example.com/repo"),
            "failed [redacted-url]"
        );
        assert_eq!(
            redact_output("failed https://example.com/repo?token=secret"),
            "failed [redacted-value]"
        );
    }

    #[tokio::test]
    async fn bounds_capture_and_single_line_progress_memory() {
        let (mut writer, reader) = duplex(8192);
        let writer_task = tokio::spawn(async move {
            let chunk = vec![b'x'; 8192];
            for _ in 0..((MAX_CAPTURE_BYTES / chunk.len()) + 4) {
                writer.write_all(&chunk).await.unwrap();
            }
            writer.shutdown().await.unwrap();
        });
        let captured = read_stream(reader, None, Arc::new(AtomicUsize::new(0))).await;
        writer_task.await.unwrap();
        assert_eq!(captured.text.len(), MAX_CAPTURE_BYTES);
        assert!(captured.truncated);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn invokes_fake_pi_with_project_cwd_and_trust_flag() {
        let directory = tempfile::tempdir().unwrap();
        let executable = directory.path().join("fake-pi.cmd");
        std::fs::write(
            &executable,
            "@echo off\r\n> \"%CD%\\invocation.txt\" echo %CD%^|%*\r\nping -n 2 127.0.0.1 > nul\r\nif \"%1\"==\"list\" (\r\n  echo User packages:\r\n  echo   npm:fake\r\n  echo     C:\\fake\\npm\\fake\r\n)\r\n",
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
        let packages = super::PiPackageManager::new(config)
            .list("project")
            .await
            .unwrap();

        assert_eq!(packages.len(), 1);
        assert_eq!(packages[0].source, "npm:fake");
        let invocation = std::fs::read_to_string(directory.path().join("invocation.txt")).unwrap();
        assert!(invocation.contains(directory.path().to_string_lossy().as_ref()));
        assert!(invocation.contains("list --approve"));
    }
}
