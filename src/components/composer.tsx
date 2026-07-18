import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { open } from "@tauri-apps/plugin-dialog";
import { ArrowUp, ChevronDown, CircleStop, ImagePlus, Paperclip, X } from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { desktopSlashCommand, matchingSlashCommands } from "@/lib/slash-commands";
import type { ProjectRecord, ProjectRuntime, ThinkingLevel } from "@/lib/types";
import { compactNumber, fileName } from "@/lib/utils";
import { appStore } from "@/stores/app-store";

const levels: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const ModelPicker = lazy(() =>
  import("@/components/model-picker").then((module) => ({ default: module.ModelPicker })),
);

function contextPercent(runtime: ProjectRuntime): number | null {
  const usage = runtime.stats.contextUsage as Record<string, unknown> | undefined;
  if (typeof usage?.percent === "number") return Math.round(usage.percent);
  const tokens = runtime.stats.tokens as Record<string, unknown> | undefined;
  const total = typeof tokens?.total === "number" ? tokens.total : 0;
  const window = runtime.state.model?.contextWindow;
  return total && window ? Math.min(100, Math.round((total / window) * 100)) : null;
}

export function Composer({
  project,
  runtime,
}: {
  project: ProjectRecord;
  runtime: ProjectRuntime;
}) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [modelOpen, setModelOpen] = useState(false);
  const [activeCommand, setActiveCommand] = useState(0);
  const [suggestionsDismissed, setSuggestionsDismissed] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const model = runtime.state.model;
  const thinking = runtime.state.thinkingLevel ?? "off";
  const pending = runtime.state.pendingMessageCount ?? 0;
  const context = contextPercent(runtime);
  const widgets = Object.entries(runtime.widgets);
  const aboveWidgets = widgets.filter(([, widget]) => widget.placement === "aboveEditor");
  const belowWidgets = widgets.filter(([, widget]) => widget.placement === "belowEditor");
  const commands = useMemo(
    () => (suggestionsDismissed ? [] : matchingSlashCommands(text, runtime.commands)),
    [runtime.commands, suggestionsDismissed, text],
  );

  useEffect(() => {
    if (runtime.composerText == null) return;
    setText(runtime.composerText);
    appStore.consumeComposerText(project.id);
    requestAnimationFrame(() => textarea.current?.focus());
  }, [project.id, runtime.composerText]);

  useEffect(() => {
    const element = textarea.current;
    if (!element) return;
    if (element.value !== text) return;
    element.style.height = "0px";
    element.style.height = `${Math.min(180, Math.max(42, element.scrollHeight))}px`;
  }, [text]);

  useEffect(() => {
    const openPicker = () => setModelOpen(true);
    window.addEventListener("pi:model-picker", openPicker);
    return () => window.removeEventListener("pi:model-picker", openPicker);
  }, []);

  async function attachImages() {
    const selected = await open({
      multiple: true,
      directory: false,
      title: "Attach images",
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }],
    });
    if (Array.isArray(selected)) setImages((current) => [...new Set([...current, ...selected])]);
    else if (typeof selected === "string")
      setImages((current) => [...new Set([...current, selected])]);
  }

  function completeCommand(command = commands[activeCommand]) {
    if (!command) return;
    setText(`/${command.name} `);
    setSuggestionsDismissed(false);
    requestAnimationFrame(() => textarea.current?.focus());
  }

  function runDesktopCommand(value: string): boolean {
    const command = desktopSlashCommand(value);
    if (!command) return false;
    setText("");
    setImages([]);
    if (command === "new") void appStore.newSession(project.id);
    if (command === "model") setModelOpen(true);
    if (command === "settings" || command === "login") appStore.setSettingsOpen(true);
    if (command === "packages") appStore.setPackagesOpen(true);
    return true;
  }

  function submit(behavior?: "prompt" | "steer" | "follow_up") {
    if (!text.trim() && !images.length) return;
    if (!images.length && runDesktopCommand(text)) return;
    const mode = behavior ?? (runtime.isStreaming ? "steer" : "prompt");
    const value = text;
    const attachments = images;
    setText("");
    setImages([]);
    void appStore.send(project.id, value, attachments, mode);
    requestAnimationFrame(() => textarea.current?.focus());
  }

  function cycleThinking() {
    const index = Math.max(0, levels.indexOf(thinking));
    void appStore.setThinking(project.id, levels[(index + 1) % levels.length]);
  }

  return (
    <div className="composer-wrap">
      {aboveWidgets.length > 0 && (
        <div className="extension-widget">
          {aboveWidgets.flatMap(([key, widget]) =>
            widget.lines.map((line) => <div key={`${key}:${line}`}>{line}</div>),
          )}
        </div>
      )}
      <div className="composer" data-streaming={runtime.isStreaming}>
        {images.length > 0 && (
          <div className="attachment-list">
            {images.map((path) => (
              <span key={path}>
                <ImagePlus size={13} /> {fileName(path)}
                <button
                  type="button"
                  onClick={() => setImages((value) => value.filter((item) => item !== path))}
                >
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        )}
        {commands.length > 0 && (
          <div className="command-suggestions" role="listbox" aria-label="Slash commands">
            {commands.map((command, index) => (
              <button
                type="button"
                role="option"
                aria-selected={index === activeCommand}
                data-active={index === activeCommand}
                key={command.name}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => completeCommand(command)}
              >
                <strong>/{command.name}</strong>
                <span>{command.description}</span>
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={textarea}
          value={text}
          rows={1}
          spellCheck
          aria-label="Message Pi"
          placeholder={runtime.isStreaming ? "> steer pi..." : "> ask pi or run /command..."}
          onChange={(event) => {
            setText(event.target.value);
            setActiveCommand(0);
            setSuggestionsDismissed(false);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (commands.length > 0 && event.key === "ArrowDown") {
              event.preventDefault();
              setActiveCommand((index) => (index + 1) % commands.length);
              return;
            }
            if (commands.length > 0 && event.key === "ArrowUp") {
              event.preventDefault();
              setActiveCommand((index) => (index - 1 + commands.length) % commands.length);
              return;
            }
            if (commands.length > 0 && event.key === "Tab" && !event.shiftKey) {
              event.preventDefault();
              completeCommand();
              return;
            }
            if (commands.length > 0 && event.key === "Escape") {
              event.preventDefault();
              setSuggestionsDismissed(true);
              return;
            }
            if (event.key === "Escape" && runtime.isStreaming) {
              event.preventDefault();
              void appStore.abort(project.id);
              return;
            }
            if (event.key === "Tab" && event.shiftKey) {
              event.preventDefault();
              cycleThinking();
              return;
            }
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              if (commands.length > 0 && !event.altKey) {
                completeCommand();
                return;
              }
              submit(event.altKey ? "follow_up" : undefined);
            }
          }}
        />
        <div className="composer-footer">
          <div className="composer-controls">
            <Button
              variant="ghost"
              size="compact"
              aria-label="Attach image"
              title="Attach image"
              onClick={() => void attachImages()}
            >
              <Paperclip size={15} />
            </Button>
            <button
              type="button"
              className="text-control"
              onClick={() => setModelOpen(true)}
              title="Choose model (Ctrl+L)"
            >
              <span>{model?.name ?? model?.id ?? "Model"}</span>
              <ChevronDown size={12} />
            </button>
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button type="button" className="text-control" title="Thinking level (Shift+Tab)">
                  <span>think:{thinking}</span>
                  <ChevronDown size={12} />
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content className="menu-content" sideOffset={8} align="start">
                  {levels.map((level) => (
                    <DropdownMenu.Item
                      className="menu-item"
                      data-active={thinking === level}
                      key={level}
                      onSelect={() => void appStore.setThinking(project.id, level)}
                    >
                      {level === "off" ? "Off" : level[0].toUpperCase() + level.slice(1)}
                    </DropdownMenu.Item>
                  ))}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
            {context != null && (
              <span className="context-usage" title="Estimated context usage">
                ctx:{context}%
              </span>
            )}
            {pending > 0 && <span className="queue-count">queue:{pending}</span>}
            {Object.entries(runtime.status).map(([key, status]) => (
              <span className="extension-status" key={key}>
                {status}
              </span>
            ))}
          </div>
          <div className="send-controls">
            {runtime.isStreaming && (
              <Button
                variant="ghost"
                size="compact"
                aria-label="Stop"
                title="Stop (Esc)"
                onClick={() => void appStore.abort(project.id)}
              >
                <CircleStop size={16} />
              </Button>
            )}
            <Button
              variant="primary"
              size="icon"
              aria-label={runtime.isStreaming ? "Steer Pi" : "Send message"}
              disabled={!text.trim() && !images.length}
              onClick={() => submit()}
            >
              <ArrowUp size={16} />
            </Button>
          </div>
        </div>
        <div className="composer-hint">
          Enter {runtime.isStreaming ? "steers" : "sends"} · Alt+Enter queues · Shift+Enter newline
        </div>
      </div>
      {belowWidgets.length > 0 && (
        <div className="extension-widget extension-widget-below">
          {belowWidgets.flatMap(([key, widget]) =>
            widget.lines.map((line) => <div key={`${key}:${line}`}>{line}</div>),
          )}
        </div>
      )}
      {Boolean(runtime.stats.tokens) && (
        <span className="token-total">
          {compactNumber(Number((runtime.stats.tokens as Record<string, unknown>).total ?? 0))}{" "}
          tokens
        </span>
      )}
      {modelOpen && (
        <Suspense fallback={null}>
          <ModelPicker
            open
            onOpenChange={setModelOpen}
            models={runtime.models}
            selected={model}
            onSelect={(next) => void appStore.setModel(project.id, next.provider, next.id)}
          />
        </Suspense>
      )}
    </div>
  );
}
