"use client";

import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowUpCircle, Check, Download, Puzzle, Search, ShieldAlert, Trash2, Upload, Zap } from "lucide-react";
import { toast } from "sonner";
import {
  Badge,
  Button,
  Callout,
  ConfirmDialog,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  EmptyState,
  Input,
  Panel,
  Section,
  Skeleton,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  cn,
} from "@craftpanel/ui";
import { findInstalledAddon, SOFTWARE_INFO, softwareLabel, type PluginInfo, type ServerDetail } from "@craftpanel/shared";
import { api, errorMessage, upload } from "@/lib/api";
import { useCan } from "@/lib/auth";
import { useAction } from "@/lib/queries";
import { formatBytes } from "@/lib/format";

interface MarketHit {
  id: string;
  slug: string;
  title: string;
  description: string;
  author: string;
  downloads: number;
  iconUrl: string | null;
  compatible: boolean;
  source: "modrinth" | "hangar";
  installed?: boolean;
  installedVersion?: string | null;
  installedFile?: string | null;
}

type Source = "modrinth" | "hangar";
const SOURCES: Record<Source, { label: string; url: (h: MarketHit, page: string) => string }> = {
  modrinth: { label: "Modrinth", url: (h, page) => `https://modrinth.com/${page}/${h.slug}` },
  hangar: { label: "Hangar", url: (h) => `https://hangar.papermc.io/${h.author}/${h.slug}` },
};

/** Wording for plugin servers (Paper, Purpur) and mod servers (Fabric, NeoForge). */
function addonTerms(s: ServerDetail) {
  return SOFTWARE_INFO[s.software].addons === "mods"
    ? { one: "mod", many: "mods", One: "Mod", Many: "Mods", page: "mod", filter: `${softwareLabel(s.software)} mods that run on a server` }
    : { one: "plugin", many: "plugins", One: "Plugin", Many: "Plugins", page: "plugin", filter: `Paper/Bukkit plugins` };
}

