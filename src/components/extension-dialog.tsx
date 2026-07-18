import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ExtensionUIRequest } from "@/lib/types";
import { appStore } from "@/stores/app-store";

export function ExtensionDialog({
  projectId,
  request,
}: {
  projectId: string;
  request: ExtensionUIRequest | null;
}) {
  const [value, setValue] = useState("");
  const [answered, setAnswered] = useState(false);

  useEffect(() => {
    setValue(request?.id ? String(request.prefill ?? "") : "");
    setAnswered(false);
  }, [request?.id, request?.prefill]);

  function respond(response: unknown) {
    if (!request || answered) return;
    setAnswered(true);
    void appStore.respondToExtension(projectId, request.id, response);
  }

  return (
    <Dialog
      open={Boolean(request)}
      onOpenChange={(open) => {
        if (!open && request && !answered) respond({ cancelled: true });
      }}
    >
      <DialogContent showClose={false}>
        <DialogHeader>
          <DialogTitle>{request?.title ?? "Pi extension"}</DialogTitle>
          {request?.message && <DialogDescription>{request.message}</DialogDescription>}
        </DialogHeader>

        {request?.method === "select" && (
          <div className="extension-options">
            {(request.options ?? []).map((option) => (
              <button type="button" key={option} onClick={() => respond({ value: option })}>
                {option}
              </button>
            ))}
          </div>
        )}

        {(request?.method === "input" || request?.method === "editor") &&
          (request.method === "editor" ? (
            <textarea
              className="extension-editor"
              autoFocus
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder={String(request.placeholder ?? "")}
            />
          ) : (
            <input
              className="field-input"
              autoFocus
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder={String(request.placeholder ?? "")}
              onKeyDown={(event) => event.key === "Enter" && respond({ value })}
            />
          ))}

        {request && !["select", "confirm", "input", "editor"].includes(request.method) && (
          <DialogDescription>
            This extension requested a custom interface Pi Desktop cannot render. Cancel it here and
            run the extension in Pi’s terminal UI if needed.
          </DialogDescription>
        )}

        {request?.method !== "select" && (
          <div className="dialog-actions">
            <Button
              onClick={() =>
                respond(request?.method === "confirm" ? { confirmed: false } : { cancelled: true })
              }
            >
              {request?.method === "confirm" ? "No" : "Cancel"}
            </Button>
            {["confirm", "input", "editor"].includes(request?.method ?? "") && (
              <Button
                variant="primary"
                onClick={() =>
                  respond(request?.method === "confirm" ? { confirmed: true } : { value })
                }
              >
                {request?.method === "confirm" ? "Yes" : "Continue"}
              </Button>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
