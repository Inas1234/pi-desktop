import { Channel, invoke, isTauri } from "@tauri-apps/api/core";

import type {
  AppEvent,
  AppSettings,
  BootstrapState,
  PackageCatalogPage,
  PackageCatalogQuery,
  PackageOperationRequest,
  PackageOperationResult,
  PackageProgress,
  PackageScope,
  PiEnvironmentReport,
  PiModel,
  PiPackageRecord,
  ProjectRecord,
  ProviderCredentialStatus,
  SessionPage,
  SessionSummary,
} from "@/lib/types";

export type EventHandler = (event: AppEvent) => void;

const previewBootstrap: BootstrapState = {
  settings: {
    theme: "system",
    idleTimeoutMinutes: 10,
    sidebarCollapsed: false,
    piPath: null,
    activeProjectId: null,
    showReasoning: true,
  },
  projects: [],
  environment: {
    status: "preview",
    path: null,
    version: null,
    compatible: false,
    nodePath: null,
    message: "Run through Tauri to connect to Pi.",
  },
  providers: [],
  dismissedNotificationKeys: [],
};

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw new Error("This action is available in the desktop app");
  return invoke<T>(command, args);
}

export const desktop = {
  async initialize(onEvent: EventHandler): Promise<BootstrapState> {
    if (!isTauri()) return previewBootstrap;
    const channel = new Channel<AppEvent>();
    channel.onmessage = onEvent;
    return invoke<BootstrapState>("initialize", { onEvent: channel });
  },
  diagnosePi: () => call<PiEnvironmentReport>("diagnose_pi"),
  addProject: (path: string, trusted: boolean) =>
    call<ProjectRecord>("add_project", { path, trusted }),
  removeProject: (projectId: string) => call<void>("remove_project", { projectId }),
  updateProjectTrust: (projectId: string, trusted: boolean) =>
    call<ProjectRecord>("update_project_trust", { projectId, trusted }),
  activateProject: (projectId: string) => call<void>("activate_project", { projectId }),
  restartProject: (projectId: string) => call<void>("restart_project", { projectId }),
  stopProject: (projectId: string) => call<void>("stop_project", { projectId }),
  listSessions: (projectId: string, query?: string) =>
    call<SessionSummary[]>("list_sessions", { projectId, query: query || null }),
  openSession: (projectId: string, sessionPath: string) =>
    call<void>("open_session", { projectId, sessionPath }),
  newSession: (projectId: string) => call<void>("new_session", { projectId }),
  renameSession: (projectId: string, name: string) =>
    call<void>("rename_session", { projectId, name }),
  trashSession: (projectId: string, sessionPath: string) =>
    call<void>("trash_session", { projectId, sessionPath }),
  loadSessionPage: (projectId: string, before: string | null, limit = 100) =>
    call<SessionPage>("load_session_page", { projectId, before, limit }),
  sendPrompt: (projectId: string, text: string, paths: string[]) =>
    call<void>("send_prompt", { projectId, text, images: paths.map((path) => ({ path })) }),
  steer: (projectId: string, text: string, paths: string[]) =>
    call<void>("steer", { projectId, text, images: paths.map((path) => ({ path })) }),
  followUp: (projectId: string, text: string, paths: string[]) =>
    call<void>("follow_up", { projectId, text, images: paths.map((path) => ({ path })) }),
  abort: (projectId: string) => call<void>("abort", { projectId }),
  listModels: (projectId: string) => call<PiModel[]>("list_models", { projectId }),
  setModel: (projectId: string, provider: string, modelId: string) =>
    call<void>("set_model", { projectId, provider, modelId }),
  setThinkingLevel: (projectId: string, level: string) =>
    call<void>("set_thinking_level", { projectId, level }),
  respondExtensionUI: (projectId: string, requestId: string, response: unknown) =>
    call<void>("respond_extension_ui", { projectId, requestId, response }),
  listPiPackages: (projectId: string) => call<PiPackageRecord[]>("list_pi_packages", { projectId }),
  browsePiPackageCatalog: (query: PackageCatalogQuery) =>
    call<PackageCatalogPage>("browse_pi_package_catalog", { query }),
  async runPiPackageOperation(
    projectId: string,
    request: PackageOperationRequest,
    onProgress: (progress: PackageProgress) => void,
  ) {
    if (!isTauri()) throw new Error("This action is available in the desktop app");
    const channel = new Channel<PackageProgress>();
    channel.onmessage = onProgress;
    return invoke<PackageOperationResult>("run_pi_package_operation", {
      projectId,
      request,
      onProgress: channel,
    });
  },
  cancelPiPackageOperation: (operationId: string) =>
    call<boolean>("cancel_pi_package_operation", { operationId }),
  reloadPiResources: (projectId: string) => call<string[]>("reload_pi_resources", { projectId }),
  openPiPackageConfig: (projectId: string, scope: PackageScope) =>
    call<void>("open_pi_package_config", { projectId, scope }),
  listProviderCredentials: () => call<ProviderCredentialStatus[]>("list_provider_credentials"),
  setProviderKey: (providerId: string, secret: string) =>
    call<ProviderCredentialStatus[]>("set_provider_key", { providerId, secret }),
  deleteProviderKey: (providerId: string) =>
    call<ProviderCredentialStatus[]>("delete_provider_key", { providerId }),
  dismissNotification: (key: string) => call<void>("dismiss_notification", { key }),
  getSettings: () => call<AppSettings>("get_settings"),
  updateSettings: (patch: Partial<AppSettings>) => call<AppSettings>("update_settings", { patch }),
  openPiLogin: () => call<void>("open_pi_login"),
};
