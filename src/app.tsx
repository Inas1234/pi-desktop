import { open } from "@tauri-apps/plugin-dialog";
import { AlertTriangle, FolderOpen, LoaderCircle, RefreshCw, Settings } from "lucide-react";
import { LazyMotion, MotionConfig } from "motion/react";
import { lazy, Suspense, useEffect, useState } from "react";

import { Composer } from "@/components/composer";
import { Conversation } from "@/components/conversation";
import { ExtensionDialog } from "@/components/extension-dialog";
import { PiMark } from "@/components/pi-mark";
import { Sidebar } from "@/components/sidebar";
import { TitleBar } from "@/components/title-bar";
import { Button } from "@/components/ui/button";
import { WorkspaceHeader } from "@/components/workspace-header";
import { desktop } from "@/lib/bridge";
import { appStore, useAppStore } from "@/stores/app-store";

const SettingsDialog = lazy(() =>
  import("@/components/settings-dialog").then((module) => ({ default: module.SettingsDialog })),
);
const CommandPalette = lazy(() =>
  import("@/components/command-palette").then((module) => ({ default: module.CommandPalette })),
);
const PackageManagerDialog = lazy(() =>
  import("@/components/package-manager-dialog").then((module) => ({
    default: module.PackageManagerDialog,
  })),
);

export default function App() {
  const snapshot = useAppStore((value) => value);
  const [quickPath, setQuickPath] = useState<string | null>(null);
  const project = snapshot.projects.find((item) => item.id === snapshot.activeProjectId);
  const runtime = project ? snapshot.runtimes[project.id] : undefined;

  useEffect(() => {
    void appStore.initialize();
  }, []);

  useEffect(() => {
    document.title = runtime?.extensionTitle || "Pi Desktop";
  }, [runtime?.extensionTitle]);

  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if (event.ctrlKey && event.key.toLowerCase() === "b") {
        event.preventDefault();
        void appStore.toggleSidebar();
      }
      if (event.ctrlKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        appStore.setCommandPaletteOpen(true);
      }
      if (event.ctrlKey && event.key.toLowerCase() === "l") {
        event.preventDefault();
        window.dispatchEvent(new Event("pi:model-picker"));
      }
    }
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, []);

  async function chooseFirstProject() {
    const selected = await open({ directory: true, multiple: false, title: "Open a project" });
    if (typeof selected === "string") setQuickPath(selected);
  }

  if (snapshot.loading) {
    return (
      <div className="splash">
        <PiMark />
        <LoaderCircle className="spin" size={17} />
        <span>Starting Pi Desktop</span>
      </div>
    );
  }

  return (
    <LazyMotion
      features={() => import("@/lib/motion-features").then((module) => module.default)}
      strict
    >
      <MotionConfig reducedMotion="user">
        <div className="app-shell">
          <TitleBar />
          <div className="app-body">
            <Sidebar />
            <main className="workspace">
              {!snapshot.environment?.compatible ? (
                <div className="setup-state">
                  <span className="setup-marker">[!]</span>
                  <h1>pi runtime not found</h1>
                  <p>{snapshot.environment?.message ?? "Pi could not be diagnosed."}</p>
                  <code>pnpm add -g @earendil-works/pi-coding-agent</code>
                  <div>
                    <Button variant="primary" onClick={() => appStore.setSettingsOpen(true)}>
                      <Settings size={14} /> Open settings
                    </Button>
                    <Button onClick={() => window.location.reload()}>
                      <RefreshCw size={14} /> Check again
                    </Button>
                  </div>
                </div>
              ) : !project || !runtime ? (
                <div className="setup-state">
                  <span className="setup-marker">[dir]</span>
                  <h1>select a working directory</h1>
                  <p>
                    Choose the folder Pi should work in. You decide whether project-local Pi
                    resources are trusted.
                  </p>
                  <Button variant="primary" onClick={() => void chooseFirstProject()}>
                    <FolderOpen size={14} /> Open project
                  </Button>
                  {quickPath && (
                    <div className="quick-trust">
                      <code>{quickPath}</code>
                      <p>
                        Allow Pi to load project-local settings, extensions, prompts, and packages?
                      </p>
                      <div>
                        <Button
                          onClick={() => {
                            void appStore.addProject(quickPath, false);
                            setQuickPath(null);
                          }}
                        >
                          Open restricted
                        </Button>
                        <Button
                          variant="primary"
                          onClick={() => {
                            void appStore.addProject(quickPath, true);
                            setQuickPath(null);
                          }}
                        >
                          Trust and open
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <>
                  <WorkspaceHeader runtime={runtime} />
                  {runtime.connection === "error" && (
                    <div className="connection-error">
                      <span>{runtime.connectionMessage}</span>
                      <Button size="sm" onClick={() => void desktop.restartProject(project.id)}>
                        <RefreshCw size={13} /> Restart
                      </Button>
                    </div>
                  )}
                  <Conversation
                    project={project}
                    runtime={runtime}
                    showReasoning={snapshot.settings.showReasoning}
                  />
                  <Composer project={project} runtime={runtime} />
                  <ExtensionDialog
                    projectId={project.id}
                    request={runtime.extensionRequests[0] ?? null}
                  />
                </>
              )}
            </main>
          </div>
          {snapshot.error && (
            <button type="button" className="app-toast error" onClick={() => appStore.clearError()}>
              <AlertTriangle size={14} />
              <span>{snapshot.error}</span>
              <small>Dismiss</small>
            </button>
          )}
          {project && runtime?.notifications[0] && (
            <button
              type="button"
              className={`app-toast ${runtime.notifications[0].tone}`}
              onClick={() => void appStore.dismissNotification(runtime.notifications[0].key)}
            >
              <span>{runtime.notifications[0].message}</span>
              <small>Dismiss</small>
            </button>
          )}
          <Suspense fallback={null}>
            {snapshot.settingsOpen && <SettingsDialog />}
            {snapshot.commandPaletteOpen && <CommandPalette />}
            {snapshot.packagesOpen && project && <PackageManagerDialog project={project} />}
          </Suspense>
        </div>
      </MotionConfig>
    </LazyMotion>
  );
}
