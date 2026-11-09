"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Boxes, Cpu, HardDrive, MemoryStick, Plus } from "lucide-react";
import { Button, EmptyState, PageHeader, Panel, Progress, Section, Skeleton, Stat } from "@craftpanel/ui";
import { softwareLabel, type ActivityEvent, type ConnectAddress, type NetworkAddressKind } from "@craftpanel/shared";
import { api } from "@/lib/api";
import { useCan } from "@/lib/auth";
import { useServersActiveFirst } from "@/lib/queries";
import { formatBytes } from "@/lib/format";
import { StatusBadge } from "./status";
import { EventList } from "./activity";

export interface SystemInfo {
  version: string;
  platform: string;
  arch: string;
  hostname: string;
  cpus: number;
  cpuModel: string | null;
  /** Board model such as "Raspberry Pi 4 Model B" (newer APIs). */
  board?: string | null;
  loadAverage: number[] | null;
  memory: { total: number; free: number; physical?: number; limited?: boolean };
  allocatedMemoryMb: number;
  disk: { free: number; total: number } | null;
  dataDir: string;
  dashboard: {
    host: string;
    port: number;
    loopbackOnly: boolean;
    secureCookies: boolean;
    profile: "local" | "lan" | "proxy" | "headless";
    https: boolean;
    behindProxy: boolean;
    publicUrl: string | null;
    trustedProxies: string[];
    transportSecure: boolean;
    urls: { url: string; kind: NetworkAddressKind; label?: string; interface?: string }[];
    clientIp: string;
  };
  lan: string[];
  /** Labelled LAN, VPN and virtual adapter addresses, real LAN first (newer APIs). */
  lanAddresses?: ConnectAddress[];
  servers: { total: number; running: number };
}

export function useSystem() {
  return useQuery({ queryKey: ["system"], queryFn: () => api.get<SystemInfo>("/api/system"), refetchInterval: 30_000 });
}

