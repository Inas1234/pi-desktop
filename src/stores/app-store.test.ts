import type { AppEvent, AppStoreState } from "@/lib/types";
import {
  beginSessionSwitch,
  beginSessionTransition,
  createCachedRuntime,
  createRuntime,
  dismissNotificationInState,
  hydrateRuntime,
  normalizeMessages,
  reduceEvent,
} from "@/stores/app-store";

function emptyState(): AppStoreState {
  return {
    bootstrapped: true,
    loading: false,
    error: null,
    settings: {
      theme: "system",
      idleTimeoutMinutes: 10,
      sidebarCollapsed: false,
      piPath: null,
      activeProjectId: "project",
      showReasoning: true,
    },
    projects: [],
    activeProjectId: "project",
    environment: null,
    providers: [],
    dismissedNotificationKeys: [],
    runtimes: { project: createRuntime() },
    sidebarOpen: true,
    settingsOpen: false,
    commandPaletteOpen: false,
    packagesOpen: false,
    lastEventSeq: 0,
  };
}

describe("Pi event reducer", () => {
  it("keeps the active response visible until a concurrent new session is authoritative", () => {
    let current = emptyState();
    current.projects = [
      {
        id: "project",
        name: "Project",
        path: "D:\\project",
        trusted: true,
        activeSession: "D:\\sessions\\old.jsonl",
        createdAt: "",
        lastOpenedAt: "",
      },
    ];
    current.runtimes.project.state = {
      sessionId: "old-session",
      sessionFile: "D:\\sessions\\old.jsonl",
      isStreaming: true,
    };
    current.runtimes.project.isStreaming = true;
    current.runtimes.project.isSettled = false;
    current.runtimes.project.extensionRequests = [
      {
        type: "extension_ui_request",
        id: "old-confirmation",
        method: "confirm",
        message: "Continue the old chat?",
      },
    ];
    current.runtimes.project.messages = normalizeMessages([
      { id: "assistant", role: "assistant", content: "still working" },
    ]);

    current = beginSessionTransition(current, "project", "new");

    expect(current.runtimes.project.messages[0]).toMatchObject({ text: "still working" });
    expect(current.runtimes.project.sessionTransitionPending?.kind).toBe("new");
    expect(current.runtimes.project.sessionActivity["old-session"]).toBe("running");
    expect(current.runtimes.project.backgroundExtensionRequests["old-session"]?.[0]).toMatchObject({
      id: "old-confirmation",
    });
    expect(current.runtimes.project.extensionRequests).toEqual([]);

    current = reduceEvent(current, {
      seq: 1,
      projectId: "project",
      type: "snapshot",
      state: {
        sessionId: "old-session",
        sessionFile: "D:\\sessions\\old.jsonl",
      },
      messages: [{ id: "stale", role: "user", content: "stale snapshot" }],
      models: [],
      commands: [],
      stats: {},
    });

    expect(current.runtimes.project.messages[0]).toMatchObject({ text: "still working" });
    expect(current.runtimes.project.sessionTransitionPending?.kind).toBe("new");

    current = reduceEvent(current, {
      seq: 2,
      projectId: "project",
      sessionId: "new-session",
      type: "snapshot",
      state: {
        sessionId: "new-session",
        sessionFile: "D:\\sessions\\new.jsonl",
      },
      messages: [],
      models: [],
      commands: [],
      stats: {},
    });

    expect(current.runtimes.project.messages).toEqual([]);
    expect(current.runtimes.project.sessionTransitionPending).toBeNull();
    expect(current.projects[0].activeSession).toBe("D:\\sessions\\new.jsonl");
  });

  it("keeps extension requests scoped while promoting a working background session", () => {
    let current = emptyState();
    current.projects = [
      {
        id: "project",
        name: "Project",
        path: "D:\\project",
        trusted: true,
        activeSession: "D:\\sessions\\old.jsonl",
        createdAt: "",
        lastOpenedAt: "",
      },
    ];
    current.runtimes.project.state = {
      sessionId: "old-session",
      sessionFile: "D:\\sessions\\old.jsonl",
      isStreaming: true,
    };
    current.runtimes.project.isStreaming = true;
    current.runtimes.project.isSettled = false;
    current.runtimes.project.extensionRequests = [
      {
        type: "extension_ui_request",
        id: "old-request",
        method: "input",
      },
    ];
    current.runtimes.project.sessions = [
      {
        id: "old-session",
        path: "D:\\sessions\\old.jsonl",
        name: "Old",
        preview: null,
        messageCount: 1,
        updatedAt: "2026-07-24T00:00:00Z",
        isActive: true,
      },
      {
        id: "target-session",
        path: "D:\\sessions\\target.jsonl",
        name: "Target",
        preview: null,
        messageCount: 1,
        updatedAt: "2026-07-24T00:00:00Z",
        isActive: false,
      },
    ];
    current = beginSessionTransition(current, "project", "switch", "D:\\sessions\\target.jsonl");
    current = reduceEvent(current, {
      seq: 1,
      projectId: "project",
      sessionId: "target-session",
      type: "pi_event",
      event: {
        type: "extension_ui_request",
        id: "target-request",
        method: "confirm",
      },
    });
    current = reduceEvent(current, {
      seq: 2,
      projectId: "project",
      sessionId: "target-session",
      type: "snapshot",
      state: {
        sessionId: "target-session",
        sessionFile: "D:\\sessions\\target.jsonl",
        isStreaming: true,
      },
      messages: [],
      models: [],
      commands: [],
      stats: {},
    });

    expect(current.runtimes.project.extensionRequests[0]).toMatchObject({ id: "target-request" });
    expect(current.runtimes.project.backgroundExtensionRequests["old-session"]?.[0]).toMatchObject({
      id: "old-request",
    });
    expect(current.runtimes.project.sessionActivity["old-session"]).toBe("running");
    expect(current.runtimes.project.sessionTransitionPending).toBeNull();
  });

  it("selects a clicked session immediately and clears the previous transcript", () => {
    const runtime = createRuntime();
    runtime.messages = normalizeMessages([{ id: "old", role: "user", content: "old chat" }]);
    runtime.sessions = [
      {
        id: "old",
        path: "D:\\sessions\\old.jsonl",
        name: "Old chat",
        preview: null,
        messageCount: 1,
        updatedAt: "2026-07-23T00:00:00Z",
        isActive: true,
      },
      {
        id: "new",
        path: "D:\\sessions\\new.jsonl",
        name: "New chat",
        preview: null,
        messageCount: 2,
        updatedAt: "2026-07-24T00:00:00Z",
        isActive: false,
      },
    ];
    const source = emptyState();
    source.projects = [
      {
        id: "project",
        name: "Project",
        path: "D:\\project",
        trusted: true,
        activeSession: "D:\\sessions\\old.jsonl",
        createdAt: "",
        lastOpenedAt: "",
      },
    ];
    source.runtimes.project = runtime;

    const next = beginSessionSwitch(source, "project", "D:\\sessions\\new.jsonl");

    expect(next.projects[0].activeSession).toBe("D:\\sessions\\new.jsonl");
    expect(next.runtimes.project.sessions.map((session) => session.isActive)).toEqual([
      false,
      true,
    ]);
    expect(next.runtimes.project.messages).toEqual([]);
    expect(next.runtimes.project.sessionSwitchingTo).toBe("D:\\sessions\\new.jsonl");
    expect(next.runtimes.project.state.sessionName).toBe("New chat");
  });

  it("ignores a stale snapshot while a newer session switch is pending", () => {
    let current = emptyState();
    current.projects = [
      {
        id: "project",
        name: "Project",
        path: "D:\\project",
        trusted: true,
        activeSession: "D:\\sessions\\old.jsonl",
        createdAt: "",
        lastOpenedAt: "",
      },
    ];
    current = beginSessionSwitch(current, "project", "D:\\sessions\\new.jsonl");
    current = reduceEvent(current, {
      seq: 1,
      projectId: "project",
      type: "snapshot",
      state: { sessionFile: "D:\\sessions\\old.jsonl" },
      messages: [{ id: "old", role: "user", content: "stale" }],
      models: [],
      commands: [],
      stats: {},
      historyCursor: null,
      hasOlder: false,
    });

    expect(current.runtimes.project.messages).toEqual([]);
    expect(current.runtimes.project.sessionSwitchingTo).toBe("D:\\sessions\\new.jsonl");

    current = reduceEvent(current, {
      seq: 2,
      projectId: "project",
      type: "snapshot",
      state: { sessionFile: "d:/sessions/new.jsonl" },
      messages: [{ id: "new", role: "user", content: "current" }],
      models: [],
      commands: [],
      stats: {},
      historyCursor: null,
      hasOlder: false,
    });

    expect(current.runtimes.project.messages[0]).toMatchObject({ text: "current" });
    expect(current.runtimes.project.sessionSwitchingTo).toBeNull();
  });

  it("accepts a Windows verbatim path for the selected session snapshot", () => {
    let current = emptyState();
    current.projects = [
      {
        id: "project",
        name: "Project",
        path: "D:\\project",
        trusted: true,
        activeSession: "D:\\sessions\\old.jsonl",
        createdAt: "",
        lastOpenedAt: "",
      },
    ];
    const transition = beginSessionTransition(
      current,
      "project",
      "switch",
      "C:\\Users\\pi\\sessions\\new.jsonl",
    );
    current = beginSessionSwitch(transition, "project", "C:\\Users\\pi\\sessions\\new.jsonl");

    current = reduceEvent(current, {
      seq: 1,
      projectId: "project",
      type: "snapshot",
      state: { sessionFile: "\\\\?\\C:\\Users\\pi\\sessions\\new.jsonl" },
      messages: [{ id: "new", role: "user", content: "opened" }],
      models: [],
      commands: [],
      stats: {},
    });

    expect(current.runtimes.project.messages[0]).toMatchObject({ text: "opened" });
    expect(current.runtimes.project.sessionSwitchingTo).toBeNull();
    expect(current.runtimes.project.sessionTransitionPending).toBeNull();
  });

  it("isolates background chat events and restores pending extension input when reopened", () => {
    let current = emptyState();
    current.projects = [
      {
        id: "project",
        name: "Project",
        path: "D:\\project",
        trusted: true,
        activeSession: "D:\\sessions\\active.jsonl",
        createdAt: "",
        lastOpenedAt: "",
      },
    ];
    current.runtimes.project.state = {
      sessionId: "active",
      sessionFile: "D:\\sessions\\active.jsonl",
    };
    current.runtimes.project.messages = normalizeMessages([
      { id: "active-message", role: "user", content: "keep this transcript" },
    ]);
    current.runtimes.project.sessions = [
      {
        id: "active",
        path: "D:\\sessions\\active.jsonl",
        name: "Active",
        preview: null,
        messageCount: 1,
        updatedAt: "2026-07-24T00:00:00Z",
        isActive: true,
      },
      {
        id: "background",
        path: "D:\\sessions\\background.jsonl",
        name: "Background",
        preview: null,
        messageCount: 1,
        updatedAt: "2026-07-24T00:00:00Z",
        isActive: false,
      },
    ];

    current = reduceEvent(current, {
      seq: 1,
      projectId: "project",
      sessionId: "background",
      type: "pi_events",
      events: [
        { type: "agent_start" },
        {
          type: "message_start",
          message: { id: "background-message", role: "assistant", content: "do not mix" },
        },
      ],
    });
    current = reduceEvent(current, {
      seq: 2,
      projectId: "project",
      sessionId: "background",
      type: "pi_event",
      event: {
        type: "extension_ui_request",
        id: "approval",
        method: "confirm",
        message: "Continue?",
      },
    });

    expect(current.runtimes.project.messages).toHaveLength(1);
    expect(current.runtimes.project.messages[0]).toMatchObject({ text: "keep this transcript" });
    expect(current.runtimes.project.sessionActivity.background).toBe("attention");

    current = beginSessionSwitch(current, "project", "D:\\sessions\\background.jsonl");

    expect(current.runtimes.project.state.sessionId).toBe("background");
    expect(current.runtimes.project.isStreaming).toBe(true);
    expect(current.runtimes.project.extensionRequests[0]).toMatchObject({ id: "approval" });
    expect(current.runtimes.project.sessionActivity.background).toBeUndefined();
  });

  it("restores bounded startup metadata before the live Pi snapshot arrives", () => {
    const runtime = createCachedRuntime(
      {
        id: "project",
        name: "Project",
        path: "D:\\project",
        trusted: true,
        activeSession: "D:\\sessions\\active.jsonl",
        createdAt: "",
        lastOpenedAt: "",
      },
      [{ name: "review", source: "prompt", description: "Review the project" }],
      [
        {
          id: "active",
          path: "D:\\sessions\\active.jsonl",
          name: "Active chat",
          preview: null,
          messageCount: 2,
          updatedAt: "2026-07-23T00:00:00Z",
          isActive: false,
        },
      ],
    );

    expect(runtime.commands.map((command) => command.name)).toEqual(["review"]);
    expect(runtime.sessionsLoaded).toBe(true);
    expect(runtime.sessions[0].isActive).toBe(true);
  });

  it("hydrates the active transcript directly from its bounded session page", () => {
    const runtime = hydrateRuntime(createRuntime(), {
      messages: [{ id: "u1", role: "user", content: "ready immediately" }],
      cursor: "u1",
      hasOlder: true,
    });

    expect(runtime.messages[0]).toMatchObject({ text: "ready immediately", complete: true });
    expect(runtime.historyCursor).toBe("u1");
    expect(runtime.hasOlder).toBe(true);
  });

  it("normalizes transcript messages and completed tool results", () => {
    const items = normalizeMessages([
      { role: "user", content: "hello", id: "u1" },
      {
        role: "assistant",
        id: "a1",
        content: [
          { type: "thinking", thinking: "considering" },
          { type: "text", text: "working" },
          { type: "toolCall", id: "t1", name: "read", arguments: { path: "README.md" } },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "t1",
        toolName: "read",
        content: [{ type: "text", text: "done" }],
      },
    ]);

    expect(items).toHaveLength(3);
    expect(items[1]).toMatchObject({ type: "message", text: "working", reasoning: "considering" });
    expect(items[2]).toMatchObject({ type: "tool", id: "t1", status: "success", output: "done" });
  });

  it("applies snapshots with a bounded-history cursor", () => {
    const event: AppEvent = {
      seq: 1,
      projectId: "project",
      type: "snapshot",
      state: { sessionId: "session", isStreaming: false },
      messages: [{ id: "u1", role: "user", content: "hello" }],
      models: [],
      commands: [],
      stats: {},
      historyCursor: "u1",
      hasOlder: true,
    };
    const next = reduceEvent(emptyState(), event);
    expect(next.runtimes.project.messages).toHaveLength(1);
    expect(next.runtimes.project.historyCursor).toBe("u1");
    expect(next.runtimes.project.hasOlder).toBe(true);
  });

  it("streams adjacent text into one assistant message", () => {
    let current = emptyState();
    current = reduceEvent(current, {
      seq: 1,
      projectId: "project",
      type: "pi_event",
      event: { type: "message_start", message: { role: "assistant", content: [] } },
    });
    current = reduceEvent(current, {
      seq: 2,
      projectId: "project",
      type: "pi_event",
      event: {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "hello " },
      },
    });
    current = reduceEvent(current, {
      seq: 3,
      projectId: "project",
      type: "pi_event",
      event: {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "world" },
      },
    });

    expect(current.runtimes.project.messages[0]).toMatchObject({
      text: "hello world",
      complete: false,
    });
  });

  it("marks sequence gaps and keeps tool failures expanded in state", () => {
    let current = reduceEvent(emptyState(), {
      seq: 1,
      projectId: "project",
      type: "connection",
      state: "connected",
    });
    current = reduceEvent(current, {
      seq: 3,
      projectId: "project",
      type: "pi_event",
      event: {
        type: "tool_execution_end",
        toolCallId: "tool",
        toolName: "bash",
        result: "failed",
        isError: true,
      },
    });

    expect(current.runtimes.project.warning).toContain("Event gap");
    expect(current.runtimes.project.messages[0]).toMatchObject({ status: "error", isError: true });
  });

  it("preserves bounded custom tool details and arguments", () => {
    let current = reduceEvent(emptyState(), {
      seq: 1,
      projectId: "project",
      type: "pi_event",
      event: {
        type: "tool_execution_start",
        toolCallId: "custom-tool",
        toolName: "delegate",
        args: { task: "review", agents: ["one", "two"] },
        argsTruncated: true,
      },
    });
    current = reduceEvent(current, {
      seq: 2,
      projectId: "project",
      type: "pi_event",
      event: {
        type: "tool_execution_end",
        toolCallId: "custom-tool",
        toolName: "delegate",
        result: {
          content: [{ type: "text", text: "finished" }],
          details: { agents: [{ name: "one", status: "done" }] },
          detailsTruncated: true,
        },
      },
    });

    expect(current.runtimes.project.messages[0]).toMatchObject({
      type: "tool",
      args: { task: "review", agents: ["one", "two"] },
      argsTruncated: true,
      output: "finished",
      details: { agents: [{ name: "one", status: "done" }] },
      detailsTruncated: true,
    });
  });

  it("renders displayable custom and future messages without duplicating lifecycle messages", () => {
    const paged = normalizeMessages([
      {
        id: "custom",
        role: "custom",
        customType: "subagents",
        display: true,
        content: "Two agents completed",
        details: { count: 2 },
      },
      { id: "hidden", role: "custom", customType: "state", display: false, content: "hidden" },
      { id: "future", role: "workflow", content: "Future displayable content" },
    ]);
    expect(paged).toHaveLength(2);
    expect(paged[0]).toMatchObject({
      type: "custom",
      label: "subagents",
      text: "Two agents completed",
      details: { count: 2 },
    });
    expect(paged[1]).toMatchObject({ type: "custom", label: "workflow" });

    let current = reduceEvent(emptyState(), {
      seq: 1,
      projectId: "project",
      type: "pi_event",
      event: {
        type: "message_start",
        message: { id: "user", role: "user", content: "hello" },
      },
    });
    current = reduceEvent(current, {
      seq: 2,
      projectId: "project",
      type: "pi_event",
      event: {
        type: "message_end",
        message: { id: "user", role: "user", content: "hello" },
      },
    });
    current = reduceEvent(current, {
      seq: 3,
      projectId: "project",
      type: "pi_event",
      event: {
        type: "message_start",
        message: { id: "tool-result", role: "toolResult", content: "handled by tool events" },
      },
    });
    expect(current.runtimes.project.messages).toHaveLength(1);
    expect(current.runtimes.project.messages[0]).toMatchObject({
      type: "message",
      role: "user",
      complete: true,
    });
  });

  it("queues extension dialogs and notifications while retaining widget placement and title", () => {
    let current = emptyState();
    const events = [
      { type: "extension_ui_request", id: "first", method: "confirm", title: "First" },
      { type: "extension_ui_request", id: "second", method: "input", title: "Second" },
      {
        type: "extension_ui_request",
        id: "widget",
        method: "setWidget",
        widgetKey: "agents",
        widgetLines: ["\u001b[32mone\u001b[0m", "two"],
        widgetPlacement: "belowEditor",
      },
      {
        type: "extension_ui_request",
        id: "status",
        method: "setStatus",
        statusKey: "agents",
        statusText: "\u001b[38;2;102;102;102mrunning\u001b[0m",
      },
      {
        type: "extension_ui_request",
        id: "title",
        method: "setTitle",
        title: "\u001b]0;ignored\u0007Agent team",
      },
      ...Array.from({ length: 12 }, (_, index) => ({
        type: "extension_ui_request",
        id: `notice-${index}`,
        method: "notify",
        message: `notice ${index}`,
        notifyType: index === 11 ? "unexpected" : "warning",
      })),
    ];
    for (const [index, event] of events.entries()) {
      current = reduceEvent(current, {
        seq: index + 1,
        projectId: "project",
        type: "pi_event",
        event,
      });
    }

    const runtime = current.runtimes.project;
    expect(runtime.extensionRequests.map((request) => request.id)).toEqual(["first", "second"]);
    expect(runtime.notifications).toHaveLength(10);
    expect(runtime.notifications.at(-1)).toMatchObject({ id: "notice-11", tone: "info" });
    expect(runtime.widgets.agents).toEqual({
      lines: ["one", "two"],
      placement: "belowEditor",
    });
    expect(runtime.status.agents).toBe("running");
    expect(runtime.extensionTitle).toBe("Agent team");

    current = reduceEvent(current, {
      seq: events.length + 1,
      projectId: "project",
      type: "extension_ui_expired",
      requestId: "first",
    });
    expect(current.runtimes.project.extensionRequests.map((request) => request.id)).toEqual([
      "second",
    ]);
  });

  it("suppresses dismissed notifications across projects and repeated events", () => {
    let current = reduceEvent(emptyState(), {
      seq: 1,
      projectId: "project",
      type: "pi_event",
      event: {
        type: "extension_ui_request",
        id: "first-notice",
        method: "notify",
        message: "Only show this once",
        notifyType: "warning",
      },
    });
    current = reduceEvent(current, {
      seq: 2,
      projectId: "project",
      type: "pi_event",
      event: {
        type: "extension_ui_request",
        id: "duplicate-notice",
        method: "notify",
        message: "Only show this once",
        notifyType: "warning",
      },
    });

    expect(current.runtimes.project.notifications).toHaveLength(1);
    const key = current.runtimes.project.notifications[0].key;
    current = dismissNotificationInState(
      {
        ...current,
        runtimes: {
          ...current.runtimes,
          other: {
            ...createRuntime(),
            notifications: [...current.runtimes.project.notifications],
          },
        },
      },
      key,
    );
    expect(current.runtimes.project.notifications).toEqual([]);
    expect(current.runtimes.other.notifications).toEqual([]);
    expect(current.dismissedNotificationKeys).toEqual([key]);
    current = reduceEvent(current, {
      seq: 3,
      projectId: "other",
      type: "pi_event",
      event: {
        type: "extension_ui_request",
        id: "other-project-notice",
        method: "notify",
        message: "Only show this once",
        notifyType: "warning",
      },
    });

    expect(current.runtimes.other.notifications).toEqual([]);
  });

  it("surfaces extension failures and clears transient UI when the process restarts", () => {
    let current = reduceEvent(emptyState(), {
      seq: 1,
      projectId: "project",
      type: "pi_event",
      event: {
        type: "extension_error",
        extensionPath: "C:\\extensions\\agents.ts",
        error: "failed to start",
      },
    });
    current = reduceEvent(current, {
      seq: 2,
      projectId: "project",
      type: "pi_event",
      event: { type: "extension_ui_request", id: "title", method: "setTitle", title: "Custom" },
    });
    current = reduceEvent(current, {
      seq: 3,
      projectId: "project",
      type: "connection",
      state: "connecting",
    });

    expect(current.runtimes.project.messages[0]).toMatchObject({
      type: "notice",
      tone: "error",
      text: "agents.ts: failed to start",
    });
    expect(current.runtimes.project.extensionTitle).toBeNull();
    expect(current.runtimes.project.extensionRequests).toEqual([]);
    expect(current.runtimes.project.widgets).toEqual({});
  });
});
