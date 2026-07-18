import { render, screen } from "@testing-library/react";
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
});