export function HomeView() {
  const servers = useServersActiveFirst();
  const system = useSystem();
  const activity = useQuery({ queryKey: ["activity", "home"], queryFn: () => api.get<ActivityEvent[]>("/api/activity?limit=8") });
  const canCreate = useCan("server.create");
  const s = system.data;
  const memUsed = s ? s.memory.total - s.memory.free : 0;

  return (
    <div className="space-y-10">
      <PageHeader
        title="Overview"
        description={s ? `${s.hostname} · ${s.platform}/${s.arch} · CraftPanel ${s.version}` : " "}
        actions={
          canCreate && (
            <Button asChild>
              <Link href="/servers/new/">
                <Plus /> New server
              </Link>
            </Button>
          )
        }
      />

      <Panel className="grid grid-cols-2 divide-border lg:grid-cols-4 lg:divide-x">
        <div className="p-5">
          <Stat label="Servers" value={s ? `${s.servers.running} / ${s.servers.total}` : <Skeleton className="h-7 w-16" />} sub="running / total" />
        </div>
        <div className="p-5">
          <Stat label="Host memory" value={s ? formatBytes(memUsed) : <Skeleton className="h-7 w-20" />} sub={s ? `of ${formatBytes(s.memory.total)} · ${(s.allocatedMemoryMb / 1024).toFixed(1)} GB allocated to servers` : undefined} />
          {s && <Progress value={(memUsed / s.memory.total) * 100} className="mt-3" />}
        </div>
        <div className="p-5">
          <Stat label="Disk free" value={s?.disk ? formatBytes(s.disk.free) : s ? "—" : <Skeleton className="h-7 w-20" />} sub={s?.disk ? `of ${formatBytes(s.disk.total)}` : "Unavailable on this platform"} />
          {s?.disk && <Progress value={((s.disk.total - s.disk.free) / s.disk.total) * 100} className="mt-3" />}
        </div>
        <div className="p-5">
          <Stat label="CPU" value={s ? `${s.cpus} cores` : <Skeleton className="h-7 w-16" />} sub={s?.loadAverage ? `load ${s.loadAverage.map((l) => l.toFixed(2)).join(" ")}` : (s?.cpuModel ?? undefined)} />
        </div>
      </Panel>

      <Section title="Servers" actions={<Link href="/servers/" className="flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground">All servers <ArrowRight className="size-3.5" /></Link>}>
        {servers.isLoading ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-32 rounded-xl" />)}</div>
        ) : servers.data?.length ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {servers.data.map((srv) => (
              <Link key={srv.id} href={`/server/?id=${srv.id}`} className="group rounded-xl border border-border bg-surface p-5 transition-colors hover:border-foreground/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{srv.name}</p>
                    <p className="mt-0.5 text-[13px] text-muted-foreground">
                      {softwareLabel(srv.software)} {srv.mcVersion}
                      {srv.build ? ` · #${srv.build}` : ""}
                    </p>
                  </div>
                  <StatusBadge status={srv.status} />
                </div>
                <div className="mt-6 grid grid-cols-3 gap-2 text-[13px]">
                  <div>
                    <p className="text-xs text-muted-foreground">Players</p>
                    <p className="font-medium tabular-nums">{srv.status === "running" ? `${srv.playersOnline}/${srv.maxPlayers}` : "—"}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Port</p>
                    <p className="font-medium tabular-nums">{srv.port}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Memory</p>
                    <p className="font-medium tabular-nums">{(srv.memoryMb / 1024).toFixed(1)} GB</p>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        ) : (
          <EmptyState
            icon={<Boxes />}
            title="No servers yet"
            description="Create your first Minecraft server. CraftPanel downloads the official server software and a compatible Java runtime for you."
            action={
              canCreate && (
                <Button asChild>
                  <Link href="/servers/new/">
                    <Plus /> Create server
                  </Link>
                </Button>
              )
            }
          />
        )}
      </Section>

      <div className="grid gap-10 lg:grid-cols-3">
        <Section title="Recent activity" className="flex min-h-0 flex-col lg:col-span-2" actions={<Link href="/activity/" className="flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground">View all <ArrowRight className="size-3.5" /></Link>}>
          <Panel
            className="scrollbar-thin min-h-0 max-h-80 flex-1 overflow-y-auto overscroll-contain outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring lg:max-h-none lg:[contain:size]"
            role="region"
            aria-label="Recent activity"
            tabIndex={0}
          >
            {activity.data ? <EventList events={activity.data} showServer /> : <div className="space-y-2 p-4">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-8" />)}</div>}
          </Panel>
        </Section>
        <Section title="This host">
          <Panel className="divide-y divide-border text-[13px]">
            {[
              [<Cpu key="c" />, s?.board ? "Board" : "Processor", s ? (s.board ? `${s.board} · ${s.cpus} cores` : (s.cpuModel ?? "—")) : "—"],
              [<MemoryStick key="m" />, "Memory", s ? `${formatBytes(s.memory.total)}${s.memory.limited ? " (container limit)" : ""}` : "—"],
              [<HardDrive key="d" />, "Data directory", s?.dataDir ?? "—"],
            ].map(([icon, label, value]) => (
              <div key={label as string} className="flex items-start gap-3 p-4 [&_svg]:mt-0.5 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground">
                {icon}
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">{label}</p>
                  <p className="break-all">{value}</p>
                </div>
              </div>
            ))}
            {s && (
              <div className="p-4">
                <p className="text-xs text-muted-foreground">Dashboard access</p>
                <p>{s.dashboard.loopbackOnly ? "This computer only (127.0.0.1)" : `Network: ${s.dashboard.host}:${s.dashboard.port}`}</p>
                {s.dashboard.publicUrl && <p className="mt-1 break-all">{s.dashboard.publicUrl}</p>}
                {!s.dashboard.loopbackOnly && !s.dashboard.transportSecure && <p className="mt-1 text-xs text-warning">This connection uses plain HTTP. Use a private VPN or HTTPS.</p>}
              </div>
            )}
          </Panel>
          {servers.data?.some((x) => x.status === "crashed") && <p className="text-xs text-destructive">One or more servers crashed. Open the server to see the reason in its console.</p>}
        </Section>
      </div>
    </div>
  );
}
