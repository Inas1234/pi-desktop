import { useSyncExternalStore } from "react";

import { desktop } from "@/lib/bridge";
import type {
  AppEvent,
  AppSettings,
  AppStoreState,
  CustomItem,
  ExtensionUIRequest,
  MessageItem,
  PiContentBlock,
  PiMessage,
  ProjectRecord,
  ProjectRuntime,
  ProviderCredentialStatus,
  SessionSummary,
  ThinkingLevel,
  ToolItem,
  TranscriptItem,
} from "@/lib/types";
import { errorMessage } from "@/lib/utils";

const defaultSettings: AppSettings = {
  theme: "system",
  idleTimeoutMinutes: 10,
  sidebarCollapsed: false,
  piPath: null,
  activeProjectId: null,
  showReasoning: true,
};

export function createRuntime(): ProjectRuntime {
  return {
    connection: "stopped",
    connectionMessage: null,
    state: {},
    messages: [],
    models: [],
    commands: [],
    stats: {},
    sessions: [],
    sessionsLoading: false,
    historyCursor: null,
    hasOlder: false,
    historyLoading: false,
    isStreaming: false,
    isSettled: true,
    currentAssistantId: null,
    extensionRequests: [],
    composerText: null,
    notifications: [],
    status: {},
    widgets: {},
    extensionTitle: null,
    warning: null,
  };
}

const initialState: AppStoreState = {
  bootstrapped: false,
  loading: true,
  error: null,
  settings: defaultSettings,
  projects: [],
  activeProjectId: null,
  environment: null,
  providers: [],
  runtimes: {},
  sidebarOpen: true,
  settingsOpen: false,
  commandPaletteOpen: false,
  packagesOpen: false,
  lastEventSeq: 0,
};

let state = initialState;
const listeners = new Set<() => void>();

function publish(next: AppStoreState) {
  state = next;
  for (const listener of listeners) listener();
}

function patch(partial: Partial<AppStoreState>) {
  publish({ ...state, ...partial });
}

function updateRuntime(
  source: AppStoreState,
  projectId: string,
  update: (runtime: ProjectRuntime) => ProjectRuntime,
): AppStoreState {
  const runtime = source.runtimes[projectId] ?? createRuntime();
  return {
    ...source,
    runtimes: { ...source.runtimes, [projectId]: update(runtime) },
  };
}

function asBlocks(message: PiMessage): PiContentBlock[] {
  return Array.isArray(message.content) ? message.content : [];
}

export function messageText(message: PiMessage): string {
  if (typeof message.content === "string") return message.content;
  return asBlocks(message)
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("");
}

export function messageReasoning(message: PiMessage): string {
  return asBlocks(message)
    .filter((block) => block.type === "thinking")
    .map((block) => block.thinking ?? block.text ?? "")
    .join("");
}

function outputText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((block) => {
        if (typeof block === "string") return block;
        if (
          block &&
          typeof block === "object" &&
          typeof (block as Record<string, unknown>).text === "string"
        ) {
          return (block as Record<string, unknown>).text as string;
        }
        return "";
      })
      .join("");
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") return record.text;
    if (Array.isArray(record.content)) {
      const text = record.content
        .map((block) => {
          if (typeof block === "string") return block;
          if (block && typeof block === "object") {
            const item = block as Record<string, unknown>;
            return typeof item.text === "string" ? item.text : "";
          }
          return "";
        })
        .join("");
      if (text) return text;
    }
  }
  if (value == null) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function boundedTail(value: unknown, limit = 48_000): string {
  const text = outputText(value);
  return text.length > limit ? `… output truncated …\n${text.slice(-limit)}` : text;
}

function payloadDetails(value: unknown): {
  details: unknown | null;
  detailsTruncated: boolean;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { details: null, detailsTruncated: false };
  }
  const record = value as Record<string, unknown>;
  return {
    details: record.details ?? null,
    detailsTruncated: Boolean(record.detailsTruncated),
  };
}

