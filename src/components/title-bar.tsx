import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, PanelLeft, Square, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { appStore, useAppStore } from "@/stores/app-store";

export function TitleBar() {
  const sidebarOpen = useAppStore((snapshot) => snapshot.sidebarOpen);
  const activeProject = useAppStore((snapshot) =>
    snapshot.projects.find((project) => project.id === snapshot.activeProjectId),
  );

  const windowAction = (action: "minimize" | "maximize" | "close") => {
    const appWindow = getCurrentWindow();
    if (action === "minimize") void appWindow.minimize();
    if (action === "maximize") void appWindow.toggleMaximize();
    if (action === "close") void appWindow.close();
  };

  return (
    <header className="titlebar" data-tauri-drag-region>
      <div className="titlebar-left" data-tauri-drag-region>
        <Button
          className="titlebar-sidebar"
          variant="ghost"
          size="compact"
          aria-label={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
          title="Toggle sidebar (Ctrl+B)"
          onClick={() => void appStore.toggleSidebar()}
        >
          <PanelLeft size={15} />
        </Button>
        <span className="titlebar-title" data-tauri-drag-region>
          <strong>pi</strong>
          <span>{activeProject ? ` / ${activeProject.name}` : " / desktop"}</span>
        </span>
      </div>
      <div className="window-controls">
        <button type="button" aria-label="Minimize" onClick={() => windowAction("minimize")}>
          <Minus size={14} />
        </button>
        <button type="button" aria-label="Maximize" onClick={() => windowAction("maximize")}>
          <Square size={11} />
        </button>
        <button
          type="button"
          className="window-close"
          aria-label="Close"
          onClick={() => windowAction("close")}
        >
          <X size={15} />
        </button>
      </div>
    </header>
  );
}
