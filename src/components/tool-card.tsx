import * as m from "motion/react-m";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";

import { StructuredData } from "@/components/structured-data";
import { toolLineChanges } from "@/lib/tool-line-changes";
import type { ToolItem } from "@/lib/types";

const MarkdownBody = lazy(() =>
  import("@/components/markdown-body").then((module) => ({ default: module.MarkdownBody })),
);

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
  const preferred = arg(args, "path", "command", "query", "task", "agent", "url");
  if (preferred) return preferred;
  const scalar = Object.entries(args)
    .filter(([, value]) => ["string", "number", "boolean"].includes(typeof value))
    .slice(0, 2)
    .map(([key, value]) => `${key}:${String(value)}`)
    .join(" · ");
  if (scalar) return scalar;
  const collection = Object.entries(args).find(([, value]) => Array.isArray(value));
  return collection ? `${collection[0]}:${(collection[1] as unknown[]).length}` : "custom tool";
}

export function ToolCard({ tool }: { tool: ToolItem }) {
  const [expanded, setExpanded] = useState(tool.status !== "success");
  const detail = useMemo(() => summary(tool), [tool]);
  const lineChanges = useMemo(() => toolLineChanges(tool), [tool]);

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
        {lineChanges && (
          <span
            className="tool-line-changes"
            title={`${lineChanges.added} added, ${lineChanges.removed} removed`}
          >
            {lineChanges.added > 0 && (
              <span className="tool-lines-added">+{lineChanges.added}</span>
            )}
            {lineChanges.removed > 0 && (
              <span className="tool-lines-removed">-{lineChanges.removed}</span>
            )}
          </span>
        )}
        <span className="tool-state">
          {tool.status === "running" ? "running" : tool.status === "success" ? "done" : "error"}
        </span>
      </button>
      {expanded && (
        <div className="tool-content">
          {tool.output ? (
            tool.status === "running" ? (
              <pre>{tool.output}</pre>
            ) : (
              <div className="tool-markdown message-body">
                <Suspense fallback={<pre>{tool.output}</pre>}>
                  <MarkdownBody>{tool.output}</MarkdownBody>
                </Suspense>
              </div>
            )
          ) : (
            <div className="tool-waiting">Waiting for output…</div>
          )}
          {typeof tool.args === "object" &&
            tool.args !== null &&
            Object.keys(tool.args).length > 0 && (
              <details className="tool-structured">
                <summary>Arguments{tool.argsTruncated ? " (truncated)" : ""}</summary>
                <StructuredData value={tool.args} />
              </details>
            )}
          {tool.details != null && (
            <details className="tool-structured">
              <summary>Details{tool.detailsTruncated ? " (truncated)" : ""}</summary>
              <StructuredData value={tool.details} />
            </details>
          )}
        </div>
      )}
    </m.section>
  );
}
