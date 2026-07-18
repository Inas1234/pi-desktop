import type { AppEvent, AppStoreState } from "@/lib/types";
import { createRuntime, normalizeMessages, reduceEvent } from "@/stores/app-store";

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
    runtimes: { project: createRuntime() },
    sidebarOpen: true,
    settingsOpen: false,
    commandPaletteOpen: false,
    packagesOpen: false,
    lastEventSeq: 0,
  };
}

describe("Pi event reducer", () => {
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
