import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, LoaderCircle, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { MessageItem } from "@/components/message-item";
import { ToolCard } from "@/components/tool-card";
import { Button } from "@/components/ui/button";
import type { ProjectRecord, ProjectRuntime } from "@/lib/types";
import { appStore } from "@/stores/app-store";

export function Conversation({
  project,
  runtime,
  showReasoning,
}: {
  project: ProjectRecord;
  runtime: ProjectRuntime;
  showReasoning: boolean;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const previousScrollHeight = useRef(0);
  const [pinned, setPinned] = useState(true);
  const virtualizer = useVirtualizer({
    count: runtime.messages.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => (runtime.messages[index]?.type === "tool" ? 46 : 96),
    overscan: 8,
  });

  useEffect(() => {
    if (pinned && runtime.messages.length) {
      virtualizer.scrollToIndex(runtime.messages.length - 1, { align: "end" });
    }
  }, [pinned, runtime.messages.length, virtualizer]);

  useEffect(() => {
    const element = parentRef.current;
    if (!runtime.historyLoading && element && previousScrollHeight.current > 0) {
      element.scrollTop += element.scrollHeight - previousScrollHeight.current;
      previousScrollHeight.current = 0;
    }
  }, [runtime.historyLoading]);

  function trackScroll() {
    const element = parentRef.current;
    if (!element) return;
    setPinned(element.scrollHeight - element.scrollTop - element.clientHeight < 100);
    if (element.scrollTop < 80 && runtime.hasOlder && !runtime.historyLoading) {
      previousScrollHeight.current = element.scrollHeight;
      void appStore.loadOlder(project.id);
    }
  }

  if (!runtime.messages.length) {
    return (
      <div className="conversation-empty">
        <div className="empty-prompt">pi@{project.name}:~$</div>
        <h1>
          ready for input<span className="terminal-caret">_</span>
        </h1>
        <p>
          Connected to <strong>{project.name}</strong>. Describe a task, ask about the codebase, or
          enter a Pi command.
        </p>
        <div className="empty-hints">
          <span>
            <kbd>&gt;</kbd> review this project
          </span>
          <span>
            <kbd>&gt;</kbd> find and fix a bug
          </span>
          <span>
            <kbd>&gt;</kbd> plan a feature
          </span>
        </div>
      </div>
    );
  }

  return (
    <div ref={parentRef} className="conversation-scroll" onScroll={trackScroll}>
      {runtime.historyLoading && (
        <div className="history-loading">
          <LoaderCircle className="spin" size={13} /> Loading earlier messages
        </div>
      )}
      {runtime.warning && (
        <div className="protocol-warning">
          {runtime.warning}
          <Button variant="ghost" size="sm" onClick={() => window.location.reload()}>
            <RotateCcw size={13} /> Resync
          </Button>
        </div>
      )}
      <div className="conversation-virtual" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((row) => {
          const item = runtime.messages[row.index];
          return (
            <div
              ref={virtualizer.measureElement}
              data-index={row.index}
              className="conversation-row"
              key={item.id}
              style={{ transform: `translateY(${row.start}px)` }}
            >
              {item.type === "message" && (
                <MessageItem message={item} showReasoning={showReasoning} />
              )}
              {item.type === "tool" && <ToolCard tool={item} />}
              {item.type === "notice" && <div className={`notice ${item.tone}`}>{item.text}</div>}
            </div>
          );
        })}
      </div>
      {!pinned && (
        <Button
          className="jump-latest"
          size="icon"
          aria-label="Jump to latest"
          onClick={() => {
            virtualizer.scrollToIndex(runtime.messages.length - 1, { align: "end" });
            setPinned(true);
          }}
        >
          <ArrowDown size={14} />
        </Button>
      )}
    </div>
  );
}
