import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkspaceHeader } from "@/components/workspace-header";
import { appStore, createRuntime } from "@/stores/app-store";

describe("WorkspaceHeader", () => {
  afterEach(() => vi.restoreAllMocks());

  it("opens the Pi package manager from the main workspace", async () => {
    const runtime = createRuntime();
    runtime.connection = "connected";
    const openPackages = vi.spyOn(appStore, "setPackagesOpen").mockImplementation(() => undefined);
    const user = userEvent.setup();
    render(<WorkspaceHeader runtime={runtime} />);

    await user.click(screen.getByRole("button", { name: "Open Pi package manager" }));

    expect(openPackages).toHaveBeenCalledWith(true);
  });
});
