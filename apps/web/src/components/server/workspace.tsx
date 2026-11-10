"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle, Copy, MoreHorizontal, Play, RotateCw, Skull, Square, Download, RefreshCcw } from "lucide-react";
import {
  Button,
  Callout,
  ConfirmDialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  Progress,
  Skeleton,
  cn,
} from "@craftpanel/ui";
import { SOFTWARE_INFO, softwareLabel, type ServerDetail } from "@craftpanel/shared";
import { api, downloadUrl } from "@/lib/api";
import { useCan, ServerScope } from "@/lib/auth";
import { useServerStream } from "@/lib/realtime";
import { useAction, useServer, useServerLifecycle } from "@/lib/queries";
import { StatusBadge } from "../status";
import { OverviewTab } from "./overview";
import { ConsoleTab } from "./console";
import { PlayersTab } from "./players";
import { WorldsTab } from "./worlds";
import { PluginsTab } from "./plugins";
import { FilesTab } from "./files";
import { ServerBackupsTab } from "./backups";
import { AutomationTab } from "./automation";
import { SettingsTab } from "./settings";
import { NetworkTab } from "./network";
import { ProxyTab } from "./proxy";
import { PerformanceTab } from "./performance";
import { MapTab, useMap } from "./map";

const TABS = [
  ["overview", "Overview"],
  ["console", "Console"],
  ["players", "Players"],
  ["worlds", "Worlds"],
  ["map", "Map"],
  ["plugins", "Plugins"],
  ["files", "Files"],
  ["backups", "Backups"],
  ["automation", "Automation"],
  ["performance", "Performance"],
  ["settings", "Settings"],
  ["network", "Network"],
  ["proxy", "Proxy"],
] as const;
/** Tabs that only make sense for one kind of server: a proxy has no players or worlds, only proxies have backends. */
const visible = (t: string, proxy: boolean) => (proxy ? t !== "players" && t !== "worlds" && t !== "map" : t !== "proxy");
export type TabId = (typeof TABS)[number][0];

export type Stream = ReturnType<typeof useServerStream>;

export function ServerWorkspace() {
  const params = useSearchParams();
  const id = params.get("id");
  const tab = (params.get("tab") ?? "overview") as TabId;
  const server = useServer(id);
  const stream = useServerStream(id);

  if (!id) return <EmptyState title="No server selected" action={<Link href="/servers/" className="text-sm underline">Back to servers</Link>} />;
  if (server.isLoading) return <Skeleton className="h-40 rounded-xl" />;
  if (server.error || !server.data)
    return <EmptyState title="Server not found" description="It may have been deleted." action={<Link href="/servers/" className="text-sm underline">Back to servers</Link>} />;

  const s = server.data;
  return <ReadyWorkspace server={s} tab={tab} stream={stream} />;
}

function ReadyWorkspace({ server: s, tab, stream }: { server: ServerDetail; tab: TabId; stream: Stream }) {
  const id = s.id;
  const map = useMap(s);
  return (
    <ServerScope serverId={s.id}>
      <div className="space-y-6">
        <Header server={s} />
        <Banners server={s} stream={stream} />
        {/* The baseline is an inset shadow, not a border: tabs overlapping a border would overflow
            vertically, and overflow-x-auto makes that overflow scrollable. */}
        <nav className="scrollbar-thin -mx-1 flex gap-1 overflow-x-auto overflow-y-hidden px-1 shadow-[inset_0_-1px_0_var(--color-border)]" aria-label="Server sections">
          {TABS.filter(([t]) => visible(t, SOFTWARE_INFO[s.software].proxy) && (t !== "map" || map.data?.pageReady)).map(([t, label]) => (
            <Link
              key={t}
              href={`/server/?id=${id}${t === "overview" ? "" : `&tab=${t}`}`}
              scroll={false}
              className={cn(
                "relative whitespace-nowrap border-b-2 px-3 py-2.5 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                tab === t ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
              )}
              aria-current={tab === t ? "page" : undefined}
            >
              {t === "plugins" && SOFTWARE_INFO[s.software].addons === "mods" ? "Mods" : label}
              {t === "players" && s.status === "running" && <span className="ml-1.5 text-muted-foreground tabular-nums">{stream.players?.length ?? s.players.length}</span>}
            </Link>
          ))}
        </nav>
        <div>
          {tab === "overview" && <OverviewTab server={s} stream={stream} />}
          {tab === "console" && <ConsoleTab server={s} stream={stream} />}
          {tab === "players" && <PlayersTab server={s} />}
          {tab === "worlds" && <WorldsTab server={s} />}
          {tab === "map" && <MapTab server={s} />}
          {tab === "plugins" && <PluginsTab server={s} />}
          {tab === "files" && <FilesTab server={s} />}
          {tab === "backups" && <ServerBackupsTab server={s} />}
          {tab === "automation" && <AutomationTab server={s} />}
          {tab === "performance" && <PerformanceTab server={s} stream={stream} />}
          {tab === "settings" && <SettingsTab server={s} />}
          {tab === "network" && <NetworkTab server={s} />}
          {tab === "proxy" && <ProxyTab server={s} />}
        </div>
      </div>
    </ServerScope>
  );
}

