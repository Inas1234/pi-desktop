import { isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Check, Copy } from "lucide-react";
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { Button } from "@/components/ui/button";

function Code({ className, children, ...props }: React.ComponentProps<"code">) {
  const [copied, setCopied] = useState(false);
  const text = String(children ?? "").replace(/\n$/, "");
  const block = Boolean(className?.includes("language-")) || text.includes("\n");
  if (!block)
    return (
      <code className="inline-code" {...props}>
        {children}
      </code>
    );
  return (
    <div className="code-block">
      <Button
        className="code-copy"
        variant="ghost"
        size="compact"
        aria-label="Copy code"
        onClick={() => {
          void navigator.clipboard.writeText(text);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1_200);
        }}
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </Button>
      <pre>
        <code className={className} {...props}>
          {children}
        </code>
      </pre>
    </div>
  );
}

export function MarkdownBody({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      skipHtml
      components={{
        code: Code,
        a: ({ href, ...props }) => {
          const external = href && /^https?:\/\//i.test(href);
          return (
            <a
              href={external ? href : undefined}
              target="_blank"
              rel="noreferrer"
              onClick={(event) => {
                if (!external) event.preventDefault();
                else if (isTauri()) {
                  event.preventDefault();
                  void openUrl(href);
                }
              }}
              {...props}
            />
          );
        },
      }}
    >
      {children}
    </ReactMarkdown>
  );
}
