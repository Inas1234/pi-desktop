import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { PackageManagerDialog } from "@/components/package-manager-dialog";
import type { AppStoreState, PackageOperationResult, ProjectRecord } from "@/lib/types";
import { appStore, createRuntime } from "@/stores/app-store";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  catalog: vi.fn(),
  run: vi.fn(),
  cancel: vi.fn(),
  reload: vi.fn(),
  config: vi.fn(),
  openUrl: vi.fn(),
}));

vi.mock("@/lib/bridge", () => ({
  desktop: {
    listPiPackages: mocks.list,
    browsePiPackageCatalog: mocks.catalog,
    runPiPackageOperation: mocks.run,
    cancelPiPackageOperation: mocks.cancel,
    reloadPiResources: mocks.reload,
    openPiPackageConfig: mocks.config,
  },
}));

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: mocks.openUrl }));

const project: ProjectRecord = {
  id: "project",
  name: "Example",
  path: "C:\\repo",
  trusted: true,
  activeSession: null,
  createdAt: "2026-01-01T00:00:00Z",
  lastOpenedAt: "2026-01-01T00:00:00Z",
};

function storeState(currentProject = project): AppStoreState {
  return {
    bootstrapped: true,
    loading: false,
    error: null,
    settings: {
      theme: "system",
      idleTimeoutMinutes: 10,
      sidebarCollapsed: false,
      piPath: null,
      activeProjectId: currentProject.id,
      showReasoning: true,
    },
    projects: [currentProject],
    activeProjectId: currentProject.id,
    environment: null,
    providers: [],
    dismissedNotificationKeys: [],
    runtimes: { [currentProject.id]: createRuntime() },
    sidebarOpen: true,
    settingsOpen: false,
    commandPaletteOpen: false,
    packagesOpen: true,
    lastEventSeq: 0,
  };
}

const installed = [
  {
    source: "npm:pi-agents",
    scope: "user" as const,
    installedPath: "C:\\Users\\me\\.pi\\agent\\npm\\pi-agents",
    filtered: true,
  },
];

const catalog = {
  items: [
    {
      name: "pi-subagents",
      description: "Delegate work to parallel subagents.",
      author: "nicopreme",
      downloads: 113_300,
      published: "18h ago",
      types: ["extension"],
      npmUrl: "https://www.npmjs.com/package/pi-subagents",
      repositoryUrl: "https://github.com/example/pi-subagents",
      detailUrl: "https://pi.dev/packages/pi-subagents",
    },
  ],
  page: 1,
  pageCount: 106,
  total: 5300,
  from: 1,
  to: 50,
};