function customItem(message: PiMessage, id: string, complete: boolean): CustomItem | null {
  if (message.display === false) return null;
  const label =
    typeof message.customType === "string"
      ? message.customType
      : typeof message.role === "string"
        ? message.role
        : "extension";
  const text =
    typeof message.summary === "string" ? message.summary : boundedTail(message.content ?? "");
  return {
    id,
    type: "custom",
    label,
    text,
    details: message.details ?? null,
    detailsTruncated: Boolean(message.detailsTruncated),
    complete,
    timestamp: message.timestamp,
  };
}

export function normalizeMessages(messages: PiMessage[]): TranscriptItem[] {
  const result: TranscriptItem[] = [];
  messages.forEach((message, index) => {
    const id = message.id ?? `${message.role ?? "message"}-${index}`;
    if (message.role === "user" || message.role === "assistant") {
      result.push({
        id,
        type: "message",
        role: message.role,
        text: messageText(message),
        reasoning: messageReasoning(message),
        complete: true,
        timestamp: message.timestamp,
      });
      if (message.role === "assistant") {
        for (const block of asBlocks(message).filter((entry) => entry.type === "toolCall")) {
          result.push({
            id: block.id ?? `${id}-tool-${result.length}`,
            type: "tool",
            name: block.name ?? "tool",
            args: block.arguments ?? {},
            output: "",
            status: "running",
            isError: false,
            details: null,
            detailsTruncated: false,
            argsTruncated: Boolean(block.argumentsTruncated),
          });
        }
      }
      return;
    }
    if (message.role === "toolResult") {
      const toolId = message.toolCallId ?? id;
      const existing = result.findIndex((item) => item.type === "tool" && item.id === toolId);
      const tool: ToolItem = {
        id: toolId,
        type: "tool",
        name: message.toolName ?? "tool",
        args: existing >= 0 && result[existing].type === "tool" ? result[existing].args : {},
        output: boundedTail(message.content),
        status: message.isError ? "error" : "success",
        isError: Boolean(message.isError),
        details: message.details ?? null,
        detailsTruncated: Boolean(message.detailsTruncated),
        argsTruncated: false,
      };
      if (existing >= 0) result[existing] = tool;
      else result.push(tool);
      return;
    }
    if (message.role === "bashExecution") {
      result.push({
        id,
        type: "tool",
        name: "bash",
        args: { command: message.command ?? "" },
        output: boundedTail(message.output),
        status: Number(message.exitCode ?? 0) === 0 ? "success" : "error",
        isError: Number(message.exitCode ?? 0) !== 0,
        details: null,
        detailsTruncated: false,
        argsTruncated: false,
      });
      return;
    }
    const custom = customItem(message, id, true);
    if (custom) result.push(custom);
  });
  return result;
}

function upsertTool(
  messages: TranscriptItem[],
  id: string,
  update: (tool: ToolItem | undefined) => ToolItem,
): TranscriptItem[] {
  const index = messages.findIndex((item) => item.type === "tool" && item.id === id);
  if (index < 0) return [...messages, update(undefined)];
  const next = [...messages];
  const item = next[index];
  next[index] = update(item.type === "tool" ? item : undefined);
  return next;
}

function updateMessage(
  messages: TranscriptItem[],
  id: string,
  update: (message: MessageItem) => MessageItem,
): TranscriptItem[] {
  const index = messages.findIndex((item) => item.type === "message" && item.id === id);
  if (index < 0) return messages;
  const next = [...messages];
  const item = next[index];
  if (item.type === "message") next[index] = update(item);
  return next;
}

function updateCustom(
  messages: TranscriptItem[],
  id: string,
  update: (message: CustomItem) => CustomItem,
): TranscriptItem[] {
  const index = messages.findIndex((item) => item.type === "custom" && item.id === id);
  if (index < 0) return messages;
  const next = [...messages];
  const item = next[index];
  if (item.type === "custom") next[index] = update(item);
  return next;
}

function eventMessageId(message: PiMessage, seq: number | string): string {
  return (
    message.id ??
    `${String(message.customType ?? message.role ?? "message")}-${String(message.timestamp ?? seq)}`
  );
}