export function PluginsTab({ server: s }: { server: ServerDetail }) {
  const key = ["plugins", s.id];
  const t = addonTerms(s);
  const q = useQuery({ queryKey: key, queryFn: () => api.get<{ supported: boolean; plugins: PluginInfo[]; restartRequired: boolean }>(`/api/servers/${s.id}/plugins`) });
  const canManage = useCan("plugins.manage");

  if (q.isLoading) return <Skeleton className="h-48 rounded-xl" />;
  if (!q.data?.supported) return <VanillaMigration server={s} />;

  return (
    <div className="space-y-6">
      <Callout variant="warning" icon={<ShieldAlert />} title={`${t.Many} are executable code`}>
        {t.Many} run with the same permissions as the Minecraft server on this machine. Only install {t.many} from authors you trust. CraftPanel verifies download checksums but cannot verify what a{" "}
        {t.one} does.
      </Callout>
      <Tabs defaultValue="installed" className="space-y-4">
        <TabsList>
          <TabsTrigger value="installed">Installed ({q.data.plugins.length})</TabsTrigger>
          {canManage && <TabsTrigger value="browse">Browse</TabsTrigger>}
          {canManage && <TabsTrigger value="updates">Updates</TabsTrigger>}
        </TabsList>
        <TabsContent value="installed">
          <Installed server={s} plugins={q.data.plugins} canManage={canManage} />
        </TabsContent>
        <TabsContent value="browse">
          <Browse server={s} plugins={q.data.plugins} />
        </TabsContent>
        <TabsContent value="updates">
          <Updates server={s} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Installed({ server: s, plugins, canManage }: { server: ServerDetail; plugins: PluginInfo[]; canManage: boolean }) {
  const key = [
    ["plugins", s.id],
    ["plugin-updates", s.id],
    ["market", s.id],
    ["server", s.id],
  ];
  const t = addonTerms(s);
  const toggle = useAction((v: { file: string; enabled: boolean }) => api.patch(`/api/servers/${s.id}/plugins/${encodeURIComponent(v.file)}`, { enabled: v.enabled }), {
    invalidate: key,
    success: "Saved. Restart to apply.",
  });
  const remove = useAction((file: string) => api.del(`/api/servers/${s.id}/plugins/${encodeURIComponent(file)}`), { invalidate: key, success: `${t.One} removed. Restart to apply.` });
  const [removing, setRemoving] = React.useState<string | null>(null);
  const [pct, setPct] = React.useState<number | null>(null);
  const qc = useQueryClient();
  const input = React.useRef<HTMLInputElement>(null);

  return (
    <Section
      title={`Installed ${t.many}`}
      description="Changes take effect after a restart."
      actions={
        canManage && (
          <>
            <input
              ref={input}
              type="file"
              accept=".jar"
              hidden
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (!f) return;
                const safeName = f.name.replace(/[^A-Za-z0-9 ._+()-]/g, "_");
                const existing = plugins.find((p) => p.file.replace(/\.disabled$/i, "").toLowerCase() === safeName.toLowerCase());
                if (existing) {
                  toast.error(`${existing.name ?? safeName} is already installed (${existing.file}). Remove or update the existing file first.`);
                  return;
                }
                setPct(0);
                try {
                  await upload(`/api/servers/${s.id}/plugins/upload`, f, setPct);
                  toast.success(`${f.name} uploaded. Restart to load it.`);
                  for (const k of key) void qc.invalidateQueries({ queryKey: k });
                } catch (err) {
                  toast.error(errorMessage(err));
                } finally {
                  setPct(null);
                }
              }}
            />
            <Button size="sm" variant="secondary" onClick={() => input.current?.click()} loading={pct !== null}>
              <Upload /> {pct !== null ? `${pct}%` : "Upload .jar"}
            </Button>
          </>
        )
      }
    >
      {plugins.length ? (
        <Panel>
          <ul className="divide-y divide-border">
            {plugins.map((p) => (
              <li key={p.file} className="flex flex-wrap items-start gap-4 px-4 py-3.5 text-[13px]">
                <Puzzle className="mt-0.5 size-4 text-muted-foreground" />
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="flex flex-wrap items-center gap-2 font-medium">
                    {p.name ?? p.file}
                    {p.version && <span className="font-normal text-muted-foreground">{p.version}</span>}
                    {!p.enabled && <Badge>Disabled</Badge>}
                    {p.duplicateOf && <Badge variant="warning">Duplicate</Badge>}
                    {p.name === null && <Badge variant="danger">Invalid {t.one}</Badge>}
                  </p>
                  {p.description && <p className="text-muted-foreground">{p.description}</p>}
                  <p className="text-xs text-muted-foreground">
                    {p.file} · {formatBytes(p.size)}
                    {p.authors.length ? ` · ${p.authors.join(", ")}` : ""}
                    {p.apiVersion ? ` · API ${p.apiVersion}` : ""}
                    {p.depend.length ? ` · requires ${p.depend.join(", ")}` : ""}
                  </p>
                  {p.duplicateOf && (
                    <p className="flex items-center gap-1.5 text-xs text-warning">
                      <AlertTriangle className="size-3.5" /> Duplicate of {p.duplicateOf}. Remove one copy so the server does not load the {t.one} twice.
                    </p>
                  )}
                  {p.enabled && p.missingDependencies.length > 0 && (
                    <p className="flex items-center gap-1.5 text-xs text-destructive">
                      <AlertTriangle className="size-3.5" /> Missing dependencies: {p.missingDependencies.join(", ")}. The {t.one} will fail to load.
                    </p>
                  )}
                </div>
                {canManage && (
                  <div className="flex items-center gap-3">
                    <Switch checked={p.enabled} onCheckedChange={(v) => toggle.mutate({ file: p.file, enabled: v })} aria-label={`Enable ${p.name ?? p.file}`} />
                    <Button size="icon-sm" variant="destructive-ghost" onClick={() => setRemoving(p.file)} aria-label="Remove">
                      <Trash2 />
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </Panel>
      ) : (
        <EmptyState icon={<Puzzle />} title={`No ${t.many} installed`} description={`Browse Modrinth for ${t.many} compatible with this server, or upload a .jar.`} />
      )}
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={`Remove ${t.one}?`}
        description={`${removing} will be deleted. Its configuration folder is kept.`}
        confirmLabel="Remove"
        destructive
        onConfirm={() => remove.mutateAsync(removing!)}
      />
    </Section>
  );
}

function Browse({ server: s, plugins }: { server: ServerDetail; plugins: PluginInfo[] }) {
  const t = addonTerms(s);
  // Hangar is PaperMC's repository: plugins only.
  const sources: Source[] = t.one === "plugin" ? ["modrinth", "hangar"] : ["modrinth"];
  const [source, setSource] = React.useState<Source>("modrinth");
  const [query, setQuery] = React.useState("");
  const [debounced, setDebounced] = React.useState("");
  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(query), 350);
    return () => clearTimeout(t);
  }, [query]);
  const q = useQuery({
    queryKey: ["market", s.id, source, debounced],
    queryFn: () => api.get<{ hits: MarketHit[]; total: number }>(`/api/servers/${s.id}/plugins/${source === "hangar" ? "hangar/search" : "search"}?q=${encodeURIComponent(debounced)}`),
  });
  const [confirm, setConfirm] = React.useState<MarketHit | null>(null);
  const install = useAction(
    (h: MarketHit) =>
      api.post<{ file: string; version: string; requiredDependencies: string[] }>(
        h.source === "hangar" ? `/api/servers/${s.id}/plugins/hangar/install` : `/api/servers/${s.id}/plugins/install`,
        h.source === "hangar" ? { project: h.id } : { projectId: h.id },
      ),
    {
      success: (r) => `Installed ${r.file}${r.requiredDependencies.length ? ` — also needs ${r.requiredDependencies.length} dependency ${t.one}(s)` : ""}. Restart to load it.`,
      invalidate: [
        ["plugins", s.id],
        ["plugin-updates", s.id],
        ["market", s.id],
        ["server", s.id],
      ],
    },
  );

  return (
    <Section
      title={SOURCES[source].label}
      description={
        source === "hangar"
          ? `PaperMC's plugin repository. Compatibility with Minecraft ${s.mcVersion} is checked against Hangar's version metadata before installing; plugins only offered as external downloads can't be installed from here.`
          : `Results are filtered to ${t.filter}. Compatibility with Minecraft ${s.mcVersion} is checked against Modrinth's version metadata before installing.${s.software === "fabric" ? " Most mods also need Fabric API." : ""}`
      }
    >
      <div className="flex flex-wrap items-center gap-3">
        {sources.length > 1 && (
          <div className="flex rounded-md border border-border p-0.5" role="group" aria-label="Source">
            {sources.map((id) => (
              <button
                key={id}
                type="button"
                aria-pressed={source === id}
                onClick={() => setSource(id)}
                className={cn("h-7 rounded px-3 text-[13px] font-medium transition-colors", source === id ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground")}
              >
                {SOURCES[id].label}
              </button>
            ))}
          </div>
        )}
        <div className="relative min-w-0 max-w-md flex-1">
          <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Search ${t.many} on ${SOURCES[source].label}…`} className="pl-8" aria-label={`Search ${t.many}`} />
        </div>
      </div>
      {q.isLoading ? (
        <Skeleton className="h-48 rounded-xl" />
      ) : q.error ? (
        <Callout variant="danger" icon={<AlertTriangle />}>
          {errorMessage(q.error)}
        </Callout>
      ) : (
        <Panel>
          <ul className="divide-y divide-border">
            {q.data?.hits.map((h) => {
              const installed = findInstalledAddon(h, plugins);
              const isInstalled = Boolean(installed || h.installed);
              const installedVer = installed?.version ?? h.installedVersion;
              const isInstalling = install.isPending && install.variables?.id === h.id;
              return (
                <li key={h.id} className="flex items-start gap-4 px-4 py-3.5 text-[13px]">
                  <div className="min-w-0 flex-1 space-y-1">
                    <p className="flex flex-wrap items-center gap-2 font-medium">
                      <a href={SOURCES[h.source].url(h, t.page)} target="_blank" rel="noreferrer" className="hover:underline">
                        {h.title}
                      </a>
                      <span className="font-normal text-muted-foreground">by {h.author}</span>
                      {h.compatible ? <Badge variant="success">Supports {s.mcVersion}</Badge> : <Badge variant="warning">Not listed for {s.mcVersion}</Badge>}
                      {isInstalled && (
                        <Badge variant="info">
                          {installed && !installed.enabled ? "Installed (disabled)" : `Installed${installedVer ? ` · ${installedVer}` : ""}`}
                        </Badge>
                      )}
                    </p>
                    <p className="text-muted-foreground">{h.description}</p>
                    <p className="text-xs text-muted-foreground">{h.downloads.toLocaleString()} downloads</p>
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={!h.compatible || isInstalled || isInstalling}
                    loading={isInstalling}
                    onClick={() => !isInstalled && setConfirm(h)}
                  >
                    {isInstalled ? (
                      <>
                        <Check /> Installed
                      </>
                    ) : (
                      <>
                        <Download /> Install
                      </>
                    )}
                  </Button>
                </li>
              );
            })}
          </ul>
        </Panel>
      )}
      <ConfirmDialog
        open={!!confirm}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={`Install ${confirm?.title}?`}
        description={`This downloads third-party executable code from ${SOURCES[confirm?.source ?? source].label} into the server's ${t.many} folder. Only continue if you trust the author.`}
        confirmLabel={`Install ${t.one}`}
        onConfirm={() => install.mutateAsync(confirm!)}
      />
    </Section>
  );
}

function Updates({ server: s }: { server: ServerDetail }) {
  const t = addonTerms(s);
  const q = useQuery({
    queryKey: ["plugin-updates", s.id],
    queryFn: () => api.get<{ file: string; name: string | null; current: string | null; versionId: string; versionNumber: string; source: Source }[]>(`/api/servers/${s.id}/plugins/updates`),
  });
  const update = useAction(
    (v: { file: string; versionId: string; source: Source }) => api.post(`/api/servers/${s.id}/plugins/${encodeURIComponent(v.file)}/update`, { versionId: v.versionId, source: v.source }),
    {
      success: `${t.One} updated. Restart to apply.`,
      invalidate: [
        ["plugins", s.id],
        ["plugin-updates", s.id],
        ["server", s.id],
      ],
    },
  );
  return (
    <Section
      title="Available updates"
      description={
        t.one === "plugin"
          ? "Checked against Modrinth by file hash and against Hangar for plugins installed from there. Plugins from other sources cannot be checked."
          : `Checked against Modrinth by file hash. ${t.Many} from other sources cannot be checked.`
      }
    >
      {q.isLoading ? (
        <Skeleton className="h-24 rounded-xl" />
      ) : q.error ? (
        <Callout variant="danger">{errorMessage(q.error)}</Callout>
      ) : q.data?.length ? (
        <Panel>
          <ul className="divide-y divide-border">
            {q.data.map((u) => (
              <li key={u.file} className="flex items-center gap-4 px-4 py-3 text-[13px]">
                <ArrowUpCircle className="size-4 text-brand-text" />
                <div className="flex-1">
                  <p className="font-medium">{u.name ?? u.file}</p>
                  <p className="text-xs text-muted-foreground">
                    {u.current ?? "?"} → {u.versionNumber} · {SOURCES[u.source].label}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => update.mutate({ file: u.file, versionId: u.versionId, source: u.source })}
                  loading={update.isPending && update.variables?.file === u.file}
                >
                  Update
                </Button>
              </li>
            ))}
          </ul>
        </Panel>
      ) : (
        <p className="text-[13px] text-muted-foreground">All Modrinth {t.many} are up to date.</p>
      )}
    </Section>
  );
}

function VanillaMigration({ server: s }: { server: ServerDetail }) {
  const canConfigure = useCan("server.configure");
  const opts = useQuery({ queryKey: ["software-options", s.id], queryFn: () => api.get<{ paperAvailable: boolean }>(`/api/servers/${s.id}/software/options`), enabled: canConfigure });
  const [open, setOpen] = React.useState(false);
  const migrate = useAction(() => api.post<{ backupId: string }>(`/api/servers/${s.id}/software`, { software: "paper", version: s.mcVersion }), {
    success: "Migrated to Paper. A backup of the Vanilla server was created first.",
    invalidate: [["server", s.id], ["plugins", s.id], ["servers"], ["backups"]],
  });
  const running = s.status !== "stopped" && s.status !== "crashed" && s.status !== "error";
  return (
    <div className="space-y-6">
      <EmptyState
        icon={<Puzzle />}
        title="Vanilla servers cannot load plugins or mods"
        description="Plugins require Paper, a compatible server that keeps Vanilla gameplay while adding plugin support and performance improvements. For mods, create a Fabric or NeoForge server."
        action={
          canConfigure && (
            <Button onClick={() => setOpen(true)} disabled={!opts.data?.paperAvailable}>
              <Zap /> Switch to Paper
            </Button>
          )
        }
      />
      {opts.data && !opts.data.paperAvailable && <p className="text-center text-xs text-muted-foreground">Paper is not available for Minecraft {s.mcVersion} yet.</p>}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader title={`Switch to Paper ${s.mcVersion}`} description="Your worlds, settings and player lists are kept." />
          <ol className="list-decimal space-y-1.5 pl-5 text-[13px] text-muted-foreground">
            <li>A full backup of the current server is created.</li>
            <li>The latest stable Paper build for {s.mcVersion} is downloaded and verified.</li>
            <li>Up to Minecraft 1.21, Paper moves the Nether and the End into separate folders on first start; switching back moves them home again.</li>
            <li>To roll back, restore the pre-migration backup and switch back to Vanilla.</li>
          </ol>
          {running && (
            <Callout variant="warning" icon={<AlertTriangle />}>
              Stop the server first.
            </Callout>
          )}
          <DialogFooter>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button disabled={running} loading={migrate.isPending} onClick={() => migrate.mutate(undefined, { onSuccess: () => setOpen(false) })}>
              Back up & switch
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
