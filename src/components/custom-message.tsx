import { lazy, Suspense } from "react";

import { StructuredData } from "@/components/structured-data";
import type { CustomItem } from "@/lib/types";

const MarkdownBody = lazy(() =>
  import("@/components/markdown-body").then((module) => ({ default: module.MarkdownBody })),
);

export function CustomMessage({ message }: { message: CustomItem }) {
  return (
    <article className="custom-message">
      <div className="message-label">[ext] {message.label}</div>
      <div className="message-body">
        {message.complete ? (
          <Suspense fallback={<div className="streaming-text">{message.text}</div>}>
            <MarkdownBody>{message.text}</MarkdownBody>
          </Suspense>
        ) : (
          <div className="streaming-text">{message.text}</div>
        )}
      </div>
      {message.details != null && (
        <details className="custom-details">
          <summary>Structured details{message.detailsTruncated ? " (truncated)" : ""}</summary>
          <StructuredData value={message.details} />
        </details>
      )}
    </article>
  );
}
