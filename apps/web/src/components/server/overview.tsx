"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import { Panel, Progress, Section, Skeleton, Stat } from "@craftpanel/ui";
import type { ActivityEvent, BackupInfo, ServerDetail, ServerMetrics } from "@craftpanel/shared";
import { api } from "@/lib/api";
import { formatBytes, formatDuration, timeAgo } from "@/lib/format";
import { EventList } from "../activity";
import { Unavailable } from "../status";
import { CopyButton, type Stream } from "./workspace";
import { ConsoleLines } from "./console";

interface Overview {
  metrics: ServerMetrics | null;
  storageBytes: number;
  disk: { free: number; total: number } | null;
  latestBackup: BackupInfo | null;
  events: ActivityEvent[];
  addresses: { local: string; lan: string[] };
}

export function OverviewTab({ server: s, stream }: { server: ServerDetail; stream: Stream }) {
  const ov = useQuery({ queryKey: ["overview", s.id], queryFn: () => api.get<Overview>(`/api/servers/${s.id}/overview`), refetchInterval: 60_000 });
  const m = stream.metrics ?? ov.data?.metrics ?? null;
  const running = s.status === "running";
  const players = stream.players ?? s.players;
  const memPct = m?.memoryBytes ? (m.memoryBytes / (s.memoryMb * 1024 * 1024)) * 100 : null;

  return (
    <div className="space-y-10">
      <Panel className="grid grid-cols-2 gap-px overflow-hidden bg-border sm:grid-cols-3 lg:grid-cols-6 [&>*]:bg-surface">
        <div className="p-5">
          <Stat label="Players" value={running ? `${players.length} / ${s.maxPlayers}` : <Unavailable reason="Server is not running" />} />
        </div>
        <div className="p-5">
          <Stat label="CPU" value={running && m?.cpuPercent != null ? `${m.cpuPercent.toFixed(0)}%` : <Unavailable reason={running ? "Sampling…" : "Server is not running"} />} sub="100% = one core" />
        </div>
        <div className="p-5">
          <Stat label="Memory" value={running && m?.memoryBytes != null ? formatBytes(m.memoryBytes) : <Unavailable />} sub={`of ${(s.memoryMb / 1024).toFixed(1)} GB heap`} />
          {running && memPct !== null && <Progress value={Math.min(100, memPct)} className="mt-2" />}
        </div>
        <div className="p-5">
          <Stat
            label="TPS"
            value={running && m?.tps != null ? m.tps.toFixed(1) : <Unavailable reason={s.software === "vanilla" ? "Vanilla reports MSPT via /tick query (1.20.3+); TPS is derived from it" : "Waiting for the next sample"} />}
            sub={running && m?.mspt != null ? `${m.mspt.toFixed(1)} ms/tick` : "ms/tick unavailable"}
          />
        </div>
        <div className="p-5">
          <Stat label="Uptime" value={running && s.startedAt ? formatDuration(Date.now() - s.startedAt) : <Unavailable />} />
        </div>
        <div className="p-5">
          <Stat label="Storage" value={ov.data ? formatBytes(ov.data.storageBytes) : <Skeleton className="h-7 w-16" />} sub={ov.data?.disk ? `${formatBytes(ov.data.disk.free)} free on disk` : undefined} />
        </div>
      </Panel>

      <div className="grid gap-10 lg:grid-cols-3">
        <div className="space-y-10 lg:col-span-2">
          <Section title="Console" actions={<Link href={`/server/?id=${s.id}&tab=console`} className="flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground">Open console <ArrowRight className="size-3.5" /></Link>}>
            <div className="h-64 overflow-hidden rounded-xl bg-console">
              <ConsoleLines lines={stream.lines.slice(-40)} autoScroll className="h-full" />
            </div>
          </Section>
          <Section title="Recent events">
            <Panel>{ov.data ? <EventList events={ov.data.events} compact /> : <Skeleton className="m-4 h-24" />}</Panel>
          </Section>
        </div>
        <div className="space-y-10">
          <Section title="Connect">
            <Panel className="divide-y divide-border text-[13px]">
              {ov.data?.addresses.lan.map((a) => (
                <div key={a} className="flex items-center justify-between gap-2 px-4 py-3">
                  <div>
                    <p className="text-xs text-muted-foreground">Local network</p>
                    <p className="font-mono">{a}</p>
                  </div>
                  <CopyButton value={a} />
                </div>
              ))}
              {ov.data && (
                <div className="flex items-center justify-between gap-2 px-4 py-3">
                  <div>
                    <p className="text-xs text-muted-foreground">This computer</p>
                    <p className="font-mono">{ov.data.addresses.local}</p>
                  </div>
                  <CopyButton value={ov.data.addresses.local} />
                </div>
              )}
              <div className="px-4 py-3">
                <Link href={`/server/?id=${s.id}&tab=network`} className="text-muted-foreground hover:text-foreground">
                  Internet access & diagnostics →
                </Link>
              </div>
            </Panel>
          </Section>
          <Section title="Online players">
            <Panel>
              {!running ? (
                <p className="p-4 text-[13px] text-muted-foreground">Server is not running.</p>
              ) : players.length ? (
                <ul className="divide-y divide-border">
                  {players.map((p) => (
                    <li key={p.name} className="flex items-center justify-between px-4 py-2.5 text-[13px]">
                      <span className="font-medium">{p.name}</span>
                      <span className="text-xs text-muted-foreground">{timeAgo(p.joinedAt)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="p-4 text-[13px] text-muted-foreground">No players online.</p>
              )}
            </Panel>
          </Section>
          <Section title="Latest backup">
            <Panel className="p-4 text-[13px]">
              {ov.data?.latestBackup ? (
                <>
                  <p className="font-medium">{timeAgo(ov.data.latestBackup.createdAt)}</p>
                  <p className="text-muted-foreground">
                    {formatBytes(ov.data.latestBackup.size)} · {ov.data.latestBackup.kind}
                  </p>
                </>
              ) : (
                <p className="text-muted-foreground">No backups yet.</p>
              )}
              <Link href={`/server/?id=${s.id}&tab=backups`} className="mt-2 inline-block text-muted-foreground hover:text-foreground">
                Manage backups →
              </Link>
            </Panel>
          </Section>
        </div>
      </div>
    </div>
  );
}
