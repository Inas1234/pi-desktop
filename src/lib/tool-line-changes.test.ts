import { toolLineChanges } from "@/lib/tool-line-changes";
import type { ToolItem } from "@/lib/types";

function tool(overrides: Partial<ToolItem>): ToolItem {
  return {
    id: "tool",
    type: "tool",
    name: "edit",
    args: {},
    output: "",
    status: "success",
    isError: false,
    details: null,
    detailsTruncated: false,
    argsTruncated: false,
    ...overrides,
  };
}

describe("toolLineChanges", () => {
  it("uses Pi's exact edit diff when it is available", () => {
    expect(
      toolLineChanges(
        tool({
          details: { diff: " 1 context\n-2 old\n+2 new\n+3 another" },
          args: { oldText: "fallback", newText: "fallback" },
        }),
      ),
    ).toEqual({ added: 2, removed: 1 });
  });

  it("counts write content without creating a second file read", () => {
    expect(
      toolLineChanges(tool({ name: "write", args: { path: "file.ts", content: "one\ntwo\n" } })),
    ).toEqual({ added: 2, removed: 0 });
  });

  it("supports batched edit arguments as a bounded fallback", () => {
    expect(
      toolLineChanges(
        tool({
          args: {
            edits: [
              { oldText: "old", newText: "new\nline" },
              { oldText: "remove\nthis", newText: "replacement" },
            ],
          },
        }),
      ),
    ).toEqual({ added: 3, removed: 3 });
  });

  it("does not report planned changes for failed or running tools", () => {
    const args = { oldText: "old", newText: "new" };
    expect(toolLineChanges(tool({ args, status: "error", isError: true }))).toBeNull();
    expect(toolLineChanges(tool({ args, status: "running" }))).toBeNull();
  });
});