function clearExtensionTransient(runtime: ProjectRuntime): ProjectRuntime {
  return {
    ...runtime,
    extensionRequests: [],
    notifications: [],
    status: {},
    widgets: {},
    extensionTitle: null,
  };
}

function boundedRecord<T>(
  source: Record<string, T>,
  key: string,
  value: T | null,
  limit: number,
): Record<string, T> {
  const entries = Object.entries(source).filter(([entryKey]) => entryKey !== key);
  if (value !== null) entries.push([key, value]);
  return Object.fromEntries(entries.slice(-limit)) as Record<string, T>;
}

function applyPiEvent(
  runtime: ProjectRuntime,
  value: Record<string, unknown>,
  seq: number | string,
): ProjectRuntime {
  const eventType = typeof value.type === "string" ? value.type : "unknown";
  if (eventType === "agent_start") {
    return { ...runtime, isStreaming: true, isSettled: false };
  }
  if (eventType === "agent_settled") {
    return {
      ...runtime,
      isStreaming: false,
      isSettled: true,
      currentAssistantId: null,
      state: { ...runtime.state, isStreaming: false, pendingMessageCount: 0 },
    };
  }
  if (eventType === "queue_update") {
    const steering = Array.isArray(value.steering) ? value.steering.length : 0;
    const followUp = Array.isArray(value.followUp) ? value.followUp.length : 0;
    return {
      ...runtime,
      state: { ...runtime.state, pendingMessageCount: steering + followUp },
    };
  }
  if (eventType === "message_start") {
    const message = value.message as PiMessage | undefined;
    if (!message) return runtime;
    const id = eventMessageId(message, seq);
    if (message.role === "toolResult" || message.role === "bashExecution") return runtime;
    if (message.role !== "user" && message.role !== "assistant") {
      const item = customItem(message, id, false);
      return item
        ? { ...runtime, messages: [...runtime.messages.filter((entry) => entry.id !== id), item] }
        : runtime;
    }
    const item: MessageItem = {
      id,
      type: "message",
      role: message.role,
      text: messageText(message),
      reasoning: messageReasoning(message),
      complete: false,
      timestamp: message.timestamp,
    };
    return {
      ...runtime,
      messages: [...runtime.messages.filter((entry) => entry.id !== id), item],
      currentAssistantId: message.role === "assistant" ? id : runtime.currentAssistantId,
      isStreaming: message.role === "assistant" || runtime.isStreaming,
    };
  }
  if (eventType === "message_update") {
    const streamEvent = value.assistantMessageEvent as Record<string, unknown> | undefined;
    const id = runtime.currentAssistantId;
    if (!streamEvent || !id) return runtime;
    const delta = typeof streamEvent.delta === "string" ? streamEvent.delta : "";
    const deltaType = streamEvent.type;
    return {
      ...runtime,
      messages: updateMessage(runtime.messages, id, (message) => ({
        ...message,
        text: deltaType === "text_delta" ? message.text + delta : message.text,
        reasoning: deltaType === "thinking_delta" ? message.reasoning + delta : message.reasoning,
      })),
    };
  }
  if (eventType === "message_end") {
    const message = value.message as PiMessage | undefined;
    if (!message) return runtime;
    if (message.role === "user") {
      const id = eventMessageId(message, seq);
      const existing = runtime.messages.some(
        (entry) => entry.type === "message" && entry.id === id,
      );
      const item: MessageItem = {
        id,
        type: "message",
        role: "user",
        text: messageText(message),
        reasoning: "",
        complete: true,
        timestamp: message.timestamp,
      };
      return {
        ...runtime,
        messages: existing
          ? updateMessage(runtime.messages, id, () => item)
          : [...runtime.messages, item],
      };
    }
    if (message.role === "toolResult" || message.role === "bashExecution") return runtime;
    if (message.role !== "assistant") {
      const id = eventMessageId(message, seq);
      const item = customItem(message, id, true);
      if (!item) return runtime;
      const exists = runtime.messages.some((entry) => entry.id === id);
      return {
        ...runtime,
        messages: exists
          ? updateCustom(runtime.messages, id, () => item)
          : [...runtime.messages, item],
      };
    }
    const id = runtime.currentAssistantId ?? message.id;
    if (!id) return runtime;
    return {
      ...runtime,
      messages: updateMessage(runtime.messages, id, (item) => ({
        ...item,
        text: messageText(message) || item.text,
        reasoning: messageReasoning(message) || item.reasoning,
        complete: true,
      })),
      currentAssistantId: null,
    };
  }
  if (eventType === "tool_execution_start") {
    const id = String(value.toolCallId ?? `tool-${seq}`);
    return {
      ...runtime,
      messages: upsertTool(runtime.messages, id, () => ({
        id,
        type: "tool",
        name: String(value.toolName ?? "tool"),
        args: value.args ?? {},
        output: "",
        status: "running",
        isError: false,
        details: null,
        detailsTruncated: false,
        argsTruncated: Boolean(value.argsTruncated),
      })),
    };
  }
  if (eventType === "tool_execution_update") {
    const id = String(value.toolCallId ?? `tool-${seq}`);
    const projected = payloadDetails(value.partialResult);
    return {
      ...runtime,
      messages: upsertTool(runtime.messages, id, (tool) => ({
        id,
        type: "tool",
        name: String(value.toolName ?? tool?.name ?? "tool"),
        args: value.args ?? tool?.args ?? {},
        output: boundedTail(value.partialResult),
        status: "running",
        isError: false,
        details: projected.details,
        detailsTruncated: projected.detailsTruncated,
        argsTruncated: Boolean(value.argsTruncated ?? tool?.argsTruncated),
      })),
    };
  }
  if (eventType === "tool_execution_end") {
    const id = String(value.toolCallId ?? `tool-${seq}`);
    const isError = Boolean(value.isError);
    const projected = payloadDetails(value.result);
    return {
      ...runtime,
      messages: upsertTool(runtime.messages, id, (tool) => ({
        id,
        type: "tool",
        name: String(value.toolName ?? tool?.name ?? "tool"),
        args: tool?.args ?? {},
        output: boundedTail(value.result),
        status: isError ? "error" : "success",
        isError,
        details: projected.details ?? tool?.details ?? null,
        detailsTruncated: projected.detailsTruncated || Boolean(tool?.detailsTruncated),
        argsTruncated: Boolean(value.argsTruncated ?? tool?.argsTruncated),
      })),
    };
  }
  if (eventType === "model_select") {
    return { ...runtime, state: { ...runtime.state, model: value.model as never } };
  }
  if (eventType === "thinking_level_select") {
    return {
      ...runtime,
      state: { ...runtime.state, thinkingLevel: value.level as ThinkingLevel },
    };
  }
  if (eventType === "extension_ui_request") {
    const request = value as unknown as ExtensionUIRequest;
    if (request.method === "notify") {
      const tone = ["info", "warning", "error"].includes(String(request.notifyType))
        ? (request.notifyType as "info" | "warning" | "error")
        : "info";
      return {
        ...runtime,
        notifications: [
          ...runtime.notifications,
          {
            id: request.id,
            message: String(request.message ?? ""),
            tone,
          },
        ].slice(-10),
      };
    }
    if (request.method === "setStatus") {
      const key = String(request.statusKey ?? "extension");
      const text = request.statusText;
      return {
        ...runtime,
        status: boundedRecord(
          runtime.status,
          key,
          typeof text === "string" && text ? text : null,
          32,
        ),
      };
    }
    if (request.method === "setWidget") {
      const key = String(request.widgetKey ?? "extension");
      const widget = Array.isArray(request.widgetLines)
        ? {
            lines: request.widgetLines.map(String),
            placement:
              request.widgetPlacement === "belowEditor"
                ? ("belowEditor" as const)
                : ("aboveEditor" as const),
          }
        : null;
      return { ...runtime, widgets: boundedRecord(runtime.widgets, key, widget, 16) };
    }
    if (request.method === "setTitle") {
      return {
        ...runtime,
        extensionTitle: typeof request.title === "string" && request.title ? request.title : null,
      };
    }
    if (request.method === "set_editor_text") {
      return { ...runtime, composerText: String(request.text ?? "") };
    }
    if (runtime.extensionRequests.some((entry) => entry.id === request.id)) return runtime;
    return { ...runtime, extensionRequests: [...runtime.extensionRequests, request].slice(-16) };
  }
  if (eventType === "extension_error") {
    const extension = String(value.extensionPath ?? "Pi extension")
      .split(/[\\/]/)
      .pop();
    const text = boundedTail(value.error, 4000) || "Extension failed";
    return {
      ...runtime,
      messages: [
        ...runtime.messages,
        {
          id: `extension-error-${seq}`,
          type: "notice",
          tone: "error",
          text: `${extension}: ${text}`,
        },
      ],
    };
  }
  if (eventType.includes("compaction")) {
    return { ...runtime, state: { ...runtime.state, isCompacting: eventType.endsWith("start") } };
  }
  return runtime;
}

