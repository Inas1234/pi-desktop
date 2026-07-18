import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { CommandPalette } from "@/components/command-palette";
import type { AppStoreState } from "@/lib/types";
import { appStore, createRuntime } from "@/stores/app-store";

describe("CommandPalette", () => {
  it("opens Pi package management for the active project", async () => {
    const current: AppStoreState = {
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
      commandPaletteOpen: true,
      packagesOpen: false,
      lastEventSeq: 0,
    };
    appStore._replaceForTest(current);
    const user = userEvent.setup();
    render(<CommandPalette />);

    await user.click(screen.getByRole("button", { name: /pi packages/i }));
    expect(appStore.getSnapshot().packagesOpen).toBe(true);
    expect(appStore.getSnapshot().commandPaletteOpen).toBe(false);
  });
});
