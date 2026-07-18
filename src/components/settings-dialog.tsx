import { open } from "@tauri-apps/plugin-dialog";
import { Boxes, Check, ExternalLink, KeyRound, ShieldCheck, ShieldOff, Trash2 } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { desktop } from "@/lib/bridge";
import type { Theme } from "@/lib/types";
import { appStore, useAppStore } from "@/stores/app-store";

export function SettingsDialog() {
  const isOpen = useAppStore((snapshot) => snapshot.settingsOpen);
  const settings = useAppStore((snapshot) => snapshot.settings);
  const environment = useAppStore((snapshot) => snapshot.environment);
  const providers = useAppStore((snapshot) => snapshot.providers);
  const project = useAppStore((snapshot) =>
    snapshot.projects.find((item) => item.id === snapshot.activeProjectId),
  );
  const [providerId, setProviderId] = useState<string | null>(null);
  const [secret, setSecret] = useState("");

  async function choosePi() {
    const selected = await open({
      multiple: false,
      directory: false,
      title: "Choose pi.cmd or pi.exe",
      filters: [{ name: "Executable", extensions: ["cmd", "exe", "bat"] }],
    });
    if (typeof selected === "string") void appStore.updateSettings({ piPath: selected });
  }

  return (
    <Dialog open={isOpen} onOpenChange={(open) => appStore.setSettingsOpen(open)}>
      <DialogContent className="settings-dialog">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            Pi Desktop keeps app preferences here. Pi continues to own agent settings and sessions.
          </DialogDescription>
        </DialogHeader>
        <div className="settings-scroll">
          <section className="settings-section">
            <h3>Appearance</h3>
            <div className="setting-row">
              <span>
                <strong>Theme</strong>
                <small>Follow Windows or choose a fixed theme.</small>
              </span>
              <div className="theme-segment">
                {(["system", "light", "dark"] as Theme[]).map((theme) => (
                  <button
                    type="button"
                    data-active={settings.theme === theme}
                    key={theme}
                    onClick={() => void appStore.updateSettings({ theme })}
                  >
                    {theme}
                  </button>
                ))}
              </div>
            </div>
            <div className="setting-row">
              <span>
                <strong>Show reasoning</strong>
                <small>Reasoning stays collapsed in the transcript.</small>
              </span>
              <button
                type="button"
                className="switch"
                data-on={settings.showReasoning}
                onClick={() =>
                  void appStore.updateSettings({ showReasoning: !settings.showReasoning })
                }
              >
                <span />
              </button>
            </div>
          </section>

          <section className="settings-section">
            <h3>Pi runtime</h3>
            <div className="runtime-report" data-ok={environment?.compatible}>
              <span className="status-icon">
                {environment?.compatible ? <Check size={14} /> : "!"}
              </span>
              <span>
                <strong>
                  {environment?.compatible ? `Pi ${environment.version}` : "Pi needs attention"}
                </strong>
                <small>{environment?.message}</small>
                <code>{environment?.path ?? "Not found on PATH"}</code>
              </span>
            </div>
            <div className="setting-actions">
              <Button size="sm" onClick={() => void choosePi()}>
                Choose executable
              </Button>
              {settings.piPath && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void appStore.updateSettings({ piPath: null })}
                >
                  Use PATH
                </Button>
              )}
            </div>
            <div className="setting-row">
              <span>
                <strong>Idle process timeout</strong>
                <small>Settled Pi processes stop after this many minutes.</small>
              </span>
              <input
                className="number-input"
                type="number"
                min={1}
                max={120}
                value={settings.idleTimeoutMinutes}
                onChange={(event) =>
                  void appStore.updateSettings({ idleTimeoutMinutes: Number(event.target.value) })
                }
              />
            </div>
          </section>

          {project && (
            <section className="settings-section">
              <h3>Current project</h3>
              <div className="setting-row">
                <span>
                  <strong>{project.name}</strong>
                  <small>
                    {project.trusted
                      ? "Project-local Pi resources may load."
                      : "Project-local settings and extensions are disabled."}
                  </small>
                </span>
                <Button
                  size="sm"
                  onClick={() =>
                    void desktop
                      .updateProjectTrust(project.id, !project.trusted)
                      .then((updated) => appStore.updateProject(updated))
                  }
                >
                  {project.trusted ? <ShieldCheck size={14} /> : <ShieldOff size={14} />}
                  {project.trusted ? "Trusted" : "Restricted"}
                </Button>
              </div>
              <div className="setting-row">
                <span>
                  <strong>Pi packages</strong>
                  <small>Manage user and project extensions through Pi.</small>
                </span>
                <Button
                  size="sm"
                  onClick={() => {
                    appStore.setSettingsOpen(false);
                    appStore.setPackagesOpen(true);
                  }}
                >
                  <Boxes size={14} /> Manage packages
                </Button>
              </div>
              <Button
                className="danger-text"
                size="sm"
                variant="ghost"
                onClick={() => {
                  if (
                    confirm(
                      `Remove ${project.name} from Pi Desktop? Sessions and files are not deleted.`,
                    )
                  )
                    void appStore.removeProject(project.id);
                }}
              >
                <Trash2 size={14} /> Remove project
              </Button>
            </section>
          )}

          <section className="settings-section">
            <div className="settings-heading">
              <div>
                <h3>Provider credentials</h3>
                <p>
                  Keys are stored in Windows Credential Manager and injected only into Pi processes.
                </p>
              </div>
              <Button size="sm" variant="ghost" onClick={() => void desktop.openPiLogin()}>
                <ExternalLink size={13} /> Pi login
              </Button>
            </div>
            <div className="provider-list">
              {providers.map((provider) => (
                <div className="provider-row" key={provider.id}>
                  <button
                    type="button"
                    className="provider-summary"
                    onClick={() => {
                      setProviderId(providerId === provider.id ? null : provider.id);
                      setSecret("");
                    }}
                  >
                    <span className="provider-icon">
                      <KeyRound size={13} />
                    </span>
                    <span>
                      <strong>{provider.name}</strong>
                      <small>{provider.environmentVariable}</small>
                    </span>
                    <span
                      className="credential-source"
                      data-set={provider.configuredInApp || provider.configuredInPi}
                    >
                      {provider.configuredInPi
                        ? "Pi auth"
                        : provider.configuredInApp
                          ? "App key"
                          : "Not set"}
                    </span>
                  </button>
                  {providerId === provider.id && (
                    <div className="credential-editor">
                      {provider.configuredInPi && (
                        <p>Pi-managed credentials take precedence over this environment key.</p>
                      )}
                      <input
                        className="field-input"
                        type="password"
                        autoComplete="off"
                        value={secret}
                        onChange={(event) => setSecret(event.target.value)}
                        placeholder="Paste API key"
                      />
                      <div>
                        <Button
                          size="sm"
                          disabled={!secret.trim()}
                          variant="primary"
                          onClick={() => {
                            void appStore.setProviderKey(provider.id, secret);
                            setSecret("");
                          }}
                        >
                          Save key
                        </Button>
                        {provider.configuredInApp && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => void appStore.deleteProviderKey(provider.id)}
                          >
                            Delete app key
                          </Button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