export function reduceEvent(source: AppStoreState, event: AppEvent): AppStoreState {
  if (event.seq <= source.lastEventSeq) return source;
  let next = { ...source, lastEventSeq: event.seq };
  if (source.lastEventSeq > 0 && event.seq > source.lastEventSeq + 1) {
    next = updateRuntime(next, event.projectId, (runtime) => ({
      ...runtime,
      warning: `Event gap detected (${source.lastEventSeq + 1}–${event.seq - 1})`,
    }));
  }
  return updateRuntime(next, event.projectId, (runtime) => {
    if (event.type === "connection") {
      const connection: ProjectRuntime["connection"] =
        event.state === "connecting"
          ? "starting"
          : event.state === "connected"
            ? "connected"
            : event.state === "error"
              ? "error"
              : "stopped";
      const updated = { ...runtime, connection, connectionMessage: event.message ?? null };
      return connection === "starting" || connection === "stopped"
        ? clearExtensionTransient(updated)
        : updated;
    }
    if (event.type === "snapshot") {
      return {
        ...runtime,
        connection: "connected",
        state: event.state,
        messages: normalizeMessages(event.messages),
        models: event.models,
        commands: event.commands,
        stats: event.stats,
        historyCursor: event.historyCursor ?? null,
        hasOlder: Boolean(event.hasOlder),
        historyLoading: false,
        isStreaming: Boolean(event.state.isStreaming),
        isSettled: !event.state.isStreaming,
        warning: null,
      };
    }
    if (event.type === "pi_event") return applyPiEvent(runtime, event.event, event.seq);
    if (event.type === "pi_events") {
      return event.events.reduce(
        (current, value, index) => applyPiEvent(current, value, `${event.seq}:${index}`),
        runtime,
      );
    }
    if (event.type === "process_exited") {
      return clearExtensionTransient({
        ...runtime,
        connection: event.expected ? "stopped" : "error",
        connectionMessage: event.expected
          ? null
          : `Pi exited${event.code == null ? "" : ` with code ${event.code}`}`,
        isStreaming: false,
        isSettled: true,
      });
    }
    if (event.type === "extension_ui_expired") {
      return {
        ...runtime,
        extensionRequests: runtime.extensionRequests.filter(
          (request) => request.id !== event.requestId,
        ),
      };
    }
    if (event.type === "protocol_warning") return { ...runtime, warning: event.message };
    if (event.type === "resync_required") return { ...runtime, warning: event.reason };
    return runtime;
  });
}