describe("PackageManagerDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    mocks.list.mockResolvedValue(installed);
    mocks.catalog.mockResolvedValue(catalog);
    mocks.run.mockResolvedValue({
      packages: installed,
      restartedProjectIds: [],
      warnings: [],
    });
    mocks.cancel.mockResolvedValue(true);
    mocks.reload.mockResolvedValue([]);
    mocks.config.mockResolvedValue(undefined);
    mocks.openUrl.mockResolvedValue(undefined);
    appStore._replaceForTest(storeState());
  });

  afterEach(() => vi.unstubAllGlobals());

  it("browses the official catalog in-app and preserves installed package controls", async () => {
    const restricted = { ...project, trusted: false };
    appStore._replaceForTest(storeState(restricted));
    const user = userEvent.setup();
    render(<PackageManagerDialog project={restricted} />);

    expect(await screen.findByText("pi-subagents")).toBeVisible();
    expect(screen.getByText("Delegate work to parallel subagents.")).toBeVisible();
    expect(screen.getByText(/1–50 of 5,300/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Project" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: /details/i }));
    expect(mocks.openUrl).toHaveBeenCalledWith("https://pi.dev/packages/pi-subagents");
    await user.click(screen.getByRole("tab", { name: /installed/i }));
    expect(await screen.findByText("npm:pi-agents")).toBeVisible();
    expect(screen.getByText("filtered")).toBeVisible();
    expect(screen.getByText(/project-local packages are unavailable/i)).toBeVisible();
    await user.click(screen.getByRole("button", { name: /pi config \(user\)/i }));
    expect(mocks.config).toHaveBeenCalledWith("project", "user");
  });

  it("searches, pages, and installs catalog packages through Pi", async () => {
    const user = userEvent.setup();
    render(<PackageManagerDialog project={project} />);
    expect(await screen.findByText("pi-subagents")).toBeVisible();

    await user.type(screen.getByPlaceholderText(/search packages/i), "agents");
    await user.selectOptions(screen.getByLabelText("Package type"), "extension");
    await user.selectOptions(screen.getByLabelText("Sort packages"), "recent");
    await user.click(screen.getByRole("button", { name: "Search" }));
    expect(mocks.catalog).toHaveBeenLastCalledWith({
      name: "agents",
      packageType: "extension",
      sort: "recent",
      page: 1,
    });

    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(mocks.catalog).toHaveBeenLastCalledWith({
      name: "agents",
      packageType: "extension",
      sort: "recent",
      page: 2,
    });

    await user.click(screen.getByRole("button", { name: "Install" }));
    expect(mocks.run).toHaveBeenCalledWith(
      "project",
      { kind: "install", source: "npm:pi-subagents", scope: "user" },
      expect.any(Function),
    );
  });

  it("streams install progress and cancels by operation id", async () => {
    const user = userEvent.setup();
    let finish: ((result: PackageOperationResult) => void) | undefined;
    mocks.run.mockImplementation((_projectId, _request, onProgress) => {
      onProgress({ operationId: "operation", phase: "started", message: "Installing local" });
      return new Promise<PackageOperationResult>((resolve) => {
        finish = resolve;
      });
    });
    render(<PackageManagerDialog project={project} />);
    await screen.findByText("pi-subagents");
    await user.click(screen.getByRole("tab", { name: /installed/i }));

    await user.type(screen.getByLabelText("Install another source"), ".\\local-package");
    await user.click(screen.getByRole("button", { name: "Project" }));
    await user.click(screen.getByRole("button", { name: /install$/i }));

    expect(mocks.run).toHaveBeenCalledWith(
      "project",
      { kind: "install", source: ".\\local-package", scope: "project" },
      expect.any(Function),
    );
    expect(await screen.findByText("Installing local")).toBeVisible();
    await user.click(screen.getByRole("button", { name: /cancel/i }));
    expect(mocks.cancel).toHaveBeenCalledWith("operation");

    await act(async () => {
      finish?.({ packages: installed, restartedProjectIds: ["project"], warnings: [] });
    });
    expect(await screen.findByText(/restarted 1 active project/i)).toBeVisible();
  });

  it("updates, removes, reloads, and reports operation errors", async () => {
    const user = userEvent.setup();
    render(<PackageManagerDialog project={project} />);
    await screen.findByText("pi-subagents");
    await user.click(screen.getByRole("tab", { name: /installed/i }));

    await user.click(screen.getByRole("button", { name: "Update" }));
    expect(mocks.run).toHaveBeenLastCalledWith(
      "project",
      { kind: "update", source: "npm:pi-agents", scope: "user" },
      expect.any(Function),
    );
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(mocks.run).toHaveBeenLastCalledWith(
      "project",
      { kind: "remove", source: "npm:pi-agents", scope: "user" },
      expect.any(Function),
    );
    await user.click(screen.getByRole("button", { name: /reload resources/i }));
    expect(mocks.reload).toHaveBeenCalledWith("project");

    mocks.run.mockRejectedValueOnce(new Error("package failed"));
    await user.click(screen.getByRole("button", { name: "Update" }));
    expect(await screen.findByText("package failed")).toBeVisible();
    await waitFor(() => expect(mocks.list).toHaveBeenCalled());
  });
});
