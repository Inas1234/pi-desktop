import type { CustomItem, ToolItem } from "@/lib/types";

export type SubagentStatus = "queued" | "running" | "success" | "error" | "stopped";

export interface SubagentTraceItem {
  id: string;
  tool: string;
  detail: string;
}

export interface SubagentRun {
  id: string;
  name: string;
  task: string;
  status: SubagentStatus;
  activity: string;
  output: string;
  model: string;
  turns: number | null;
  tokens: number | null;
  cost: number | null;
  durationMs: number | null;
  toolUses: number | null;
  trace: SubagentTraceItem[];
  raw: unknown;
}

export interface SubagentGroup {
  id: string;
  mode: string;
  agents: SubagentRun[];
  status: "running" | "success" | "error";
  detailsTruncated: boolean;
  rawDetails: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstString(record: Record<string, unknown> | null, keys: string[]): string {
  if (!record) return "";
  for (const key of keys) {
    if (typeof record[key] === "string" && record[key]) return record[key];
  }
  return "";
}

function firstNumber(record: Record<string, unknown> | null, keys: string[]): number | null {
  if (!record) return null;
  for (const key of keys) {
    if (typeof record[key] === "number" && Number.isFinite(record[key])) return record[key];
  }
  return null;
}

function clip(value: string, limit = 180): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  return singleLine.length > limit ? `${singleLine.slice(0, limit - 1)}…` : singleLine;
}

function isSubagentLabel(value: string): boolean {
  const label = value.trim().toLowerCase();
  return (
    label === "agent" ||
    label === "subagent" ||
    label === "subagents" ||
    /^spawn[-_:]?agent$/.test(label) ||
    /^run[-_:]?subagent$/.test(label) ||
    /^subagent[-_:]?run$/.test(label)
  );
}

function statusFrom(record: Record<string, unknown>, fallback: SubagentStatus): SubagentStatus {
  const status = firstString(record, ["status", "state", "phase", "stopReason"]).toLowerCase();
  if (/queue|pending|waiting/.test(status)) return "queued";
  if (/running|active|working|start|stream/.test(status)) return "running";
  if (/complete|success|succeed|done|finish/.test(status)) return "success";
  if (/stop|cancel|interrupt/.test(status)) return "stopped";
  if (/error|fail|abort|timeout/.test(status)) return "error";
  if (record.running === true || record.isRunning === true) return "running";
  if (record.completed === true || record.isComplete === true) return "success";
  if (record.isError === true || record.error) return "error";
  const exitCode = firstNumber(record, ["exitCode", "exit_code", "code"]);
  if (exitCode === -1) return "running";
  if (exitCode === 0) return "success";
  if (exitCode !== null) return "error";
  return fallback;
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((block) => {
      if (typeof block === "string") return block;
      const item = asRecord(block);
      return item?.type === "text" && typeof item.text === "string" ? item.text : "";
    })
    .join("");
}

function summarizeArgs(value: unknown): string {
  const args = asRecord(value);
  if (!args) return "";
  const preferred = firstString(args, [
    "path",
    "file_path",
    "command",
    "query",
    "pattern",
    "url",
    "description",
  ]);
  if (preferred) return clip(preferred, 110);
  const scalar = Object.entries(args).find(
    ([key, item]) => key !== "content" && ["string", "number", "boolean"].includes(typeof item),
  );
  return scalar ? clip(`${scalar[0]}: ${String(scalar[1])}`, 110) : "";
}

function messageData(record: Record<string, unknown>): {
  output: string;
  trace: SubagentTraceItem[];
} {
  const messages = Array.isArray(record.messages) ? record.messages : [];
  const trace: SubagentTraceItem[] = [];
  let output = "";
  for (const [messageIndex, messageValue] of messages.entries()) {
    const message = asRecord(messageValue);
    if (!message) continue;
    if (message.role === "assistant") {
      const text = contentText(message.content);
      if (text.trim()) output = text;
      if (Array.isArray(message.content)) {
        for (const [blockIndex, blockValue] of message.content.entries()) {
          const block = asRecord(blockValue);
          if (block?.type !== "toolCall") continue;
          trace.push({
            id: `${messageIndex}-${blockIndex}`,
            tool: firstString(block, ["name", "toolName"]) || "tool",
            detail: summarizeArgs(block.arguments ?? block.args),
          });
        }
      }
    }
  }
  const directCalls = Array.isArray(record.toolCalls) ? record.toolCalls : [];
  for (const [index, callValue] of directCalls.entries()) {
    const call = asRecord(callValue);
    if (!call) continue;
    trace.push({
      id: `direct-${index}`,
      tool: firstString(call, ["name", "toolName", "tool"]) || "tool",
      detail: summarizeArgs(call.arguments ?? call.args),
    });
  }
  return { output, trace: trace.slice(-64) };
}

function recordsFrom(details: unknown, args: unknown): Record<string, unknown>[] {
  const detailRecord = asRecord(details);
  const nestedDetails = asRecord(detailRecord?.details);
  for (const source of [detailRecord, nestedDetails]) {
    if (!source) continue;
    for (const key of ["results", "agents", "runs", "children", "tasks"]) {
      if (Array.isArray(source[key])) {
        const records = (source[key] as unknown[]).map(asRecord).filter(Boolean);
        if (records.length) return records as Record<string, unknown>[];
      }
    }
    for (const key of ["result", "run", "agent"]) {
      const single = asRecord(source[key]);
      if (single) return [single];
    }
    if (firstString(source, ["agent", "name", "type", "subagent_type", "id", "agentId"])) {
      return [source];
    }
  }

  const argsRecord = asRecord(args);
  if (Array.isArray(argsRecord?.tasks)) {
    const records = argsRecord.tasks.map(asRecord).filter(Boolean);
    if (records.length) return records as Record<string, unknown>[];
  }
  return argsRecord ? [argsRecord] : [];
}

