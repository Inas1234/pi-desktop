import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Composer } from "@/components/composer";
import type { PiCommand, ProjectRecord } from "@/lib/types";
import { appStore, createRuntime } from "@/stores/app-store";

const project: ProjectRecord = {
  id: "project",
  name: "Project",
  path: "D:\\Project",
  trusted: true,
  activeSession: null,
  createdAt: "2026-07-19T00:00:00Z",
  lastOpenedAt: "2026-07-19T00:00:00Z",
};

const catalog: PiCommand[] = [
  {
    name: "settings",
    description: "Open settings menu",
    source: "builtin",
    invocation: "interactive",
  },
  {
    name: "model",
    description: "Select model",
    argumentHint: "<provider/model>",
    source: "builtin",
    invocation: "interactive",
  },
  {
    name: "compact",
    description: "Manually compact context",
    source: "builtin",
    invocation: "interactive",
  },
];

describe("Composer command catalog", () => {
  afterEach(() => vi.restoreAllMocks());

  it("renders Pi catalog order, argument hints, and terminal-only labels", async () => {
    const runtime = createRuntime();
    runtime.commands = catalog;
    const user = userEvent.setup();
    render(<Composer project={project} runtime={runtime} />);

    await user.type(screen.getByRole("textbox", { name: "Message Pi" }), "/");

    const options = screen.getAllByRole("option");
    expect(options.slice(0, 3).map((option) => option.textContent)).toEqual([
      "/settingsOpen settings menu",
      "/model <provider/model>Select model",
      "/compactManually compact contextCLI",
    ]);
  });

  it("does not send terminal-only commands to the model", async () => {
    const runtime = createRuntime();
    runtime.commands = catalog;
    const showError = vi.spyOn(appStore, "showError").mockImplementation(() => undefined);
    const send = vi.spyOn(appStore, "send").mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<Composer project={project} runtime={runtime} />);

    await user.type(screen.getByRole("textbox", { name: "Message Pi" }), "/compact ");
    await user.keyboard("{Enter}");

    expect(showError).toHaveBeenCalledWith(expect.stringContaining("Pi's terminal UI"));
    expect(send).not.toHaveBeenCalled();
  });

  it("does not accept a prompt until the selected session is ready", () => {
    const runtime = createRuntime();
    runtime.sessionSwitchingTo = "D:\\sessions\\next.jsonl";

    render(<Composer project={project} runtime={runtime} />);

    expect(screen.getByRole("textbox", { name: "Message Pi" })).toBeDisabled();
    expect(screen.getByText("Opening session...")).toBeVisible();
  });

  it("keeps input disabled during a concurrent new-session handoff", () => {
    const runtime = createRuntime();
    runtime.isStreaming = true;
    runtime.isSettled = false;
    runtime.sessionTransitionPending = {
      kind: "new",
      fromSessionId: "current",
    };

    render(<Composer project={project} runtime={runtime} />);

    expect(screen.getByRole("textbox", { name: "Message Pi" })).toBeDisabled();
    expect(screen.getByText("Opening new session...")).toBeVisible();
  });
});
