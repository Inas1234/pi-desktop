import { open } from "@tauri-apps/plugin-dialog";
import {
  ChevronRight,
  Folder,
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
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { desktop } from "@/lib/bridge";
import type { SessionSummary } from "@/lib/types";
import { relativeTime } from "@/lib/utils";
import { appStore, useAppStore } from "@/stores/app-store";

const INITIAL_SESSION_LIMIT = 8;

function matchesSession(session: SessionSummary, query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return `${session.name ?? ""} ${session.preview ?? ""}`.toLowerCase().includes(needle);
}

function sessionTitle(session: SessionSummary) {
  return session.name || session.preview || "New session";
}

export function Sidebar() {
  const openSidebar = useAppStore((snapshot) => snapshot.sidebarOpen);
  const projects = useAppStore((snapshot) => snapshot.projects);
  const activeProjectId = useAppStore((snapshot) => snapshot.activeProjectId);
  const runtimes = useAppStore((snapshot) => snapshot.runtimes);
  const activeProject = projects.find((project) => project.id === activeProjectId);
  const [query, setQuery] = useState("");
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(
    () => new Set(activeProjectId ? [activeProjectId] : []),
  );
  const [sessionLimits, setSessionLimits] = useState<Record<string, number>>({});
  const [pendingDeletePath, setPendingDeletePath] = useState<string | null>(null);
  const [deletingSessionPath, setDeletingSessionPath] = useState<string | null>(null);

  useEffect(() => {
    if (!activeProjectId) return;
    setExpandedProjectIds((current) => {
      if (current.has(activeProjectId)) return current;
      const next = new Set(current);
      next.add(activeProjectId);
      return next;
    });
  }, [activeProjectId]);

  useEffect(() => {
    for (const project of projects) {
      const runtime = runtimes[project.id];
      if (
        expandedProjectIds.has(project.id) &&
        runtime &&
        !runtime.sessionsLoaded &&
        !runtime.sessionsLoading &&
        !runtime.sessionsError
      ) {
        void appStore.refreshSessions(project.id);
      }
    }
  }, [expandedProjectIds, projects, runtimes]);

  async function chooseProject() {
    const selected = await open({ directory: true, multiple: false, title: "Open a project" });
    if (typeof selected === "string") setPendingPath(selected);
  }

  function toggleProject(projectId: string) {
    setExpandedProjectIds((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  }

  async function selectProject(projectId: string) {
    setExpandedProjectIds((current) => new Set(current).add(projectId));
    await appStore.selectProject(projectId);
  }

  async function createSession(projectId: string) {
    if (projectId !== activeProjectId) await appStore.selectProject(projectId);
    await appStore.newSession(projectId);
  }

  async function openSession(projectId: string, sessionPath: string) {
    await appStore.openSession(projectId, sessionPath);
  }

  async function trashSession(projectId: string, sessionPath: string) {
    setDeletingSessionPath(sessionPath);
    try {
      await desktop.trashSession(projectId, sessionPath);
      await appStore.refreshSessions(projectId);
      setPendingDeletePath(null);
    } finally {
      setDeletingSessionPath(null);
    }
  }

  return (
    <>
      <aside className="sidebar" data-open={openSidebar} aria-hidden={!openSidebar}>
        <div className="sidebar-brand">
          <span className="sidebar-wordmark">π_</span>
          <span>pi</span>
          <span className="sidebar-brand-mode">desktop</span>
          <Button
            variant="ghost"
            size="compact"
            aria-label="Open project"
            title="Open project"
            onClick={() => void chooseProject()}
          >
            <FolderPlus size={14} />
          </Button>
        </div>

        {projects.length > 0 && (
          <label className="sidebar-search">
            <Search size={12} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search sessions"
              aria-label="Search sessions"
            />
          </label>
        )}

        <div className="project-list">
          {!projects.length && (
            <button type="button" className="project-empty" onClick={() => void chooseProject()}>
              <FolderPlus size={15} />
              <strong>Open a project</strong>
              <span>Projects and their Pi sessions will appear here.</span>
            </button>
          )}

          {projects.map((project) => {
            const runtime = runtimes[project.id];
            const expanded = expandedProjectIds.has(project.id);
            const filteredSessions = (runtime?.sessions ?? []).filter((session) =>
              matchesSession(session, query),
            );
            const limit = sessionLimits[project.id] ?? INITIAL_SESSION_LIMIT;
            const visibleSessions = filteredSessions.slice(0, limit);
            const sessionChanging = Boolean(
              runtime?.sessionSwitchingTo || runtime?.sessionTransitionPending,
            );

            return (
              <section
                className="project-group"
                data-active={project.id === activeProjectId}
                key={project.id}
              >
                <div className="project-row">
                  <button
                    type="button"
                    className="project-toggle"
                    aria-label={`${expanded ? "Collapse" : "Expand"} ${project.name}`}
                    aria-expanded={expanded}
                    onClick={() => toggleProject(project.id)}
                  >
                    <ChevronRight size={13} />
                  </button>
                  <button
                    type="button"
                    className="project-row-main"
                    aria-label={`Select project ${project.name}`}
                    onClick={() => void selectProject(project.id)}
                  >
                    <span className="project-icon">
                      <Folder size={13} />
                    </span>
                    <span className="project-copy">
                      <strong>{project.name}</strong>
                      <small>{project.path}</small>
                    </span>
                    {runtime?.connection === "starting" ? (
                      <LoaderCircle className="spin" size={12} />
                    ) : (
                      <span
                        className={`run-dot ${
                          runtime?.isStreaming || Object.keys(runtime?.sessionActivity ?? {}).length
                            ? "active"
                            : ""
                        }`}
                      />
                    )}
                  </button>
                  <Button
                    className="project-new-session"
                    variant="ghost"
                    size="compact"
                    aria-label={`New session in ${project.name}`}
                    title={
                      sessionChanging
                        ? "A session change is already queued"
                        : `New session in ${project.name}`
                    }
                    disabled={sessionChanging}
                    onClick={() => void createSession(project.id)}
                  >
                    {sessionChanging ? (
                      <LoaderCircle className="spin" size={13} />
                    ) : (
                      <MessageSquarePlus size={13} />
                    )}
                  </Button>
                </div>

                {expanded && (
                  <div className="project-sessions">
                    {runtime?.sessionsLoading && !runtime.sessionsLoaded && (
                      <div className="sidebar-loading">
                        <LoaderCircle className="spin" size={12} /> Loading sessions
                      </div>
                    )}

                    {!runtime?.sessionsLoading && runtime?.sessionsError && (
                      <button
                        type="button"
                        className="session-retry"
                        onClick={() => void appStore.refreshSessions(project.id)}
                      >
                        Retry loading sessions
                      </button>
                    )}

                    {runtime?.sessionsLoaded && !filteredSessions.length && (
                      <button
                        type="button"
                        className="session-empty"
                        disabled={Boolean(query.trim())}
                        onClick={() => void createSession(project.id)}
                      >
                        {query.trim() ? "No matching sessions" : "Start a new session"}
                      </button>
                    )}

                    {visibleSessions.map((session) => {
                      const title = sessionTitle(session);
                      const selected = project.id === activeProjectId && session.isActive;
                      const activity =
                        selected && runtime?.isStreaming
                          ? "running"
                          : runtime?.sessionActivity[session.id];
                      return (
                        <div
                          className="session-row"
                          data-active={selected}
                          data-activity={activity}
                          key={session.path}
                        >
                          <button
                            type="button"
                            className="session-row-open"
                            aria-label={`Open session ${title}`}
                            disabled={sessionChanging}
                            onClick={() => void openSession(project.id, session.path)}
                          >
                            <span className="session-prefix">
                              {selected
                                ? ">"
                                : activity === "attention"
                                  ? "!"
                                  : activity
                                    ? "●"
                                    : "·"}
                            </span>
                            <strong>{title}</strong>
                            <time>{relativeTime(session.updatedAt)}</time>
                          </button>
                          {!session.isActive &&
                            (pendingDeletePath === session.path ? (
                              <div className="session-delete-actions">
                                <button
                                  type="button"
                                  className="session-delete-confirm"
                                  aria-label={`Move ${title} to Recycle Bin`}
                                  title="Move to Recycle Bin"
                                  disabled={deletingSessionPath === session.path}
                                  onClick={() => void trashSession(project.id, session.path)}
                                >
                                  {deletingSessionPath === session.path ? (
                                    <LoaderCircle className="spin" size={12} />
                                  ) : (
                                    <Trash2 size={12} />
                                  )}
                                </button>
                                <button
                                  type="button"
                                  className="session-delete-cancel"
                                  aria-label={`Cancel deleting ${title}`}
                                  title="Cancel"
                                  disabled={deletingSessionPath === session.path}
                                  onClick={() => setPendingDeletePath(null)}
                                >
                                  &times;
                                </button>
                              </div>
                            ) : (
                              <button
                                type="button"
                                className="session-more"
                                aria-label={`Delete session ${title}`}
                                title="Delete session"
                                onClick={() => setPendingDeletePath(session.path)}
                              >
                                <MoreHorizontal size={13} />
                              </button>
                            ))}
                        </div>
                      );
                    })}

                    {filteredSessions.length > visibleSessions.length && (
                      <button
                        type="button"
                        className="session-more-results"
                        onClick={() =>
                          setSessionLimits((current) => ({
                            ...current,
                            [project.id]: limit + INITIAL_SESSION_LIMIT,
                          }))
                        }
                      >
                        Show {Math.min(INITIAL_SESSION_LIMIT, filteredSessions.length - limit)} more
                      </button>
                    )}
                  </div>
                )}
              </section>
            );
          })}
        </div>

        <div className="sidebar-footer">
          {activeProject ? (
            <div className="trust-state" title="Project trust controls project-local Pi resources">
              {activeProject.trusted ? <ShieldCheck size={13} /> : <ShieldOff size={13} />}
              <span>{activeProject.trusted ? "Trusted" : "Restricted"}</span>
              <small>{activeProject.name}</small>
            </div>
          ) : (
            <span />
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