const eventQueue: AppEvent[] = [];
let frame: number | null = null;
let initialization: Promise<void> | null = null;

function flushEvents() {
  frame = null;
  if (!eventQueue.length) return;
  let next = state;
  for (const event of eventQueue.splice(0)) next = reduceEvent(next, event);
  publish(next);
}

function enqueueEvent(event: AppEvent) {
  eventQueue.push(event);
  if (frame == null) frame = requestAnimationFrame(flushEvents);
}

function applyTheme(settings: AppSettings) {
  const dark =
    settings.theme === "dark" ||
    (settings.theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
}

async function withError<T>(operation: () => Promise<T>): Promise<T | undefined> {
  try {
    patch({ error: null });
    return await operation();
  } catch (error) {
    patch({ error: errorMessage(error) });
    return undefined;
  }
}

async function refreshSessions(projectId: string, query = "") {
  publish(updateRuntime(state, projectId, (runtime) => ({ ...runtime, sessionsLoading: true })));
  const sessions = await withError(() => desktop.listSessions(projectId, query));
  if (!sessions) return;
  publish(
    updateRuntime(state, projectId, (runtime) => ({
      ...runtime,
      sessions,
      sessionsLoading: false,
    })),
  );
}

export const appStore = {
  getSnapshot: () => state,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  async initialize() {
    if (state.bootstrapped) return;
    if (initialization) return initialization;
    initialization = (async () => {
      const bootstrap = await withError(() => desktop.initialize(enqueueEvent));
      if (!bootstrap) {
        patch({ loading: false, bootstrapped: true });
        return;
      }
      const runtimes = Object.fromEntries(
        bootstrap.projects.map((project) => [project.id, createRuntime()]),
      );
      const activeProjectId =
        bootstrap.settings.activeProjectId ?? bootstrap.projects[0]?.id ?? null;
      publish({
        ...state,
        bootstrapped: true,
        loading: false,
        settings: bootstrap.settings,
        projects: bootstrap.projects,
        activeProjectId,
        environment: bootstrap.environment,
        providers: bootstrap.providers,
        runtimes,
        sidebarOpen: !bootstrap.settings.sidebarCollapsed,
      });
      applyTheme(bootstrap.settings);
      if (activeProjectId && bootstrap.environment.compatible) {
        void this.selectProject(activeProjectId);
      }
    })();
    await initialization;
    initialization = null;
  },
  async addProject(path: string, trusted: boolean) {
    const project = await withError(() => desktop.addProject(path, trusted));
    if (!project) return;
    const projects = [...state.projects.filter((item) => item.id !== project.id), project];
    publish({
      ...state,
      projects,
      activeProjectId: project.id,
      runtimes: { ...state.runtimes, [project.id]: createRuntime() },
    });
    await this.selectProject(project.id);
  },
  async removeProject(projectId: string) {
    const result = await withError(() => desktop.removeProject(projectId));
    if (result === undefined && state.error) return;
    const projects = state.projects.filter((project) => project.id !== projectId);
    const runtimes = { ...state.runtimes };
    delete runtimes[projectId];
    const activeProjectId =
      state.activeProjectId === projectId ? (projects[0]?.id ?? null) : state.activeProjectId;
    publish({ ...state, projects, runtimes, activeProjectId });
    if (activeProjectId) await this.selectProject(activeProjectId);
  },
  async selectProject(projectId: string) {
    const project = state.projects.find((item) => item.id === projectId);
    if (!project) return;
    patch({ activeProjectId: projectId });
    void refreshSessions(projectId);
    await withError(() => desktop.activateProject(projectId));
  },
  refreshSessions,
  async newSession(projectId: string) {
    await withError(() => desktop.newSession(projectId));
    await refreshSessions(projectId);
  },
  async openSession(projectId: string, sessionPath: string) {
    await withError(() => desktop.openSession(projectId, sessionPath));
    await refreshSessions(projectId);
  },
  async loadOlder(projectId: string) {
    const runtime = state.runtimes[projectId];
    if (!runtime?.hasOlder || runtime.historyLoading) return;
    publish(updateRuntime(state, projectId, (current) => ({ ...current, historyLoading: true })));
    const page = await withError(() =>
      desktop.loadSessionPage(projectId, runtime.historyCursor, 100),
    );
    if (!page) {
      publish(
        updateRuntime(state, projectId, (current) => ({ ...current, historyLoading: false })),
      );
      return;
    }
    publish(
      updateRuntime(state, projectId, (current) => {
        const existing = new Set(current.messages.map((item) => item.id));
        const older = normalizeMessages(page.messages).filter((item) => !existing.has(item.id));
        return {
          ...current,
          messages: [...older, ...current.messages],
          historyCursor: page.cursor,
          hasOlder: page.hasOlder,
          historyLoading: false,
        };
      }),
    );
  },
  async send(
    projectId: string,
    text: string,
    images: string[],
    behavior: "prompt" | "steer" | "follow_up",
  ) {
    const command =
      behavior === "steer"
        ? desktop.steer
        : behavior === "follow_up"
          ? desktop.followUp
          : desktop.sendPrompt;
    await withError(() => command(projectId, text, images));
  },
  abort(projectId: string) {
    return withError(() => desktop.abort(projectId));
  },
  async setModel(projectId: string, provider: string, modelId: string) {
    await withError(() => desktop.setModel(projectId, provider, modelId));
  },
  async setThinking(projectId: string, level: ThinkingLevel) {
    await withError(() => desktop.setThinkingLevel(projectId, level));
  },
  async respondToExtension(projectId: string, requestId: string, response: unknown) {
    await withError(() => desktop.respondExtensionUI(projectId, requestId, response));
    publish(
      updateRuntime(state, projectId, (runtime) => ({
        ...runtime,
        extensionRequests: runtime.extensionRequests.filter((request) => request.id !== requestId),
      })),
    );
  },
  consumeComposerText(projectId: string) {
    publish(updateRuntime(state, projectId, (runtime) => ({ ...runtime, composerText: null })));
  },
  setComposerText(projectId: string, composerText: string) {
    publish(updateRuntime(state, projectId, (runtime) => ({ ...runtime, composerText })));
  },
  setSettingsOpen(open: boolean) {
    patch({ settingsOpen: open });
  },
  setCommandPaletteOpen(open: boolean) {
    patch({ commandPaletteOpen: open });
  },
  setPackagesOpen(open: boolean) {
    patch({ packagesOpen: open });
  },
  async toggleSidebar() {
    const sidebarOpen = !state.sidebarOpen;
    patch({ sidebarOpen });
    const settings = await withError(() =>
      desktop.updateSettings({ sidebarCollapsed: !sidebarOpen }),
    );
    if (settings) patch({ settings });
  },
  async updateSettings(values: Partial<AppSettings>) {
    const settings = await withError(() => desktop.updateSettings(values));
    if (!settings) return;
    patch({ settings, sidebarOpen: !settings.sidebarCollapsed });
    applyTheme(settings);
    if (Object.hasOwn(values, "piPath")) {
      const environment = await withError(() => desktop.diagnosePi());
      if (environment) patch({ environment });
    }
  },
  async setProviderKey(providerId: string, secret: string) {
    const providers = await withError(() => desktop.setProviderKey(providerId, secret));
    if (providers) patch({ providers });
  },
  async deleteProviderKey(providerId: string) {
    const providers = await withError(() => desktop.deleteProviderKey(providerId));
    if (providers) patch({ providers });
  },
  async updateProject(project: ProjectRecord) {
    patch({
      projects: state.projects.map((entry) => (entry.id === project.id ? project : entry)),
    });
  },
  async refreshProviders() {
    const providers = await withError(() => desktop.listProviderCredentials());
    if (providers) patch({ providers });
  },
  clearError() {
    patch({ error: null });
  },
  clearNotification(projectId: string, notificationId?: string) {
    publish(
      updateRuntime(state, projectId, (runtime) => ({
        ...runtime,
        notifications: notificationId
          ? runtime.notifications.filter((notification) => notification.id !== notificationId)
          : runtime.notifications.slice(1),
      })),
    );
  },
  _replaceForTest(next: AppStoreState) {
    publish(next);
  },
  _setSessions(projectId: string, sessions: SessionSummary[]) {
    publish(updateRuntime(state, projectId, (runtime) => ({ ...runtime, sessions })));
  },
  _setProviders(providers: ProviderCredentialStatus[]) {
    patch({ providers });
  },
};

export function useAppStore<T>(selector: (snapshot: AppStoreState) => T): T {
  const snapshot = useSyncExternalStore(
    appStore.subscribe,
    appStore.getSnapshot,
    appStore.getSnapshot,
  );
  return selector(snapshot);
}
