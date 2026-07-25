import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Sidebar } from "@/components/sidebar";
import { desktop } from "@/lib/bridge";
import type { AppStoreState, ProjectRecord, SessionSummary } from "@/lib/types";
import { appStore, createRuntime } from "@/stores/app-store";

const projects: ProjectRecord[] = [
  {
    id: "alpha",
    name: "Alpha",
    path: "D:\\Work\\Alpha",
    trusted: true,
    activeSession: null,
    createdAt: "2026-07-18T10:00:00Z",
    lastOpenedAt: "2026-07-18T12:00:00Z",
  },
  {
    id: "beta",
    name: "Beta",
    path: "D:\\Work\\Beta",
    trusted: false,
    activeSession: null,
    createdAt: "2026-07-18T10:00:00Z",
    lastOpenedAt: "2026-07-18T11:00:00Z",
  },
];

function session(id: string, title: string, active = false): SessionSummary {
  return {
    id,
    path: `D:\\sessions\\${id}.jsonl`,
    name: title,
    preview: `${title} preview`,
    messageCount: 4,
    updatedAt: "2026-07-18T12:00:00Z",
    isActive: active,
  };
}

function sidebarState(betaLoaded = true): AppStoreState {
  const alpha = createRuntime();
  alpha.sessionsLoaded = true;
  alpha.sessions = [session("alpha-plan", "Plan authentication", true)];
  const beta = createRuntime();
  beta.sessionsLoaded = betaLoaded;
  beta.sessions = betaLoaded ? [session("beta-release", "Prepare release")] : [];
  return {
    bootstrapped: true,
    loading: false,
    error: null,
    settings: {
      theme: "system",
      idleTimeoutMinutes: 10,
      sidebarCollapsed: false,
      piPath: null,
      activeProjectId: "alpha",
      showReasoning: true,
    },
    projects,
    activeProjectId: "alpha",
    environment: null,
    providers: [],
    dismissedNotificationKeys: [],
    runtimes: { alpha, beta },
    sidebarOpen: true,
    settingsOpen: false,
    commandPaletteOpen: false,
    packagesOpen: false,
    lastEventSeq: 0,
  };
}

describe("Sidebar", () => {
  afterEach(() => vi.restoreAllMocks());

  it("shows every project and nests sessions under expandable project rows", async () => {
    appStore._replaceForTest(sidebarState());
    const user = userEvent.setup();
    render(<Sidebar />);

    expect(screen.getByRole("button", { name: "Select project Alpha" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Select project Beta" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Open session Plan authentication" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Open session Prepare release" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Expand Beta" }));
    expect(screen.getByRole("button", { name: "Open session Prepare release" })).toBeVisible();

    await user.type(screen.getByRole("textbox", { name: "Search sessions" }), "release");
    expect(screen.queryByRole("button", { name: "Open session Plan authentication" })).toBeNull();
    expect(screen.getByRole("button", { name: "Open session Prepare release" })).toBeVisible();
  });

  it("loads sessions when another project is expanded", async () => {
    appStore._replaceForTest(sidebarState(false));
    vi.spyOn(desktop, "listSessions").mockResolvedValue([
      session("beta-release", "Prepare release"),
    ]);
    const user = userEvent.setup();
    render(<Sidebar />);

    await user.click(screen.getByRole("button", { name: "Expand Beta" }));

    await waitFor(() => {
      expect(desktop.listSessions).toHaveBeenCalledWith("beta", "");
      expect(screen.getByRole("button", { name: "Open session Prepare release" })).toBeVisible();
    });
  });

  it("stops automatic retries and offers a manual retry when session loading fails", async () => {
    appStore._replaceForTest(sidebarState(false));
    vi.spyOn(desktop, "listSessions").mockRejectedValue(new Error("Session scan failed"));
    const user = userEvent.setup();
    render(<Sidebar />);

    await user.click(screen.getByRole("button", { name: "Expand Beta" }));

    expect(await screen.findByRole("button", { name: "Retry loading sessions" })).toBeVisible();
    expect(desktop.listSessions).toHaveBeenCalledTimes(1);
  });

  it("keeps session deletion controls attached to the selected session row", async () => {
    appStore._replaceForTest(sidebarState());
    vi.spyOn(desktop, "trashSession").mockResolvedValue(undefined);
    vi.spyOn(desktop, "listSessions").mockResolvedValue([
      session("beta-release", "Prepare release"),
    ]);
    const user = userEvent.setup();
    render(<Sidebar />);

    await user.click(screen.getByRole("button", { name: "Expand Beta" }));
    const sessionButton = screen.getByRole("button", { name: "Open session Prepare release" });
    await user.click(screen.getByRole("button", { name: "Delete session Prepare release" }));

    const confirm = screen.getByRole("button", {
      name: "Move Prepare release to Recycle Bin",
    });
    expect(confirm.closest(".session-row")).toBe(sessionButton.parentElement);

    await user.click(confirm);
    await waitFor(() => {
      expect(desktop.trashSession).toHaveBeenCalledWith("beta", "D:\\sessions\\beta-release.jsonl");
    });
  });

  it("selects a cross-project session before the backend switch finishes", async () => {
    appStore._replaceForTest(sidebarState());
    vi.spyOn(desktop, "openSession").mockReturnValue(new Promise(() => undefined));
    vi.spyOn(desktop, "loadSessionPage").mockReturnValue(new Promise(() => undefined));
    const selectProject = vi.spyOn(appStore, "selectProject");
    const user = userEvent.setup();
    render(<Sidebar />);

    await user.click(screen.getByRole("button", { name: "Expand Beta" }));
    const sessionButton = screen.getByRole("button", { name: "Open session Prepare release" });
    await user.click(sessionButton);

    expect(appStore.getSnapshot().activeProjectId).toBe("beta");
    expect(appStore.getSnapshot().projects[1].activeSession).toBe(
      "D:\\sessions\\beta-release.jsonl",
    );
    expect(sessionButton.parentElement).toHaveAttribute("data-active", "true");
    expect(selectProject).not.toHaveBeenCalled();
  });
});
