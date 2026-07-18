import { openUrl } from "@tauri-apps/plugin-opener";
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  LoaderCircle,
  PackagePlus,
  RefreshCw,
  Search,
  Settings2,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { desktop } from "@/lib/bridge";
import type {
  PackageCatalogPage,
  PackageCatalogQuery,
  PackageCatalogSort,
  PackageCatalogType,
  PackageOperationRequest,
  PackageProgress,
  PackageScope,
  PiPackageRecord,
  ProjectRecord,
} from "@/lib/types";
import { errorMessage } from "@/lib/utils";
import { appStore, useAppStore } from "@/stores/app-store";

const CATALOG_URL = "https://pi.dev/packages";
const DEFAULT_CATALOG_QUERY: Required<PackageCatalogQuery> = {
  name: "",
  packageType: "",
  sort: "downloads",
  page: 1,
};

function scopeLabel(scope: PackageScope) {
  return scope === "project" ? "Project" : "User";
}

function installedFromCatalog(itemName: string, packages: PiPackageRecord[]) {
  const source = `npm:${itemName}`;
  return packages.some((item) => item.source === source || item.source === itemName);
}

function formatDownloads(value: number) {
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(
    value,
  );
}

export function PackageManagerDialog({ project }: { project: ProjectRecord }) {
  const open = useAppStore((snapshot) => snapshot.packagesOpen);
  const [view, setView] = useState<"catalog" | "installed">("catalog");
  const [packages, setPackages] = useState<PiPackageRecord[]>([]);
  const [source, setSource] = useState("");
  const [scope, setScope] = useState<PackageScope>("user");
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState(false);
  const [operationId, setOperationId] = useState<string | null>(null);
  const [progress, setProgress] = useState<PackageProgress[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<PackageCatalogPage | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogName, setCatalogName] = useState("");
  const [catalogType, setCatalogType] = useState<PackageCatalogType>("");
  const [catalogSort, setCatalogSort] = useState<PackageCatalogSort>("downloads");
  const [catalogQuery, setCatalogQuery] =
    useState<Required<PackageCatalogQuery>>(DEFAULT_CATALOG_QUERY);

  const refresh = useCallback(
    async (preserveError = false) => {
      setLoading(true);
      if (!preserveError) setError(null);
      try {
        setPackages(await desktop.listPiPackages(project.id));
      } catch (reason) {
        if (!preserveError) setError(errorMessage(reason));
      } finally {
        setLoading(false);
      }
    },
    [project.id],
  );

  const loadCatalog = useCallback(async (query: Required<PackageCatalogQuery>) => {
    setCatalogLoading(true);
    setCatalogError(null);
    setCatalogQuery(query);
    try {
      setCatalog(await desktop.browsePiPackageCatalog(query));
    } catch (reason) {
      setCatalogError(errorMessage(reason));
    } finally {
      setCatalogLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      void refresh();
      void loadCatalog(DEFAULT_CATALOG_QUERY);
    }
  }, [open, refresh, loadCatalog]);

  async function run(request: PackageOperationRequest) {
    const packageName = request.source?.trim() || "all installed packages";
    const risky =
      request.kind === "install" || request.kind === "update" || request.kind === "update_all";
    if (
      risky &&
      !confirm(
        `Continue with ${packageName}? Pi packages can execute arbitrary code with your user permissions.`,
      )
    ) {
      return;
    }
    if (
      request.kind === "remove" &&
      !confirm(
        `Remove ${packageName} from the ${scopeLabel(request.scope ?? "user").toLowerCase()} scope?`,
      )
    ) {
      return;
    }

    setWorking(true);
    setOperationId(null);
    setProgress([]);
    setError(null);
    setNotice(null);
    try {
      const result = await desktop.runPiPackageOperation(project.id, request, (event) => {
        setOperationId(event.operationId);
        setProgress((current) => [...current, event].slice(-200));
      });
      setPackages(result.packages);
      if (request.kind === "install") setSource("");
      setNotice(
        result.warnings.length > 0
          ? result.warnings.join(" ")
          : result.restartedProjectIds.length > 0
            ? `Pi packages refreshed. Restarted ${result.restartedProjectIds.length} active project${
                result.restartedProjectIds.length === 1 ? "" : "s"
              }.`
            : "Pi packages refreshed. No running Pi process needed a restart.",
      );
    } catch (reason) {
      const message = errorMessage(reason);
      await refresh(true);
      setError(message);
    } finally {
      setWorking(false);
      setOperationId(null);
    }
  }

  async function openExternal(url: string) {
    try {
      await openUrl(url);
    } catch (reason) {
      setError(`Unable to open the browser: ${errorMessage(reason)}`);
    }
  }

  async function openConfig() {
    setError(null);
    try {
      await desktop.openPiPackageConfig(project.id, scope);
      setNotice("Pi config opened in a terminal. Reload resources after you finish.");
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  async function reloadResources() {
    setWorking(true);
    setError(null);
    setNotice(null);
    try {
      const restarted = await desktop.reloadPiResources(project.id);
      setNotice(
        `Reloaded Pi resources${restarted.length ? ` for ${restarted.length} active project${restarted.length === 1 ? "" : "s"}` : ""}.`,
      );
      await refresh();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setWorking(false);
    }
  }

  const groups: Array<{ scope: PackageScope; items: PiPackageRecord[] }> = [
    { scope: "user", items: packages.filter((item) => item.scope === "user") },
    { scope: "project", items: packages.filter((item) => item.scope === "project") },
  ];

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!working) appStore.setPackagesOpen(next);
      }}
    >
      <DialogContent className="packages-dialog" showClose={!working}>
        <DialogHeader>
          <DialogTitle>Pi packages</DialogTitle>
          <DialogDescription>
            Discover and manage extensions, skills, prompts, and themes through Pi itself.
          </DialogDescription>
        </DialogHeader>

        <div className="package-warning" role="note">
          <AlertTriangle className="package-warning-icon" size={16} />
          <span>
            <strong>Packages run arbitrary code.</strong> Only install sources you trust. Package
            installation never grants automatic tool approval.
          </span>
        </div>

        <div className="package-viewbar">
          <div className="package-tabs" role="tablist" aria-label="Package views">
            <button
              type="button"
              role="tab"
              aria-selected={view === "catalog"}
              data-active={view === "catalog"}
              onClick={() => setView("catalog")}
            >
              Discover
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === "installed"}
              data-active={view === "installed"}
              onClick={() => setView("installed")}
            >
              Installed <span>{packages.length}</span>
            </button>
          </div>
          <div className="package-target">
            <span>Install to</span>
            <fieldset className="package-scope">
              <legend className="sr-only">Install scope</legend>
              {(["user", "project"] as PackageScope[]).map((value) => (
                <button
                  type="button"
                  key={value}
                  data-active={scope === value}
                  disabled={working || (value === "project" && !project.trusted)}
                  title={
                    value === "project" && !project.trusted
                      ? "Trust this project to manage project-local packages"
                      : undefined
                  }
                  onClick={() => setScope(value)}
                >
                  {scopeLabel(value)}
                </button>
              ))}
            </fieldset>
          </div>
        </div>

        {(error || notice) && (
          <div className="package-message" data-error={Boolean(error)} role="status">
            {error ?? notice}
          </div>
        )}

        {working && progress.length > 0 && (
          <div className="package-progress" aria-live="polite">
            <div>
              <strong>Pi package operation</strong>
              {operationId && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void desktop.cancelPiPackageOperation(operationId)}
                >
                  <X size={13} /> Cancel
                </Button>
              )}
            </div>
            <pre>{progress.map((entry) => entry.message).join("\n")}</pre>
          </div>
        )}

        {view === "catalog" ? (
          <>
            <form
              className="package-catalog-filters"
              onSubmit={(event) => {
                event.preventDefault();
                void loadCatalog({
                  name: catalogName.trim(),
                  packageType: catalogType,
                  sort: catalogSort,
                  page: 1,
                });
              }}
            >
              <label className="package-catalog-search">
                <span className="sr-only">Search official packages</span>
                <Search size={13} aria-hidden="true" />
                <input
                  value={catalogName}
                  maxLength={200}
                  disabled={catalogLoading}
                  onChange={(event) => setCatalogName(event.target.value)}
                  placeholder="Search packages, descriptions, or authors"
                />
              </label>
              <label>
                <span className="sr-only">Package type</span>
                <select
                  value={catalogType}
                  disabled={catalogLoading}
                  onChange={(event) => setCatalogType(event.target.value as PackageCatalogType)}
                >
                  <option value="">All types</option>
                  <option value="extension">Extensions</option>
                  <option value="skill">Skills</option>
                  <option value="prompt">Prompts</option>
                  <option value="theme">Themes</option>
                </select>
              </label>
              <label>
                <span className="sr-only">Sort packages</span>
                <select
                  value={catalogSort}
                  disabled={catalogLoading}
                  onChange={(event) => setCatalogSort(event.target.value as PackageCatalogSort)}
                >
                  <option value="downloads">Most downloaded</option>
                  <option value="recent">Recently published</option>
                  <option value="name">A–Z</option>
                </select>
              </label>
              <Button type="submit" size="sm" disabled={catalogLoading}>
                Search
              </Button>
            </form>

            <div className="package-catalog-heading">
              <span>
                {catalog && catalog.total > 0
                  ? `${catalog.from.toLocaleString()}–${catalog.to.toLocaleString()} of ${catalog.total.toLocaleString()}`
                  : catalog?.total === 0
                    ? "No matching packages"
                    : "Official Pi catalog"}
              </span>
              <Button size="sm" variant="ghost" onClick={() => void openExternal(CATALOG_URL)}>
                <ExternalLink size={13} /> Open pi.dev
              </Button>
            </div>

            {catalogError && (
              <div className="package-message" data-error="true" role="status">
                {catalogError}
              </div>
            )}

            <div className="package-scroll package-catalog-scroll">
              {catalogLoading && !catalog ? (
                <div className="package-empty">
                  <LoaderCircle className="spin" size={16} /> Loading official packages
                </div>
              ) : catalog?.items.length ? (
                catalog.items.map((item) => {
                  const installed = installedFromCatalog(item.name, packages);
                  return (
                    <article className="package-catalog-row" key={item.name}>
                      <div className="package-catalog-copy">
                        <div className="package-catalog-name">
                          <strong>{item.name}</strong>
                          {item.types.map((type) => (
                            <span className="package-type-badge" key={type}>
                              {type}
                            </span>
                          ))}
                        </div>
                        <p>{item.description || "No description provided."}</p>
                        <div className="package-catalog-meta">
                          <span>{item.author || "Unknown author"}</span>
                          <span>{formatDownloads(item.downloads)}/mo</span>
                          <span>{item.published}</span>
                        </div>
                      </div>
                      <div className="package-row-actions">
                        <Button
                          size="sm"
                          variant="ghost"
                          title={`Open ${item.name} on pi.dev`}
                          onClick={() => void openExternal(item.detailUrl)}
                        >
                          <ExternalLink size={13} /> Details
                        </Button>
                        <Button
                          size="sm"
                          variant={installed ? "ghost" : "primary"}
                          disabled={working || installed}
                          onClick={() =>
                            void run({ kind: "install", source: `npm:${item.name}`, scope })
                          }
                        >
                          {installed ? "Installed" : "Install"}
                        </Button>
                      </div>
                    </article>
                  );
                })
              ) : (
                <div className="package-empty">
                  {catalogLoading ? (
                    <>
                      <LoaderCircle className="spin" size={16} /> Loading official packages
                    </>
                  ) : (
                    "No packages match these filters."
                  )}
                </div>
              )}
            </div>

            {catalog && catalog.pageCount > 1 && (
              <nav className="package-pagination" aria-label="Package catalog pages">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={catalogLoading || catalog.page <= 1}
                  onClick={() => void loadCatalog({ ...catalogQuery, page: catalog.page - 1 })}
                >
                  <ChevronLeft size={13} /> Previous
                </Button>
                <span>
                  Page {catalog.page.toLocaleString()} of {catalog.pageCount.toLocaleString()}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={catalogLoading || catalog.page >= catalog.pageCount}
                  onClick={() => void loadCatalog({ ...catalogQuery, page: catalog.page + 1 })}
                >
                  Next <ChevronRight size={13} />
                </Button>
              </nav>
            )}
          </>
        ) : (
          <>
            <form
              className="package-install"
              onSubmit={(event) => {
                event.preventDefault();
                const value = source.trim();
                if (value) void run({ kind: "install", source: value, scope });
              }}
            >
              <label>
                <span>Install another source</span>
                <input
                  className="field-input"
                  value={source}
                  maxLength={4096}
                  disabled={working}
                  onChange={(event) => setSource(event.target.value)}
                  placeholder="npm package, Git URL, SSH URL, or local path"
                />
              </label>
              <Button
                variant="primary"
                size="sm"
                type="submit"
                disabled={working || !source.trim()}
              >
                <PackagePlus size={14} /> Install
              </Button>
            </form>

            <div className="package-toolbar">
              <Button
                size="sm"
                variant="ghost"
                disabled={working}
                onClick={() => void openConfig()}
              >
                <Settings2 size={13} /> Pi config ({scope})
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={working}
                onClick={() => void reloadResources()}
              >
                <RefreshCw size={13} /> Reload resources
              </Button>
              <Button
                size="sm"
                disabled={working || packages.length === 0}
                onClick={() => void run({ kind: "update_all" })}
              >
                <RefreshCw size={13} /> Update all
              </Button>
            </div>

            <div className="package-scroll">
              {loading && packages.length === 0 ? (
                <div className="package-empty">
                  <LoaderCircle className="spin" size={16} /> Reading installed Pi packages
                </div>
              ) : (
                groups.map((group) => (
                  <section className="package-group" key={group.scope}>
                    <div className="package-group-heading">
                      <h3>{scopeLabel(group.scope)} packages</h3>
                      <span>{group.items.length}</span>
                    </div>
                    {group.scope === "project" && !project.trusted && (
                      <p className="package-restricted">
                        Project-local packages are unavailable while this project is restricted.
                      </p>
                    )}
                    {group.items.length === 0 ? (
                      <p className="package-empty-inline">No packages configured in this scope.</p>
                    ) : (
                      group.items.map((item) => (
                        <div className="package-row" key={`${item.scope}:${item.source}`}>
                          <div className="package-summary">
                            <div>
                              <strong>{item.source}</strong>
                              {item.filtered && <span className="package-badge">filtered</span>}
                            </div>
                            <code>{item.installedPath || "Installed path unavailable"}</code>
                          </div>
                          <div className="package-row-actions">
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={working}
                              onClick={() =>
                                void run({ kind: "update", source: item.source, scope: item.scope })
                              }
                            >
                              <RefreshCw size={13} /> Update
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="danger-text"
                              disabled={working}
                              onClick={() =>
                                void run({ kind: "remove", source: item.source, scope: item.scope })
                              }
                            >
                              <Trash2 size={13} /> Remove
                            </Button>
                          </div>
                        </div>
                      ))
                    )}
                  </section>
                ))
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
