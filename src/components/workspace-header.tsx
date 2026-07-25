import { Boxes } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { ProjectRuntime } from "@/lib/types";
import { appStore } from "@/stores/app-store";

interface WorkspaceHeaderProps {
  runtime: ProjectRuntime;
}

export function WorkspaceHeader({ runtime }: WorkspaceHeaderProps) {
  return (
    <div className="workspace-header">
      <div className="workspace-header-session">
        <strong>/ {runtime.state.sessionName || "new session"}</strong>
        <span className={`connection-dot ${runtime.connection}`} />{" "}
        <small>
          {runtime.connection === "starting"
            ? "Starting Pi"
            : runtime.sessionSwitchingTo
              ? "Opening session"
              : runtime.isStreaming
                ? "Pi is working"
                : runtime.connection === "connected"
                  ? "Ready"
                  : runtime.connection}
        </small>
      </div>
      <div className="workspace-header-actions">
        {runtime.state.isCompacting && <span className="compact-state">Compacting context…</span>}
        <Button
          className="workspace-package-button"
          variant="ghost"
          size="compact"
          aria-label="Open Pi package manager"
          title="Open Pi package manager"
          onClick={() => appStore.setPackagesOpen(true)}
        >
          <Boxes size={13} />
          <span>Packages</span>
        </Button>
      </div>
    </div>
  );
}
