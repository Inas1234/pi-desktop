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
});
