import { Boxes, Command, PanelLeft, Plus, Settings, Square } from "lucide-react";
import { useMemo, useState } from "react";

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { appStore, useAppStore } from "@/stores/app-store";

export function CommandPalette() {
  const open = useAppStore((snapshot) => snapshot.commandPaletteOpen);
  const projectId = useAppStore((snapshot) => snapshot.activeProjectId);
  const commands = useAppStore((snapshot) =>
    snapshot.activeProjectId ? (snapshot.runtimes[snapshot.activeProjectId]?.commands ?? []) : [],
  );
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const needle = query.toLowerCase();
    return commands
      .filter((command) =>
        `${command.name} ${command.description ?? ""}`.toLowerCase().includes(needle),
      )
      .slice(0, 12);
  }, [commands, query]);

  function close() {
    appStore.setCommandPaletteOpen(false);
    setQuery("");
  }

  return (
    <Dialog open={open} onOpenChange={(value) => appStore.setCommandPaletteOpen(value)}>
      <DialogContent className="palette-dialog" showClose={false}>
        <DialogHeader className="sr-only">
          <DialogTitle>Command palette</DialogTitle>
        </DialogHeader>
        <label className="palette-search">
          <Command size={15} />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Type a command…"
          />
        </label>
        <div className="palette-list">
          <button
            type="button"
            onClick={() => {
              if (projectId) void appStore.newSession(projectId);
              close();
            }}
          >
            <Plus size={14} />
            <span>
              <strong>New session</strong>
              <small>Start a clean Pi session</small>
            </span>
          </button>
          <button
            type="button"
            onClick={() => {
              appStore.setSettingsOpen(true);
              close();
            }}
          >
            <Settings size={14} />
            <span>
              <strong>Settings</strong>
              <small>App, project, and providers</small>
            </span>
          </button>
          {projectId && (
            <button
              type="button"
              onClick={() => {
                appStore.setPackagesOpen(true);
                close();
              }}
            >
              <Boxes size={14} />
              <span>
                <strong>Pi packages</strong>
                <small>Install, update, remove, and configure</small>
              </span>
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              void appStore.toggleSidebar();
              close();
            }}
          >
            <PanelLeft size={14} />
            <span>
              <strong>Toggle sidebar</strong>
              <small>Ctrl+B</small>
            </span>
          </button>
          {projectId && (
            <button
              type="button"
              onClick={() => {
                void appStore.abort(projectId);
                close();
              }}
            >
              <Square size={13} />
              <span>
                <strong>Stop Pi</strong>
                <small>Abort the active run</small>
              </span>
            </button>
          )}
          {filtered.length > 0 && <div className="palette-label">Pi commands</div>}
          {filtered.map((command) => (
            <button
              type="button"
              key={command.name}
              onClick={() => {
                if (projectId) appStore.setComposerText(projectId, `/${command.name} `);
                close();
              }}
            >
              <Command size={14} />
              <span>
                <strong>/{command.name}</strong>
                <small>{command.description}</small>
              </span>
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
