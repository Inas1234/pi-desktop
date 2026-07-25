import {
  Bot,
  Check,
  ChevronRight,
  Clock,
  LoaderCircle,
  Network,
  SquareTerminal,
  X,
} from "lucide-react";
import { lazy, Suspense, useState } from "react";

import { StructuredData } from "@/components/structured-data";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { SubagentGroup, SubagentRun, SubagentStatus } from "@/lib/subagents";
import { compactNumber } from "@/lib/utils";

const MarkdownBody = lazy(() =>
  import("@/components/markdown-body").then((module) => ({ default: module.MarkdownBody })),
);

function StatusIcon({ status, size = 12 }: { status: SubagentStatus; size?: number }) {
  if (status === "running") return <LoaderCircle className="spin" size={size} />;
  if (status === "queued") return <Clock size={size} />;
  if (status === "success") return <Check size={size} />;
  return <X size={size} />;
}

function statusLabel(status: SubagentStatus): string {
  if (status === "success") return "done";
  return status;
}

function groupSummary(group: SubagentGroup): string {
  const running = group.agents.filter(
    (agent) => agent.status === "running" || agent.status === "queued",
  ).length;
  const failed = group.agents.filter(
    (agent) => agent.status === "error" || agent.status === "stopped",
  ).length;
  const done = group.agents.length - running - failed;
  const states = [
    running ? `${running} running` : "",
    done ? `${done} done` : "",
    failed ? `${failed} failed` : "",
  ].filter(Boolean);
  return states.join(" · ");
}

function duration(value: number): string {
  if (value < 1_000) return `${Math.round(value)}ms`;
  if (value < 60_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}s`;
  return `${Math.floor(value / 60_000)}m ${Math.round((value % 60_000) / 1_000)}s`;
}

function metadata(agent: SubagentRun): string[] {
  return [
    agent.model,
    agent.turns !== null ? `${agent.turns} turn${agent.turns === 1 ? "" : "s"}` : "",
    agent.toolUses !== null ? `${agent.toolUses} tool use${agent.toolUses === 1 ? "" : "s"}` : "",
    agent.tokens !== null ? `${compactNumber(agent.tokens)} tokens` : "",
    agent.cost !== null ? `$${agent.cost.toFixed(4)}` : "",
    agent.durationMs !== null ? duration(agent.durationMs) : "",
  ].filter(Boolean);
}

function SubagentDialog({
  agent,
  open,
  onOpenChange,
}: {
  agent: SubagentRun;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const stats = metadata(agent);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="subagent-dialog">
        <DialogHeader className="subagent-dialog-header">
          <span className="subagent-dialog-icon" data-status={agent.status}>
            <Bot size={15} />
          </span>
          <span>
            <DialogTitle>{agent.name} · subagent</DialogTitle>
            <DialogDescription className="subagent-dialog-description">
              {agent.task || "Delegated Pi agent"}
            </DialogDescription>
          </span>
          <span className="subagent-detail-state" data-status={agent.status}>
            <StatusIcon status={agent.status} /> {statusLabel(agent.status)}
          </span>
        </DialogHeader>

        <div className="subagent-dialog-scroll">
          {stats.length > 0 && (
            <div className="subagent-metadata">
              {stats.map((item) => (
                <span key={item}>{item}</span>
              ))}
            </div>
          )}

          <section className="subagent-detail-section">
            <h3>Current activity</h3>
            <div className="subagent-current" data-status={agent.status}>
              <span>
                <StatusIcon status={agent.status} size={11} />
              </span>
              {agent.activity || "This extension has not reported an activity update yet."}
            </div>
          </section>

          {agent.trace.length > 0 && (
            <section className="subagent-detail-section">
              <h3>Recent tool trace</h3>
              <ol className="subagent-trace">
                {agent.trace.map((item) => (
                  <li key={item.id}>
                    <SquareTerminal size={12} />
                    <strong>{item.tool}</strong>
                    {item.detail && <span>{item.detail}</span>}
                  </li>
                ))}
              </ol>
            </section>
          )}

          {agent.output && (
            <section className="subagent-detail-section">
              <h3>{agent.status === "running" ? "Latest output" : "Result"}</h3>
              <div className="subagent-output message-body">
                {agent.status === "running" ? (
                  <div className="streaming-text">{agent.output}</div>
                ) : (
                  <Suspense fallback={<div className="streaming-text">{agent.output}</div>}>
                    <MarkdownBody>{agent.output}</MarkdownBody>
                  </Suspense>
                )}
              </div>
            </section>
          )}

          {!agent.trace.length && !agent.output && (
            <p className="subagent-unavailable">
              This extension reports the agent status, but does not expose its child transcript.
            </p>
          )}

          {agent.raw != null && (
            <details className="subagent-raw">
              <summary>Extension details</summary>
              <StructuredData value={agent.raw} />
            </details>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function SubagentCard({ group }: { group: SubagentGroup }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = group.agents.find((agent) => agent.id === selectedId) ?? null;
  const title = `${group.agents.length} subagent${group.agents.length === 1 ? "" : "s"}`;

  return (
    <section className="subagent-card" data-status={group.status}>
      <div className="subagent-header">
        <span className="subagent-group-icon">
          <Network size={14} />
        </span>
        <span className="subagent-heading">
          <strong>{title}</strong>
          <small>
            {group.mode !== "single" ? `${group.mode} · ` : ""}
            {groupSummary(group)}
          </small>
        </span>
        <span className="subagent-fleet">
          {group.agents.slice(0, 8).map((agent) => (
            <button
              type="button"
              className="subagent-avatar"
              data-status={agent.status}
              aria-label={`Open subagent ${agent.name}`}
              title={`${agent.name} · ${statusLabel(agent.status)}`}
              key={agent.id}
              onClick={() => setSelectedId(agent.id)}
            >
              <Bot size={11} />
              <span>
                <StatusIcon status={agent.status} size={7} />
              </span>
            </button>
          ))}
          {group.agents.length > 8 && (
            <span className="subagent-overflow">+{group.agents.length - 8}</span>
          )}
        </span>
      </div>

      <div className="subagent-list">
        {group.agents.map((agent) => (
          <button
            type="button"
            className="subagent-row"
            key={agent.id}
            onClick={() => setSelectedId(agent.id)}
          >
            <span className="subagent-row-state" data-status={agent.status}>
              <StatusIcon status={agent.status} />
            </span>
            <span className="subagent-row-copy">
              <span>
                <strong>{agent.name}</strong>
                {agent.task && <small>{agent.task}</small>}
              </span>
              <em>{agent.activity}</em>
            </span>
            <span className="subagent-row-label" data-status={agent.status}>
              {statusLabel(agent.status)}
            </span>
            <ChevronRight size={12} />
          </button>
        ))}
      </div>

      {group.detailsTruncated && (
        <div className="subagent-truncated">extension details truncated</div>
      )}
      {selected && (
        <SubagentDialog
          agent={selected}
          open
          onOpenChange={(open) => !open && setSelectedId(null)}
        />
      )}
    </section>
  );
}
