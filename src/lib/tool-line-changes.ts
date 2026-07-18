import type { ToolItem } from "@/lib/types";

export interface ToolLineChanges {
  added: number;
  removed: number;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function lineCount(value: unknown): number {
  if (typeof value !== "string" || value.length === 0) return 0;
  let count = 1;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) === 0x0a) count += 1;
  }
  return value.charCodeAt(value.length - 1) === 0x0a ? count - 1 : count;
}

function diffLineChanges(value: unknown): ToolLineChanges | null {
  if (typeof value !== "string" || value.length === 0) return null;
  let added = 0;
  let removed = 0;
  let lineStart = true;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (lineStart) {
      if (character === "+" && !value.startsWith("+++", index)) added += 1;
      if (character === "-" && !value.startsWith("---", index)) removed += 1;
      lineStart = false;
    }
    if (character === "\n") lineStart = true;
  }

  return added > 0 || removed > 0 ? { added, removed } : null;
}

function editArgumentChanges(args: Record<string, unknown>): ToolLineChanges | null {
  const edits = Array.isArray(args.edits) ? args.edits : [args];
  let added = 0;
  let removed = 0;
  for (const edit of edits) {
    const values = record(edit);
    if (!values) continue;
    added += lineCount(values.newText ?? values.new_text);
    removed += lineCount(values.oldText ?? values.old_text);
  }
  return added > 0 || removed > 0 ? { added, removed } : null;
}

export function toolLineChanges(tool: ToolItem): ToolLineChanges | null {
  if (tool.status !== "success") return null;
  const name = tool.name.toLowerCase();
  if (name !== "edit" && name !== "write") return null;

  const details = record(tool.details);
  const exact = diffLineChanges(details?.diff) ?? diffLineChanges(details?.patch);
  if (exact) return exact;

  const args = record(tool.args);
  if (!args) return null;
  if (name === "edit") return editArgumentChanges(args);

  const added = lineCount(args.content ?? args.text);
  return added > 0 ? { added, removed: 0 } : null;
}
