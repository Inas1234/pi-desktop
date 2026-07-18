import * as Collapsible from "@radix-ui/react-collapsible";
import { ChevronRight } from "lucide-react";
import * as m from "motion/react-m";
import { lazy, Suspense } from "react";

import type { MessageItem as Message } from "@/lib/types";

const MarkdownBody = lazy(() =>
  import("@/components/markdown-body").then((module) => ({ default: module.MarkdownBody })),
);

export function MessageItem({
  message,
  showReasoning,
}: {
  message: Message;
  showReasoning: boolean;
}) {
  return (
    <m.article
      className="message"
      data-role={message.role}
      initial={{ opacity: 0, y: 5 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
    >
      <div className="message-label">{message.role === "user" ? "> you" : "π pi"}</div>
      {message.role === "assistant" && message.reasoning && showReasoning && (
        <Collapsible.Root className="reasoning-row">
          <Collapsible.Trigger className="reasoning-trigger">
            <ChevronRight size={12} /> [thinking]
          </Collapsible.Trigger>
          <Collapsible.Content className="reasoning-content">
            {message.reasoning}
          </Collapsible.Content>
        </Collapsible.Root>
      )}
      <div className="message-body">
        {message.complete ? (
          <Suspense fallback={<div className="streaming-text">{message.text}</div>}>
            <MarkdownBody>{message.text}</MarkdownBody>
          </Suspense>
        ) : (
          <div className="streaming-text">
            {message.text}
            <span className="stream-caret" />
          </div>
        )}
      </div>
    </m.article>
  );
}
