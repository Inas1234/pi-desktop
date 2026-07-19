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
});
