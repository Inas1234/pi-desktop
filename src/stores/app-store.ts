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
  SessionPage,
  SessionSummary,
  SessionTransition,
  ThinkingLevel,
  ToolItem,
  TranscriptItem,
} from "@/lib/types";
import { errorMessage, stripTerminalFormatting } from "@/lib/utils";

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
    sessionsLoaded: false,
    sessionsError: null,
    historyCursor: null,
    hasOlder: false,
    historyLoading: false,
    sessionSwitchingTo: null,
    sessionTransitionPending: null,
    sessionActivity: {},
    backgroundExtensionRequests: {},
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

export function createCachedRuntime(
  project: ProjectRecord,
  commands: ProjectRuntime["commands"],
  sessions?: SessionSummary[],
): ProjectRuntime {
  return {
    ...createRuntime(),
    commands,
    sessions: (sessions ?? []).map((session) => ({
      ...session,
      isActive: session.path === project.activeSession,
    })),
    sessionsLoaded: sessions !== undefined,
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
  dismissedNotificationKeys: [],
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

export function hydrateRuntime(runtime: ProjectRuntime, page: SessionPage): ProjectRuntime {
  return {
    ...runtime,
    messages: normalizeMessages(page.messages),
    historyCursor: page.cursor,
    hasOlder: page.hasOlder,
    historyLoading: false,
  };
}

function sameSessionPath(left: string | null | undefined, right: string | null | undefined) {
  if (!left || !right) return left === right;
  const normalize = (path: string) => {
    const windowsPath = path.replaceAll("/", "\\");
    const lowerPath = windowsPath.toLowerCase();
    if (lowerPath.startsWith("\\\\?\\unc\\")) {
      return `\\\\${lowerPath.slice(8)}`;
    }
    return lowerPath.startsWith("\\\\?\\") ? lowerPath.slice(4) : lowerPath;
  };
  return normalize(left) === normalize(right);
}

export function beginSessionSwitch(
  source: AppStoreState,
  projectId: string,
  sessionPath: string,
): AppStoreState {
  const project = source.projects.find((item) => item.id === projectId);
  if (!project) return source;
  const runtime = source.runtimes[projectId] ?? createRuntime();
  const session = runtime.sessions.find((item) => sameSessionPath(item.path, sessionPath));
  const targetSessionId = session?.id;
  const previousSessionId = runtime.state.sessionId;
  let sessionActivity = runtime.sessionActivity;
  let backgroundExtensionRequests = runtime.backgroundExtensionRequests;
  if (previousSessionId && previousSessionId !== targetSessionId) {
    if (runtime.isStreaming) {
      sessionActivity = boundedRecord(sessionActivity, previousSessionId, "running", 32);
    }
    if (runtime.extensionRequests.length > 0) {
      backgroundExtensionRequests = boundedRecord(
        backgroundExtensionRequests,
        previousSessionId,
        runtime.extensionRequests,
        16,
      );
    }
  }
  const targetActivity = targetSessionId ? sessionActivity[targetSessionId] : undefined;
  const targetRequests = targetSessionId
    ? (backgroundExtensionRequests[targetSessionId] ?? [])
    : [];
  if (targetSessionId) {
    sessionActivity = boundedRecord(sessionActivity, targetSessionId, null, 32);
    backgroundExtensionRequests = boundedRecord(
      backgroundExtensionRequests,
      targetSessionId,
      null,
      16,
    );
  }
  const targetStreaming = targetActivity === "running" || targetActivity === "attention";
  const nextRuntime = {
    ...clearExtensionTransient({
      ...runtime,
      state: {
        ...runtime.state,
        sessionFile: sessionPath,
        sessionId: targetSessionId,
        sessionName: session?.name ?? session?.preview ?? undefined,
        isStreaming: targetStreaming,
        isCompacting: false,
        pendingMessageCount: 0,
      },
      messages: [],
      stats: {},
      sessions: runtime.sessions.map((item) => ({
        ...item,
        isActive: sameSessionPath(item.path, sessionPath),
      })),
      historyCursor: null,
      hasOlder: false,
      historyLoading: false,
      sessionSwitchingTo: sessionPath,
      isStreaming: targetStreaming,
      isSettled: !targetStreaming,
      currentAssistantId: null,
      warning: null,
    }),
    sessionActivity,
    backgroundExtensionRequests,
    extensionRequests: targetRequests,
  };
  return {
    ...source,
    activeProjectId: projectId,
    projects: source.projects.map((item) =>
      item.id === projectId ? { ...item, activeSession: sessionPath } : item,
    ),
    runtimes: { ...source.runtimes, [projectId]: nextRuntime },
  };
}

export function beginSessionTransition(
  source: AppStoreState,
  projectId: string,
  kind: SessionTransition["kind"],
  sessionPath?: string,
): AppStoreState {
  const project = source.projects.find((item) => item.id === projectId);
  if (!project) return source;
  const runtime = source.runtimes[projectId] ?? createRuntime();
  if (runtime.sessionTransitionPending || runtime.sessionSwitchingTo) return source;
  const pending: SessionTransition = {
    kind,
    sessionPath,
    fromSessionId: runtime.state.sessionId,
    fromSessionFile: runtime.state.sessionFile ?? project.activeSession ?? undefined,
  };
  let sessionActivity = runtime.sessionActivity;
  let backgroundExtensionRequests = runtime.backgroundExtensionRequests;
  let extensionRequests = runtime.extensionRequests;
  if (pending.fromSessionId) {
    if (runtime.isStreaming) {
      sessionActivity = boundedRecord(sessionActivity, pending.fromSessionId, "running", 32);
    }
    if (extensionRequests.length > 0) {
      backgroundExtensionRequests = boundedRecord(
        backgroundExtensionRequests,
        pending.fromSessionId,
        extensionRequests,
        16,
      );
      extensionRequests = [];
    }
  }
  return {
    ...source,
    activeProjectId: projectId,
    projects: source.projects.map((project) =>
      project.id === projectId && kind === "switch"
        ? { ...project, activeSession: sessionPath ?? null }
        : project,
    ),
    runtimes: {
      ...source.runtimes,
      [projectId]: {
        ...runtime,
        sessions:
          kind === "switch"
            ? runtime.sessions.map((session) => ({
                ...session,
                isActive: sameSessionPath(session.path, sessionPath),
              }))
            : runtime.sessions,
        sessionTransitionPending: pending,
        sessionActivity,
        backgroundExtensionRequests,
        extensionRequests,
      },
    },
  };
}

function cancelSessionTransition(source: AppStoreState, projectId: string): AppStoreState {
  const runtime = source.runtimes[projectId];
  const pending = runtime?.sessionTransitionPending;
  if (!runtime || !pending) return source;
  return {
    ...source,
    projects: source.projects.map((project) =>
      project.id === projectId
        ? { ...project, activeSession: pending.fromSessionFile ?? null }
        : project,
    ),
    runtimes: {
      ...source.runtimes,
      [projectId]: {
        ...runtime,
        sessions: runtime.sessions.map((session) => ({
          ...session,
          isActive: sameSessionPath(session.path, pending.fromSessionFile),
        })),
        sessionSwitchingTo: null,
        sessionTransitionPending: null,
      },
    },
  };
}

function snapshotMatchesSessionTransition(
  runtime: ProjectRuntime,
  state: ProjectRuntime["state"],
): boolean {
  const pending = runtime.sessionTransitionPending;
  if (pending?.kind === "switch") {
    return Boolean(
      pending.sessionPath &&
        state.sessionFile &&
        sameSessionPath(pending.sessionPath, state.sessionFile),
    );
  }
  if (pending?.kind === "new") {
    if (pending.fromSessionId && state.sessionId === pending.fromSessionId) return false;
    if (
      pending.fromSessionFile &&
      state.sessionFile &&
      sameSessionPath(pending.fromSessionFile, state.sessionFile)
    ) {
      return false;
    }
  }
  if (
    runtime.sessionSwitchingTo &&
    state.sessionFile &&
    !sameSessionPath(runtime.sessionSwitchingTo, state.sessionFile)
  ) {
    return false;
  }
  return true;
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

function notificationKey(message: string, tone: "info" | "warning" | "error"): string {
  const input = `${tone}\0${message}`;
  let hash = 0xcbf29ce484222325n;
  for (const character of input) {
    hash ^= BigInt(character.codePointAt(0) ?? 0);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `v1-${input.length.toString(36)}-${hash.toString(16).padStart(16, "0")}`;
}

function applyPiEvent(
  runtime: ProjectRuntime,
  value: Record<string, unknown>,
  seq: number | string,
  dismissedNotificationKeys: string[],
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
      const message = stripTerminalFormatting(String(request.message ?? ""));
      const key = notificationKey(message, tone);
      if (
        dismissedNotificationKeys.includes(key) ||
        runtime.notifications.some((notification) => notification.key === key)
      ) {
        return runtime;
      }
      return {
        ...runtime,
        notifications: [
          ...runtime.notifications,
          {
            id: request.id,
            key,
            message,
            tone,
          },
        ].slice(-10),
      };
    }
    if (request.method === "setStatus") {
      const key = String(request.statusKey ?? "extension");
      const text =
        typeof request.statusText === "string" ? stripTerminalFormatting(request.statusText) : null;
      return {
        ...runtime,
        status: boundedRecord(runtime.status, key, text || null, 32),
      };
    }
    if (request.method === "setWidget") {
      const key = String(request.widgetKey ?? "extension");
      const widget = Array.isArray(request.widgetLines)
        ? {
            lines: request.widgetLines.map((line) => stripTerminalFormatting(String(line))),
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
        extensionTitle:
          typeof request.title === "string" && request.title
            ? stripTerminalFormatting(request.title)
            : null,
      };
    }
    if (request.method === "set_editor_text") {
      return {
        ...runtime,
        composerText: stripTerminalFormatting(String(request.text ?? "")),
      };
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

function reduceBackgroundSessionEvent(runtime: ProjectRuntime, event: AppEvent): ProjectRuntime {
  const sessionId = event.sessionId;
  if (!sessionId) return runtime;
  let sessionActivity = runtime.sessionActivity;
  let backgroundExtensionRequests = runtime.backgroundExtensionRequests;
  const values =
    event.type === "pi_event" ? [event.event] : event.type === "pi_events" ? event.events : [];

  if (event.type === "snapshot") {
    sessionActivity = boundedRecord(
      sessionActivity,
      sessionId,
      event.state.isStreaming ? "running" : null,
      32,
    );
  }
  if (event.type === "process_exited") {
    sessionActivity = boundedRecord(sessionActivity, sessionId, null, 32);
    backgroundExtensionRequests = boundedRecord(backgroundExtensionRequests, sessionId, null, 16);
  }
  for (const value of values) {
    const eventType = typeof value.type === "string" ? value.type : "unknown";
    if (eventType === "agent_start") {
      sessionActivity = boundedRecord(sessionActivity, sessionId, "running", 32);
    } else if (eventType === "agent_settled") {
      sessionActivity = boundedRecord(sessionActivity, sessionId, null, 32);
    } else if (eventType === "extension_ui_request") {
      const request = value as unknown as ExtensionUIRequest;
      if (["select", "confirm", "input", "editor"].includes(request.method)) {
        const requests = backgroundExtensionRequests[sessionId] ?? [];
        if (!requests.some((entry) => entry.id === request.id)) {
          backgroundExtensionRequests = boundedRecord(
            backgroundExtensionRequests,
            sessionId,
            [...requests, request].slice(-16),
            16,
          );
        }
        sessionActivity = boundedRecord(sessionActivity, sessionId, "attention", 32);
      }
    }
  }
  return { ...runtime, sessionActivity, backgroundExtensionRequests };
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
  const currentRuntime = next.runtimes[event.projectId] ?? createRuntime();
  const authoritativeTransitionSnapshot =
    event.type === "snapshot" && snapshotMatchesSessionTransition(currentRuntime, event.state);
  const pendingTransition = currentRuntime.sessionTransitionPending;
  const pendingTargetSessionId =
    pendingTransition?.kind === "switch"
      ? currentRuntime.sessions.find((session) =>
          sameSessionPath(session.path, pendingTransition.sessionPath),
        )?.id
      : undefined;
  const targetsBackgroundSession = Boolean(
    !authoritativeTransitionSnapshot &&
      event.sessionId &&
      (pendingTransition?.kind === "new"
        ? event.sessionId === pendingTransition.fromSessionId || event.type === "process_exited"
        : pendingTransition?.kind === "switch"
          ? pendingTargetSessionId
            ? event.sessionId !== pendingTargetSessionId
            : event.sessionId === pendingTransition.fromSessionId
          : currentRuntime.state.sessionId && event.sessionId !== currentRuntime.state.sessionId),
  );
  if (targetsBackgroundSession) {
    return updateRuntime(next, event.projectId, (runtime) =>
      reduceBackgroundSessionEvent(runtime, event),
    );
  }
  if (
    event.type === "snapshot" &&
    snapshotMatchesSessionTransition(next.runtimes[event.projectId] ?? createRuntime(), event.state)
  ) {
    next = {
      ...next,
      projects: next.projects.map((project) =>
        project.id === event.projectId
          ? { ...project, activeSession: event.state.sessionFile ?? null }
          : project,
      ),
    };
  }
  if (event.type === "process_exited") {
    next = cancelSessionTransition(next, event.projectId);
  }
  if (event.type === "connection" && event.state === "error") {
    next = cancelSessionTransition(next, event.projectId);
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
      if (!snapshotMatchesSessionTransition(runtime, event.state)) return runtime;
      const activeSessionId = event.state.sessionId;
      let sessionActivity = runtime.sessionActivity;
      let backgroundExtensionRequests = runtime.backgroundExtensionRequests;
      if (activeSessionId) {
        sessionActivity = boundedRecord(sessionActivity, activeSessionId, null, 32);
        backgroundExtensionRequests = boundedRecord(
          backgroundExtensionRequests,
          activeSessionId,
          null,
          16,
        );
      }
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
        sessionSwitchingTo: null,
        sessionTransitionPending: null,
        sessionActivity,
        backgroundExtensionRequests,
        sessions: runtime.sessions.map((session) => ({
          ...session,
          isActive: sameSessionPath(session.path, event.state.sessionFile),
        })),
        isStreaming: Boolean(event.state.isStreaming),
        isSettled: !event.state.isStreaming,
        warning: null,
      };
    }
    if (event.type === "pi_event") {
      return applyPiEvent(runtime, event.event, event.seq, next.dismissedNotificationKeys);
    }
    if (event.type === "pi_events") {
      return event.events.reduce(
        (current, value, index) =>
          applyPiEvent(current, value, `${event.seq}:${index}`, next.dismissedNotificationKeys),
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
        sessionTransitionPending: null,
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

export function dismissNotificationInState(source: AppStoreState, key: string): AppStoreState {
  const dismissedNotificationKeys = [
    ...source.dismissedNotificationKeys.filter((entry) => entry !== key),
    key,
  ].slice(-256);
  const runtimes = Object.fromEntries(
    Object.entries(source.runtimes).map(([projectId, runtime]) => [
      projectId,
      {
        ...runtime,
        notifications: runtime.notifications.filter((notification) => notification.key !== key),
      },
    ]),
  );
  return { ...source, dismissedNotificationKeys, runtimes };
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
  const piEvents =
    event.type === "pi_event" ? [event.event] : event.type === "pi_events" ? event.events : [];
  if (piEvents.some((entry) => entry.type === "agent_settled")) {
    void refreshSessions(event.projectId);
  }
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
  if (!state.projects.some((project) => project.id === projectId)) return;
  publish(
    updateRuntime(state, projectId, (runtime) => ({
      ...runtime,
      sessionsLoading: true,
      sessionsError: null,
    })),
  );
  try {
    const sessions = await desktop.listSessions(projectId, query);
    publish(
      updateRuntime(state, projectId, (runtime) => ({
        ...runtime,
        sessions,
        sessionsLoading: false,
        sessionsLoaded: true,
        sessionsError: null,
      })),
    );
  } catch (error) {
    const message = errorMessage(error);
    patch({ error: message });
    publish(
      updateRuntime(state, projectId, (runtime) => ({
        ...runtime,
        sessionsLoading: false,
        sessionsError: message,
      })),
    );
  }
}

async function hydrateActiveSession(projectId: string) {
  const project = state.projects.find((item) => item.id === projectId);
  const sessionPath = project?.activeSession;
  if (!sessionPath) return;
  try {
    const page = await desktop.loadSessionPage(projectId, null, 200);
    const activeSession = state.projects.find((item) => item.id === projectId)?.activeSession;
    if (activeSession !== sessionPath) return;
    publish(
      updateRuntime(state, projectId, (runtime) => {
        if (runtime.state.sessionId || runtime.messages.length > 0) return runtime;
        if (runtime.state.sessionFile && runtime.state.sessionFile !== sessionPath) return runtime;
        return hydrateRuntime(runtime, page);
      }),
    );
  } catch {
    // Pi's bootstrap snapshot remains the authoritative fallback.
  }
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
        bootstrap.projects.map((project) => {
          const cachedSessions = bootstrap.cachedSessionSummaries[project.id];
          return [
            project.id,
            createCachedRuntime(
              project,
              bootstrap.cachedCommandCatalogs[project.id] ?? [],
              cachedSessions,
            ),
          ];
        }),
      );
      const activeProjectId =
        bootstrap.settings.activeProjectId ?? bootstrap.projects[0]?.id ?? null;
      publish({
        ...state,
        bootstrapped: true,
        loading: false,
        error: bootstrap.startupWarning,
        settings: bootstrap.settings,
        projects: bootstrap.projects,
        activeProjectId,
        environment: bootstrap.environment,
        providers: bootstrap.providers,
        dismissedNotificationKeys: bootstrap.dismissedNotificationKeys,
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
    void hydrateActiveSession(projectId);
    void refreshSessions(projectId);
    await withError(() => desktop.activateProject(projectId));
  },
  refreshSessions,
  async newSession(projectId: string) {
    const runtime = state.runtimes[projectId];
    if (runtime?.sessionTransitionPending || runtime?.sessionSwitchingTo) return;
    publish(beginSessionTransition(state, projectId, "new"));
    const completed = await withError(async () => {
      await desktop.newSession(projectId);
      return true;
    });
    if (!completed) {
      publish(cancelSessionTransition(state, projectId));
      return;
    }
    await refreshSessions(projectId);
  },
  async openSession(projectId: string, sessionPath: string) {
    const project = state.projects.find((item) => item.id === projectId);
    const runtime = state.runtimes[projectId];
    if (
      !project ||
      (state.activeProjectId === projectId &&
        sameSessionPath(project.activeSession, sessionPath) &&
        !runtime?.sessionSwitchingTo)
    ) {
      return;
    }

    if (runtime?.sessionTransitionPending || runtime?.sessionSwitchingTo) return;
    const transition = beginSessionTransition(state, projectId, "switch", sessionPath);
    const openImmediately = !runtime || (runtime.isSettled && !runtime.isStreaming);
    const hydrateSelectedSession = () => {
      void desktop
        .loadSessionPage(projectId, null, 200, sessionPath)
        .then((page) => {
          const current = state.runtimes[projectId];
          if (!sameSessionPath(current?.sessionSwitchingTo, sessionPath)) return;
          publish(updateRuntime(state, projectId, (value) => hydrateRuntime(value, page)));
        })
        .catch(() => {
          // Pi's authoritative switch snapshot remains the fallback.
        });
    };
    publish(openImmediately ? beginSessionSwitch(transition, projectId, sessionPath) : transition);
    if (openImmediately) {
      hydrateSelectedSession();
    }
    const completed = await withError(async () => {
      await desktop.openSession(projectId, sessionPath);
      return true;
    });
    if (!completed) {
      publish(cancelSessionTransition(state, projectId));
      return;
    }
    if (!openImmediately && state.runtimes[projectId]?.sessionTransitionPending) {
      publish(beginSessionSwitch(state, projectId, sessionPath));
      hydrateSelectedSession();
    }
    void refreshSessions(projectId);
  },
  async loadOlder(projectId: string) {
    const runtime = state.runtimes[projectId];
    if (!runtime?.hasOlder || runtime.historyLoading) return;
    publish(updateRuntime(state, projectId, (current) => ({ ...current, historyLoading: true })));
    const page = await withError(() =>
      desktop.loadSessionPage(
        projectId,
        runtime.historyCursor,
        100,
        state.projects.find((project) => project.id === projectId)?.activeSession ?? undefined,
      ),
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
    if (open) void this.refreshProviders();
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
  showError(message: string) {
    patch({ error: message });
  },
  async dismissNotification(key: string) {
    publish(dismissNotificationInState(state, key));
    try {
      await desktop.dismissNotification(key);
    } catch (error) {
      patch({ error: errorMessage(error) });
    }
  },
  _replaceForTest(next: AppStoreState) {
    publish(next);
  },
  _setSessions(projectId: string, sessions: SessionSummary[]) {
    publish(
      updateRuntime(state, projectId, (runtime) => ({
        ...runtime,
        sessions,
        sessionsLoaded: true,
        sessionsError: null,
      })),
    );
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
