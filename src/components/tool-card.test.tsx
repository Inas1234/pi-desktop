import { fireEvent, render, screen } from "@testing-library/react";
import { domAnimation, LazyMotion } from "motion/react";

import { ToolCard } from "@/components/tool-card";

describe("ToolCard", () => {
  it("shows compact added and removed line counts for completed edits", () => {
    render(
      <LazyMotion features={domAnimation}>
        <ToolCard
          tool={{
            id: "edit",
            type: "tool",
            name: "edit",
            args: { path: "src/app.tsx" },
            output: "Successfully replaced one block",
            status: "success",
            isError: false,
            details: { diff: "-10 old\n+10 new\n+11 another" },
            detailsTruncated: false,
            argsTruncated: false,
          }}
        />
      </LazyMotion>,
    );

    expect(screen.getByText("+2")).toHaveClass("tool-lines-added");
    expect(screen.getByText("-1")).toHaveClass("tool-lines-removed");
    expect(screen.getByTitle("2 added, 1 removed")).toBeInTheDocument();
  });

  it("renders structured subagent runs as an inspectable fleet", async () => {
    render(
      <LazyMotion features={domAnimation}>
        <ToolCard
          tool={{
            id: "delegate",
            type: "tool",
            name: "subagent",
            args: {
              tasks: [
                { agent: "scout", task: "Find the event boundary" },
                { agent: "reviewer", task: "Review the approach" },
              ],
            },
            output: "Parallel: 1/2 done, 1 running",
            status: "running",
            isError: false,
            details: {
              mode: "parallel",
              results: [
                {
                  id: "scout-1",
                  agent: "scout",
                  task: "Find the event boundary",
                  exitCode: -1,
                  model: "openai/gpt-5",
                  usage: { turns: 3, input: 900, output: 300 },
                  messages: [
                    {
                      role: "assistant",
                      content: [
                        {
                          type: "toolCall",
                          name: "read",
                          arguments: { path: "src/lib/types.ts" },
                        },
                      ],
                    },
                  ],
                },
                {
                  id: "reviewer-1",
                  agent: "reviewer",
                  task: "Review the approach",
                  exitCode: 0,
                  messages: [
                    { role: "assistant", content: [{ type: "text", text: "Looks good." }] },
                  ],
                },
              ],
            },
            detailsTruncated: false,
            argsTruncated: false,
          }}
        />
      </LazyMotion>,
    );

    expect(screen.getByText("2 subagents")).toBeVisible();
    expect(screen.getByText("parallel · 1 running · 1 done")).toBeVisible();
    expect(screen.getAllByRole("button", { name: /open subagent/i })).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Open subagent scout" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("scout · subagent");
    expect(dialog).toHaveTextContent("read · src/lib/types.ts");
    expect(dialog).toHaveTextContent("3 turns");
    expect(dialog).toHaveTextContent("1.2K tokens");
  });

  it("detects Claude-style Agent extension calls", () => {
    render(
      <LazyMotion features={domAnimation}>
        <ToolCard
          tool={{
            id: "agent-call",
            type: "tool",
            name: "Agent",
            args: {
              subagent_type: "Explore",
              prompt: "Find authentication files",
              description: "Find auth files",
              run_in_background: true,
            },
            output: "Agent started",
            status: "running",
            isError: false,
            details: {
              id: "agent-42",
              type: "Explore",
              description: "Find auth files",
              status: "running",
              activity: "Searching the repository",
            },
            detailsTruncated: false,
            argsTruncated: false,
          }}
        />
      </LazyMotion>,
    );

    expect(screen.getByText("1 subagent")).toBeVisible();
    expect(screen.getByText("Explore")).toBeVisible();
    expect(screen.getByText("Searching the repository")).toBeVisible();
    expect(screen.getByRole("button", { name: "Open subagent Explore" })).toBeVisible();
  });
});