function runFrom(
  record: Record<string, unknown>,
  index: number,
  groupId: string,
  args: Record<string, unknown> | null,
  fallbackStatus: SubagentStatus,
): SubagentRun {
  const usage = asRecord(record.usage) ?? asRecord(record.tokens);
  const message = messageData(record);
  const name =
    firstString(record, [
      "displayName",
      "display_name",
      "agent",
      "name",
      "type",
      "subagent_type",
    ]) ||
    firstString(args, ["displayName", "agent", "name", "subagent_type", "type"]) ||
    `agent ${index + 1}`;
  const task =
    firstString(record, ["description", "task", "prompt", "goal", "label"]) ||
    firstString(args, ["description", "task", "prompt", "goal"]);
  const directOutput = firstString(record, ["finalOutput", "output", "response"]);
  const output = message.output || directOutput;
  const status = statusFrom(record, fallbackStatus);
  const directActivity = firstString(record, [
    "activity",
    "currentActivity",
    "current_activity",
    "lastAction",
    "last_action",
    "statusText",
    "summary",
  ]);
  const lastTrace = message.trace.at(-1);
  const activity = directActivity
    ? clip(directActivity)
    : status === "running" && lastTrace
      ? `${lastTrace.tool}${lastTrace.detail ? ` · ${lastTrace.detail}` : ""}`
      : status === "queued"
        ? "Waiting to start"
        : status === "success"
          ? "Completed"
          : status === "stopped"
            ? "Stopped"
            : status === "error"
              ? clip(firstString(record, ["errorMessage", "error", "stderr"]) || "Failed")
              : "";
  const input = firstNumber(usage, ["input", "inputTokens", "input_tokens"]) ?? 0;
  const generated = firstNumber(usage, ["output", "outputTokens", "output_tokens"]) ?? 0;
  const tokens = firstNumber(usage, ["total", "totalTokens", "total_tokens"]);

  return {
    id:
      firstString(record, ["id", "agentId", "agent_id", "runId", "run_id", "sessionId"]) ||
      `${groupId}-${index}`,
    name,
    task,
    status,
    activity,
    output,
    model: firstString(record, ["model", "modelId", "model_id"]),
    turns: firstNumber(usage, ["turns"]) ?? firstNumber(record, ["turns"]),
    tokens: tokens ?? (input + generated > 0 ? input + generated : null),
    cost: firstNumber(usage, ["cost", "totalCost", "total_cost"]),
    durationMs: firstNumber(record, ["durationMs", "duration_ms", "elapsedMs", "elapsed_ms"]),
    toolUses:
      firstNumber(record, ["toolUses", "tool_uses", "toolCallCount"]) ??
      (message.trace.length ? message.trace.length : null),
    trace: message.trace,
    raw: record,
  };
}

function aggregateStatus(agents: SubagentRun[]): SubagentGroup["status"] {
  if (agents.some((agent) => agent.status === "running" || agent.status === "queued")) {
    return "running";
  }
  if (agents.some((agent) => agent.status === "error" || agent.status === "stopped"))
    return "error";
  return "success";
}

function groupFrom(
  id: string,
  details: unknown,
  args: unknown,
  fallbackStatus: SubagentStatus,
  detailsTruncated: boolean,
): SubagentGroup {
  const argsRecord = asRecord(args);
  const detailRecord = asRecord(details);
  const records = recordsFrom(details, args);
  const agents = records.map((record, index) =>
    runFrom(record, index, id, argsRecord, fallbackStatus),
  );
  return {
    id,
    mode:
      firstString(detailRecord, ["mode", "kind", "workflow"]) ||
      firstString(argsRecord, ["mode"]) ||
      (agents.length > 1 ? "parallel" : "single"),
    agents,
    status: aggregateStatus(agents),
    detailsTruncated,
    rawDetails: details,
  };
}

export function subagentGroupFromTool(tool: ToolItem): SubagentGroup | null {
  if (!isSubagentLabel(tool.name)) return null;
  const fallback: SubagentStatus =
    tool.status === "running" ? "running" : tool.status === "error" ? "error" : "success";
  const group = groupFrom(
    tool.id,
    tool.details,
    tool.args,
    fallback,
    tool.detailsTruncated || tool.argsTruncated,
  );
  if (!group.agents.length) return null;
  if (group.agents.length === 1 && !group.agents[0].output && tool.output) {
    group.agents[0].output = tool.output;
  }
  return group;
}

export function subagentGroupFromCustom(message: CustomItem): SubagentGroup | null {
  if (!isSubagentLabel(message.label)) return null;
  const detailRecord = asRecord(message.details);
  const names = Array.isArray(detailRecord?.names)
    ? detailRecord.names.filter((name): name is string => typeof name === "string")
    : [];
  const count = Math.max(
    names.length,
    firstNumber(detailRecord, ["count", "total", "agentCount", "agent_count"]) ?? 0,
  );
  let details = message.details;
  if (!recordsFrom(details, null).length && count > 0) {
    details = {
      ...(detailRecord ?? {}),
      agents: Array.from({ length: count }, (_, index) => ({
        name: names[index] || `agent ${index + 1}`,
      })),
    };
  }
  const group = groupFrom(
    message.id,
    details,
    null,
    message.complete ? "success" : "running",
    message.detailsTruncated,
  );
  if (!group.agents.length) return null;
  if (group.agents.length === 1 && !group.agents[0].output && message.text) {
    group.agents[0].output = message.text;
  }
  group.rawDetails = message.details;
  return group;
}
