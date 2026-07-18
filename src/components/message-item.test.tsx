import { render, screen } from "@testing-library/react";
import { domAnimation, LazyMotion } from "motion/react";

import { MessageItem } from "@/components/message-item";

describe("MessageItem", () => {
  it("renders completed Markdown without executing raw HTML", async () => {
    const { container } = render(
      <LazyMotion features={domAnimation}>
        <MessageItem
          showReasoning
          message={{
            id: "assistant",
            type: "message",
            role: "assistant",
            text: "**Safe**\n\n<script>alert('unsafe')</script>",
            reasoning: "",
            complete: true,
          }}
        />
      </LazyMotion>,
    );

    expect(await screen.findByText("Safe")).toBeVisible();
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).not.toContain("unsafe");
  });

  it("keeps streaming content as pre-wrapped plain text", () => {
    render(
      <LazyMotion features={domAnimation}>
        <MessageItem
          showReasoning
          message={{
            id: "assistant",
            type: "message",
            role: "assistant",
            text: "**not parsed yet**",
            reasoning: "",
            complete: false,
          }}
        />
      </LazyMotion>,
    );
    expect(screen.getByText("**not parsed yet**")).toHaveClass("streaming-text");
  });
});