function Header({ server: s }: { server: ServerDetail }) {
  const life = useServerLifecycle(s.id);
  const canControl = useCan("server.control");
  const canKill = useCan("server.kill");
  const [confirmKill, setConfirmKill] = React.useState(false);
  const running = ["running", "starting", "stopping"].includes(s.status);
  const startable = ["stopped", "crashed", "error"].includes(s.status) && s.installState === "installed";

  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 space-y-1.5">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="truncate text-2xl font-medium tracking-tight">{s.name}</h1>
          <StatusBadge status={s.status} />
        </div>
        <p className="text-[13px] text-muted-foreground">
          {softwareLabel(s.software)} {s.mcVersion}
          {s.build ? ` · ${(SOFTWARE_INFO[s.software].buildLabel ?? "build").toLowerCase()} ${s.build}` : ""} · Java {s.javaMajor} · {(s.memoryMb / 1024).toFixed(1)} GB · port {s.port}
          {s.description ? ` · ${s.description}` : ""}
        </p>
      </div>
      {canControl && (
        <div className="flex shrink-0 items-center gap-2">
          {startable && (
            <Button onClick={() => life.start.mutate()} loading={life.start.isPending} disabled={!s.eulaAccepted}>
              <Play /> Start
            </Button>
          )}
          {s.status === "running" && (
            <Button variant="secondary" onClick={() => life.restart.mutate()} loading={life.restart.isPending}>
              <RotateCw /> Restart
            </Button>
          )}
          {(s.status === "running" || s.status === "starting" || s.status === "orphaned") && (
            <Button variant="secondary" onClick={() => life.stop.mutate()} loading={life.stop.isPending}>
              <Square /> Stop
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="secondary" size="icon" aria-label="More actions">
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem onSelect={() => downloadUrl(`/api/servers/${s.id}/logs/latest`)}>
                <Download /> Download latest.log
              </DropdownMenuItem>
              {canKill && (running || s.status === "orphaned") && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem destructive onSelect={() => setConfirmKill(true)}>
                    <Skull /> Force kill
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          <ConfirmDialog
            open={confirmKill}
            onOpenChange={setConfirmKill}
            title="Force-kill the server process?"
            description="The process is terminated immediately without saving. Recent world changes may be lost and data can be corrupted. Use Stop whenever possible."
            confirmLabel="Kill process"
            destructive
            onConfirm={() => life.kill.mutateAsync()}
          />
        </div>
      )}
    </div>
  );
}

function Banners({ server: s, stream }: { server: ServerDetail; stream: Stream }) {
  const canConfigure = useCan("server.configure");
  const router = useRouter();
  const acceptEula = useAction(() => api.post(`/api/servers/${s.id}/eula`, { accept: true }), { success: "EULA accepted", invalidate: [["server", s.id]] });
  const reinstall = useAction(() => api.post(`/api/servers/${s.id}/install`), { success: "Installation restarted", invalidate: [["server", s.id]] });
  const life = useServerLifecycle(s.id);

  return (
    <div className="space-y-3 empty:hidden">
      {(s.installState === "installing" || s.installState === "pending") && (
        <Callout icon={<RefreshCcw className="animate-spin" />} title={stream.install?.stage ?? "Installing server software…"}>
          <Progress value={stream.install?.percent ?? null} className="mt-2 w-full max-w-md" />
        </Callout>
      )}
      {s.installState === "failed" && (
        <Callout variant="danger" icon={<AlertTriangle />} title="Installation failed">
          <p>{s.installError}</p>
          {canConfigure && (
            <Button size="sm" variant="secondary" className="mt-2" onClick={() => reinstall.mutate()} loading={reinstall.isPending}>
              Retry installation
            </Button>
          )}
        </Callout>
      )}
      {!s.eulaAccepted && s.installState === "installed" && (
        <Callout variant="warning" icon={<AlertTriangle />} title="Accept the Minecraft EULA to start this server">
          <p>
            Read the{" "}
            <a href="https://aka.ms/MinecraftEULA" target="_blank" rel="noreferrer">
              Minecraft End User License Agreement
            </a>
            . Minecraft servers may only run after you accept it.
          </p>
          {canConfigure && (
            <Button size="sm" className="mt-2" onClick={() => acceptEula.mutate()} loading={acceptEula.isPending}>
              I accept the EULA
            </Button>
          )}
        </Callout>
      )}
      {(s.status === "crashed" || s.status === "error") && s.lastError && (
        <Callout variant="danger" icon={<AlertTriangle />} title={s.status === "crashed" ? "The server crashed" : "The server failed to start"}>
          <p className="break-words">{s.lastError}</p>
          <button className="mt-1 font-medium text-foreground underline underline-offset-2" onClick={() => router.push(`/server/?id=${s.id}&tab=console`)}>
            Open console
          </button>
        </Callout>
      )}
      {s.status === "orphaned" && (
        <Callout variant="warning" icon={<AlertTriangle />} title="Server running without console access">
          A Minecraft process{s.pid ? ` (PID ${s.pid})` : ""} from a previous CraftPanel session is still running. CraftPanel cannot send commands to it. Stop it, then start it again to regain full control.
        </Callout>
      )}
      {s.restartRequired && s.status === "running" && (
        <Callout icon={<RotateCw />} title="Restart required">
          Some changes take effect after the next restart.
          <Button size="xs" variant="secondary" className="ml-2" onClick={() => life.restart.mutate()} loading={life.restart.isPending}>
            Restart now
          </Button>
        </Callout>
      )}
    </div>
  );
}

export function CopyButton({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = React.useState(false);
  return (
    <Button
      variant="ghost"
      size="xs"
      onClick={async () => {
        await navigator.clipboard.writeText(value).catch(() => undefined);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      aria-label={`Copy ${label ?? value}`}
    >
      <Copy />
      {copied ? "Copied" : (label ?? "Copy")}
    </Button>
  );
}
