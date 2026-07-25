import { fireEvent, render, screen } from "@testing-library/react";

import { Conversation } from "@/components/conversation";
import type { ProjectRecord } from "@/lib/types";
import { createRuntime } from "@/stores/app-store";

const project: ProjectRecord = {
  id: "alpha",
  name: "Alpha",
  path: "D:\\Work\\Alpha",
  trusted: true,
  activeSession: "D:\\sessions\\alpha.jsonl",
  createdAt: "2026-07-18T10:00:00Z",
  lastOpenedAt: "2026-07-18T12:00:00Z",
};

describe("Conversation", () => {
  it("anchors the jump-to-latest control outside the scrolling transcript", () => {
    const runtime = createRuntime();
    runtime.messages = [
      {
        id: "notice-1",
        type: "notice",
        tone: "info",
        text: "Session ready",
      },
    ];

    const { container } = render(
      <Conversation project={project} runtime={runtime} showReasoning={true} />,
    );
    const scroll = container.querySelector<HTMLElement>(".conversation-scroll");
    expect(scroll).not.toBeNull();
    Object.defineProperties(scroll as HTMLElement, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 200 },
      scrollTop: { configurable: true, value: 100, writable: true },
    });

    fireEvent.scroll(scroll as HTMLElement);

    const jump = screen.getByRole("button", { name: "Jump to latest" });
    expect(jump.parentElement).toHaveClass("conversation-region");
    expect(scroll).not.toContainElement(jump);
  });
});
