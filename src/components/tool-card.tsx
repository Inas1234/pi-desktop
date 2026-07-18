import * as m from "motion/react-m";
import { useEffect, useMemo, useState } from "react";

import type { ToolItem } from "@/lib/types";

function arg(record: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    if (typeof record[key] === "string") return record[key] as string;
  }
  return "";
}

function summary(tool: ToolItem): string {
  const args =
    tool.args && typeof tool.args === "object" ? (tool.args as Record<string, unknown>) : {};
  if (tool.name === "bash") return arg(args, "command");
  if (["read", "write", "edit", "ls"].includes(tool.name)) return arg(args, "path", "file_path");
  if (tool.name === "grep")
    return [arg(args, "pattern", "query"), arg(args, "path")].filter(Boolean).join(" · ");
  if (tool.name === "find") return arg(args, "pattern", "query", "path");
  return arg(args, "path", "command", "query") || "Extension tool";
}

export function ToolCard({ tool }: { tool: ToolItem }) {
  const [expanded, setExpanded] = useState(tool.status !== "success");
  const detail = useMemo(() => summary(tool), [tool]);

  useEffect(() => {
    if (tool.status === "error") setExpanded(true);
    if (tool.status === "success") setExpanded(false);
  }, [tool.status]);

  return (
    <m.section
      className="tool-card"
      data-status={tool.status}
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.16 }}
    >
      <button type="button" className="tool-header" onClick={() => setExpanded((value) => !value)}>
        <span className="tool-chevron" data-open={expanded}>
          {expanded ? "−" : "+"}
        </span>
        <span className="tool-prefix">
          {tool.status === "running" ? "[~]" : tool.status === "success" ? "[+]" : "[x]"}
        </span>
        <strong>{tool.name}</strong>
        <span className="tool-summary">{detail}</span>
        <span className="tool-state">
          {tool.status === "running" ? "running" : tool.status === "success" ? "done" : "error"}
        </span>
      </button>
      {expanded && (
        <div className="tool-content">
          {tool.output ? (
            <pre>{tool.output}</pre>
          ) : (
            <div className="tool-waiting">Waiting for output…</div>
          )}
        </div>
      )}
    </m.section>
  );
}
