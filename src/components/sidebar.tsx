import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { open } from "@tauri-apps/plugin-dialog";
import {
  ChevronDown,
  FolderPlus,
  LoaderCircle,
  MessageSquarePlus,
  MoreHorizontal,
  Search,
  Settings,
  ShieldCheck,
  ShieldOff,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { desktop } from "@/lib/bridge";
import { relativeTime } from "@/lib/utils";
import { appStore, useAppStore } from "@/stores/app-store";

export function Sidebar() {
  const openSidebar = useAppStore((snapshot) => snapshot.sidebarOpen);
  const projects = useAppStore((snapshot) => snapshot.projects);
  const activeProjectId = useAppStore((snapshot) => snapshot.activeProjectId);
  const runtime = useAppStore((snapshot) =>
    activeProjectId ? snapshot.runtimes[activeProjectId] : undefined,
  );
  const activeProject = projects.find((project) => project.id === activeProjectId);
  const [query, setQuery] = useState("");
  const [pendingPath, setPendingPath] = useState<string | null>(null);

  useEffect(() => {
    if (!activeProjectId) return;
    const timeout = window.setTimeout(
      () => void appStore.refreshSessions(activeProjectId, query),
      180,
    );
    return () => clearTimeout(timeout);
  }, [activeProjectId, query]);

  const sessions = useMemo(() => runtime?.sessions ?? [], [runtime?.sessions]);

  async function chooseProject() {
    const selected = await open({ directory: true, multiple: false, title: "Open a project" });
    if (typeof selected === "string") setPendingPath(selected);
  }

  return (
    <>
      <aside className="sidebar" data-open={openSidebar} aria-hidden={!openSidebar}>
        <div className="sidebar-brand">
          <span className="sidebar-wordmark">π_</span>
          <span>pi</span>
          <small>rpc</small>
        </div>

        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button type="button" className="project-switcher" aria-label="Switch project">
              <span className="project-glyph">{activeProject ? "~/" : "--"}</span>
              <span className="project-switcher-copy">
                <strong>{activeProject?.name ?? "No project"}</strong>
                <small>{activeProject?.path ?? "Open a folder to begin"}</small>
              </span>
              {runtime?.connection === "starting" ? (
                <LoaderCircle className="spin" size={14} />
              ) : (
                <span className={`run-dot ${runtime?.isStreaming ? "active" : ""}`} />
              )}
              <ChevronDown size={14} />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content className="menu-content" sideOffset={6} align="start">
              {projects.map((project) => {
                const projectRuntime = appStore.getSnapshot().runtimes[project.id];
                return (
                  <DropdownMenu.Item
                    className="menu-project"
                    key={project.id}
                    onSelect={() => void appStore.selectProject(project.id)}
                  >
                    <span className="project-glyph small">~/</span>
                    <span>
                      <strong>{project.name}</strong>
                      <small>{project.path}</small>
                    </span>
                    <span className={`run-dot ${projectRuntime?.isStreaming ? "active" : ""}`} />
                  </DropdownMenu.Item>
                );
              })}
              {projects.length > 0 && <DropdownMenu.Separator className="menu-separator" />}
              <DropdownMenu.Item className="menu-item" onSelect={() => void chooseProject()}>
                <FolderPlus size={14} /> Open project
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>

        {activeProject && (
          <>
            <div className="session-tools">
              <label className="session-search">
                <Search size={12} />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="filter sessions"
                  aria-label="Search sessions"
                />
              </label>
              <Button
                variant="ghost"
                size="compact"
                title="New session"
                aria-label="New session"
                onClick={() => void appStore.newSession(activeProject.id)}
              >
                <MessageSquarePlus size={14} />
              </Button>
            </div>
            <div className="sidebar-section-label">
              <span>sessions</span>
              <small>{sessions.length}</small>
            </div>
          </>
        )}

        <div className="session-list">
          {runtime?.sessionsLoading && !sessions.length && (
            <div className="sidebar-loading">
              <LoaderCircle className="spin" size={14} /> Loading sessions
            </div>
          )}
          {!runtime?.sessionsLoading && activeProject && !sessions.length && (
            <button
              type="button"
              className="session-empty"
              onClick={() => void appStore.newSession(activeProject.id)}
            >
              Start a new session
              <span>Your Pi history stays in Pi’s JSONL files.</span>
            </button>
          )}
          {sessions.map((session) => (
            <div className="session-row" data-active={session.isActive} key={session.path}>
              <button
                type="button"
                className="session-row-open"
                onClick={() =>
                  activeProject && void appStore.openSession(activeProject.id, session.path)
                }
              >
                <span className="session-prefix">{session.isActive ? ">" : "·"}</span>
                <span className="session-row-copy">
                  <strong>{session.name || session.preview || "New session"}</strong>
                  <small>{session.preview || `${session.messageCount} messages`}</small>
                </span>
                <time>{relativeTime(session.updatedAt)}</time>
              </button>
              {!session.isActive && activeProject && (
                <DropdownMenu.Root>
                  <DropdownMenu.Trigger asChild>
                    <button type="button" className="session-more" aria-label="Session menu">
                      <MoreHorizontal size={14} />
                    </button>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content className="menu-content" side="right" align="start">
                      <DropdownMenu.Item
                        className="menu-item danger-text"
                        onSelect={() =>
                          void desktop
                            .trashSession(activeProject.id, session.path)
                            .then(() => appStore.refreshSessions(activeProject.id))
                        }
                      >
                        <Trash2 size={14} /> Move to Recycle Bin
                      </DropdownMenu.Item>
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
              )}
            </div>
          ))}
        </div>

        <div className="sidebar-footer">
          {activeProject && (
            <div className="trust-state" title="Project trust controls project-local Pi resources">
              {activeProject.trusted ? <ShieldCheck size={13} /> : <ShieldOff size={13} />}
              {activeProject.trusted ? "Trusted" : "Restricted"}
            </div>
          )}
          <Button
            variant="ghost"
            size="compact"
            aria-label="Settings"
            title="Settings"
            onClick={() => appStore.setSettingsOpen(true)}
          >
            <Settings size={15} />
          </Button>
        </div>
      </aside>

      <Dialog open={Boolean(pendingPath)} onOpenChange={(open) => !open && setPendingPath(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Trust this project?</DialogTitle>
            <DialogDescription>
              Pi can load project-local settings, extensions, prompts, and packages from this
              folder. Trust does not change Pi tool execution or add a separate approval layer.
            </DialogDescription>
          </DialogHeader>
          <div className="trust-path">{pendingPath}</div>
          <div className="dialog-actions">
            <Button
              onClick={() => {
                if (pendingPath) void appStore.addProject(pendingPath, false);
                setPendingPath(null);
              }}
            >
              Open restricted
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                if (pendingPath) void appStore.addProject(pendingPath, true);
                setPendingPath(null);
              }}
            >
              Trust and open
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
