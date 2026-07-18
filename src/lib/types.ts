export type Theme = "light" | "dark" | "system";

export interface AppSettings {
  theme: Theme;
  idleTimeoutMinutes: number;
  sidebarCollapsed: boolean;
  piPath: string | null;
  activeProjectId: string | null;
  showReasoning: boolean;
}

export interface ProjectRecord {
  id: string;
  name: string;
  path: string;
  trusted: boolean;
  activeSession: string | null;
  createdAt: string;
  lastOpenedAt: string;
}

export interface PiEnvironmentReport {
  status: string;
  path: string | null;
  version: string | null;
  compatible: boolean;
  nodePath: string | null;
  message: string;
}

export interface ProviderCredentialStatus {
  id: string;
  name: string;
  environmentVariable: string;
  configuredInApp: boolean;
  configuredInPi: boolean;
  effectiveSource: string;
}

export interface BootstrapState {
  settings: AppSettings;
  projects: ProjectRecord[];
  environment: PiEnvironmentReport;
  providers: ProviderCredentialStatus[];
}

export interface SessionSummary {
  id: string;
  path: string;
  name: string | null;
  preview: string | null;
  messageCount: number;
  updatedAt: string;
  isActive: boolean;
}

export interface SessionPage {
  messages: PiMessage[];
  cursor: string | null;
  hasOlder: boolean;
}

export interface PiModel {
  id: string;
  name?: string;
  provider: string;
  contextWindow?: number;
  reasoning?: boolean;
  [key: string]: unknown;
}

export interface PiSessionState {
  model?: PiModel;
  thinkingLevel?: ThinkingLevel;
  isStreaming?: boolean;
  isCompacting?: boolean;
  sessionFile?: string;
  sessionId?: string;
  sessionName?: string;
  messageCount?: number;
  pendingMessageCount?: number;
  [key: string]: unknown;
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface PiContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
  [key: string]: unknown;
}

export interface PiMessage {
  id?: string;
  role?: string;
  content?: string | PiContentBlock[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  timestamp?: number | string;
  [key: string]: unknown;
}

export type TranscriptItem = MessageItem | ToolItem | CustomItem | NoticeItem;

export interface MessageItem {
  id: string;
  type: "message";
  role: "user" | "assistant";
  text: string;
  reasoning: string;
  complete: boolean;
  timestamp?: number | string;
}

export interface ToolItem {
  id: string;
  type: "tool";
  name: string;
  args: unknown;
  output: string;
  status: "running" | "success" | "error";
  isError: boolean;
  details: unknown | null;
  detailsTruncated: boolean;
  argsTruncated: boolean;
}

export interface CustomItem {
  id: string;
  type: "custom";
  label: string;
  text: string;
  details: unknown | null;
  detailsTruncated: boolean;
  complete: boolean;
  timestamp?: number | string;
}

export interface NoticeItem {
  id: string;
  type: "notice";
  tone: "info" | "warning" | "error";
  text: string;
}

export interface ExtensionUIRequest {
  type: "extension_ui_request";
  id: string;
  method: string;
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  timeout?: number;
  [key: string]: unknown;
}

export interface ExtensionNotification {
  id: string;
  message: string;
  tone: "info" | "warning" | "error";
}

export interface ExtensionWidget {
  lines: string[];
  placement: "aboveEditor" | "belowEditor";
}

interface EventBase {
  seq: number;
  projectId: string;
  sessionId?: string;
}

export type AppEvent = EventBase &
  (
    | { type: "connection"; state: string; message?: string | null }
    | {
        type: "snapshot";
        state: PiSessionState;
        messages: PiMessage[];
        models: PiModel[];
        commands: PiCommand[];
        stats: Record<string, unknown>;
        historyCursor?: string | null;
        hasOlder?: boolean;
      }
    | { type: "pi_event"; event: Record<string, unknown> }
    | { type: "pi_events"; events: Record<string, unknown>[] }
    | { type: "process_exited"; code?: number | null; expected: boolean }
    | { type: "protocol_warning"; message: string }
    | { type: "extension_ui_expired"; requestId: string }
    | { type: "resync_required"; reason: string }
  );

export interface PiCommand {
  name: string;
  description?: string;
  source?: string;
  argumentHint?: string;
  invocation?: "interactive" | "prompt";
  [key: string]: unknown;
}

export type PackageScope = "user" | "project";

export interface PiPackageRecord {
  source: string;
  scope: PackageScope;
  installedPath?: string | null;
  filtered: boolean;
}

export type PackageCatalogType = "" | "extension" | "skill" | "theme" | "prompt";
export type PackageCatalogSort = "downloads" | "recent" | "name";

export interface PackageCatalogQuery {
  name?: string | null;
  packageType?: PackageCatalogType | null;
  sort?: PackageCatalogSort | null;
  page?: number | null;
}

export interface PackageCatalogItem {
  name: string;
  description: string;
  author: string;
  downloads: number;
  published: string;
  types: string[];
  npmUrl: string;
  repositoryUrl?: string | null;
  detailUrl: string;
}

export interface PackageCatalogPage {
  items: PackageCatalogItem[];
  page: number;
  pageCount: number;
  total: number;
  from: number;
  to: number;
}

export type PackageOperationKind = "install" | "remove" | "update" | "update_all";

export interface PackageOperationRequest {
  kind: PackageOperationKind;
  source?: string | null;
  scope?: PackageScope | null;
}

export interface PackageProgress {
  operationId: string;
  phase: "started" | "output" | "restarting" | "complete";
  message: string;
}

export interface PackageOperationResult {
  packages: PiPackageRecord[];
  restartedProjectIds: string[];
  warnings: string[];
}

export interface ProjectRuntime {
  connection: "stopped" | "starting" | "connected" | "error";
  connectionMessage: string | null;
  state: PiSessionState;
  messages: TranscriptItem[];
  models: PiModel[];
  commands: PiCommand[];
  stats: Record<string, unknown>;
  sessions: SessionSummary[];
  sessionsLoading: boolean;
  sessionsLoaded: boolean;
  sessionsError: string | null;
  historyCursor: string | null;
  hasOlder: boolean;
  historyLoading: boolean;
  isStreaming: boolean;
  isSettled: boolean;
  currentAssistantId: string | null;
  extensionRequests: ExtensionUIRequest[];
  composerText: string | null;
  notifications: ExtensionNotification[];
  status: Record<string, string>;
  widgets: Record<string, ExtensionWidget>;
  extensionTitle: string | null;
  warning: string | null;
}

export interface AppStoreState {
  bootstrapped: boolean;
  loading: boolean;
  error: string | null;
  settings: AppSettings;
  projects: ProjectRecord[];
  activeProjectId: string | null;
  environment: PiEnvironmentReport | null;
  providers: ProviderCredentialStatus[];
  runtimes: Record<string, ProjectRuntime>;
  sidebarOpen: boolean;
  settingsOpen: boolean;
  commandPaletteOpen: boolean;
  packagesOpen: boolean;
  lastEventSeq: number;
}
