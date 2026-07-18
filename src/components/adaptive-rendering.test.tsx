import { fireEvent, render, screen } from "@testing-library/react";
import { domAnimation, LazyMotion } from "motion/react";

import { CustomMessage } from "@/components/custom-message";
import { StructuredData } from "@/components/structured-data";
import { ToolCard } from "@/components/tool-card";

describe("adaptive extension rendering", () => {
  it("renders homogeneous records as a compact table and nested values as trees", () => {
    render(
      <StructuredData
        value={[
          { agent: "one", status: "done", result: { files: 2 } },
          { agent: "two", status: "running", result: { files: 0 } },
        ]}
      />,
    );

    expect(screen.getByRole("table")).toBeVisible();
    expect(screen.getByRole("columnheader", { name: "agent" })).toBeVisible();
    expect(screen.getByText("running")).toBeVisible();
    expect(screen.getAllByText("show")).toHaveLength(2);
  });

  it("keeps streaming tool output plain and parses completed output as safe Markdown", async () => {
    const streaming = render(
      <LazyMotion features={domAnimation}>
        <ToolCard
          tool={{
            id: "streaming",
            type: "tool",
            name: "delegate",
            args: { task: "review" },
            output: "**not parsed**",
            status: "running",
            isError: false,
            details: null,
            detailsTruncated: false,
            argsTruncated: false,
          }}
        />
      </LazyMotion>,
    );
    expect(screen.getByText("**not parsed**").tagName).toBe("PRE");
    streaming.unmount();

    const completed = render(
      <LazyMotion features={domAnimation}>
        <ToolCard
          tool={{
            id: "complete",
            type: "tool",
            name: "delegate",
            args: { task: "review", count: 2 },
            output: "## Finished\n\n<script>alert('unsafe')</script>",
            status: "success",
            isError: false,
            details: {
              agents: [
                { name: "one", state: "done" },
                { name: "two", state: "done" },
              ],
            },
            detailsTruncated: true,
            argsTruncated: false,
          }}
        />
      </LazyMotion>,
    );
    fireEvent.click(screen.getByRole("button", { name: /delegate/i }));
    expect(
      await screen.findByRole("heading", { name: "Finished" }, { timeout: 5_000 }),
    ).toBeVisible();
    expect(completed.container.querySelector("script")).toBeNull();
    expect(screen.getByText("Details (truncated)")).toBeVisible();
  });

  it("uses the same safe text and structured viewer for custom messages", async () => {
    const { container } = render(
      <CustomMessage
        message={{
          id: "custom",
          type: "custom",
          label: "subagents",
          text: "**Two agents**\n\n<script>unsafe</script>",
          details: { completed: 2, names: ["one", "two"] },
          detailsTruncated: false,
          complete: true,
        }}
      />,
    );

    expect(await screen.findByText("Two agents")).toBeVisible();
    expect(screen.getByText("[ext] subagents")).toBeVisible();
    expect(container.querySelector("script")).toBeNull();
  });
});
