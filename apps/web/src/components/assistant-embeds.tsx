"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Activity, ArrowUpRight, Archive, Gauge, SquareTerminal, Users } from "lucide-react";
import { cn } from "@craftpanel/ui";
import type { AssistantCard, AssistantEmbed as Embed, BackupInfo, ConsoleLine, ServerMetrics } from "@craftpanel/shared";
import { api } from "@/lib/api";
import { formatBytes, formatDuration, timeAgo } from "@/lib/format";
import { useServer } from "@/lib/queries";
import { useServerStream } from "@/lib/realtime";
import { PlayerAvatar } from "./server/player-parts";
import { StatusBadge } from "./status";

// Live cards the assistant puts into a conversation (its show_card tool). They read the same APIs and real-time
// stream as the server pages, with the viewer's own access, so they show current numbers and keep updating.

const META: Record<AssistantCard, { label: string; icon: React.ReactNode; tab: string }> = {
  status: { label: "Status", icon: <Activity />, tab: "overview" },
  performance: { label: "Performance", icon: <Gauge />, tab: "performance" },
  players: { label: "Players", icon: <Users />, tab: "players" },
  console: { label: "Console", icon: <SquareTerminal />, tab: "console" },
  backups: { label: "Backups", icon: <Archive />, tab: "backups" },
};

export function AssistantEmbed({ embed }: { embed: Embed }) {
  const server = useServer(embed.serverId);
  const s = server.data;
  const meta = META[embed.card];
  const live = s?.status === "running";
  return (
    <figure className="overflow-hidden rounded-lg border border-border bg-surface text-[13px] shadow-xs">
      <figcaption className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-muted-foreground [&_svg]:size-3.5">{meta.icon}</span>
        <span className="font-medium">{meta.label}</span>
        <span className="min-w-0 truncate text-muted-foreground">· {s?.name ?? embed.serverName}</span>
        {embed.filter && <code className="rounded bg-muted px-1 font-mono text-[11px]">{embed.filter}</code>}
        <span className="ml-auto flex items-center gap-1.5 text-[11px] text-muted-foreground" title={live ? "Updates as it changes" : "The server is not running"}>
          <span className={cn("relative flex size-1.5 rounded-full", live ? "bg-success" : "bg-muted-foreground/40")}>
            {live && <span className="absolute inset-0 animate-ping rounded-full bg-success/60 motion-reduce:animate-none" />}
          </span>
          {live ? "Live" : "Idle"}
        </span>
        <Link
          href={`/server/?id=${encodeURIComponent(embed.serverId)}&tab=${meta.tab}`}
          className="flex items-center rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label={`Open ${meta.label}`}
          title={`Open ${meta.label}`}
        >
          <ArrowUpRight className="size-3.5" />
        </Link>
      </figcaption>
      <div className="px-3 py-2.5">
        {server.error ? (
          <p className="text-xs text-muted-foreground">This server is no longer available.</p>
        ) : !s ? (
          <div className="h-12 animate-pulse rounded bg-muted motion-reduce:animate-none" />
        ) : embed.card === "status" ? (
          <StatusCard serverId={s.id} status={<StatusBadge status={s.status} />} players={[s.playersOnline, s.maxPlayers]} memoryMb={s.memoryMb} startedAt={s.startedAt} />
        ) : embed.card === "performance" ? (
          <PerformanceCard serverId={s.id} memoryMb={s.memoryMb} running={live} startedAt={s.startedAt} />
        ) : embed.card === "players" ? (
          <PlayersCard serverId={s.id} max={s.maxPlayers} />
        ) : embed.card === "console" ? (
          <ConsoleCard serverId={s.id} filter={embed.filter} />
        ) : (
          <BackupsCard serverId={s.id} />
        )}
      </div>
    </figure>
  );
}

function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="truncate text-sm font-medium tabular-nums transition-colors">{value}</p>
      {hint && <p className="truncate text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

function StatusCard({ serverId, status, players, memoryMb, startedAt }: { serverId: string; status: React.ReactNode; players: [number, number]; memoryMb: number; startedAt: number | null }) {
  const { metrics, players: online } = useServerStream(serverId);
  const now = useNow(startedAt ? 1000 : null);
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-2.5 sm:grid-cols-4">
      <Stat label="State" value={status} hint={startedAt ? `up ${formatDuration(now - startedAt)}` : undefined} />
      <Stat label="Players" value={`${online?.length ?? players[0]} / ${players[1]}`} />
      <Stat label="CPU" value={metrics?.cpuPercent != null ? `${metrics.cpuPercent.toFixed(0)} %` : "—"} />
      <Stat label="Memory" value={metrics?.memoryBytes != null ? formatBytes(metrics.memoryBytes) : "—"} hint={`of ${formatBytes(memoryMb * 1024 ** 2, 0)}`} />
    </div>
  );
}

/** Recent samples from the API, followed by the live ones. */
function useSamples(serverId: string, startedAt: number | null) {
  const { metrics } = useServerStream(serverId);
  const hist = useQuery({ queryKey: ["metrics", serverId, startedAt], queryFn: () => api.get<{ samples: ServerMetrics[] }>(`/api/servers/${serverId}/metrics`), gcTime: 0, refetchOnWindowFocus: false });
  const [live, setLive] = React.useState<ServerMetrics[]>([]);
  React.useEffect(() => {
    if (metrics) setLive((prev) => (prev.length && prev[prev.length - 1].ts >= metrics.ts ? prev : [...prev.slice(-119), metrics]));
  }, [metrics]);
  return React.useMemo(() => {
    const base = hist.data?.samples ?? [];
    const last = base.length ? base[base.length - 1].ts : 0;
    const all = [...base, ...live.filter((m) => m.ts > last)];
    const to = all.length ? all[all.length - 1].ts : 0;
    return all.filter((m) => m.ts >= to - 10 * 60_000);
  }, [hist.data, live]);
}

function PerformanceCard({ serverId, memoryMb, running, startedAt }: { serverId: string; memoryMb: number; running: boolean; startedAt: number | null }) {
  const samples = useSamples(serverId, startedAt);
  const last = samples.at(-1);
  if (!running && !samples.length) return <p className="text-xs text-muted-foreground">The server is not running, so there are no readings.</p>;
  const tps = last?.tps ?? null;
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
      <Spark label="TPS" value={tps != null ? tps.toFixed(1) : "—"} points={samples.map((m) => m.tps)} max={20} tone={tps != null && tps < 18 ? (tps < 15 ? "bad" : "warn") : "ok"} />
      <Spark label="MSPT" value={last?.mspt != null ? `${last.mspt.toFixed(1)} ms` : "—"} points={samples.map((m) => m.mspt)} max={Math.max(60, ...samples.map((m) => m.mspt ?? 0))} reference={50} tone={last?.mspt != null && last.mspt > 50 ? "bad" : "ok"} />
      <Spark label="CPU" value={last?.cpuPercent != null ? `${last.cpuPercent.toFixed(0)} %` : "—"} points={samples.map((m) => m.cpuPercent)} max={Math.max(100, ...samples.map((m) => m.cpuPercent ?? 0))} />
      <Spark label="Memory" value={last?.memoryBytes != null ? formatBytes(last.memoryBytes) : "—"} points={samples.map((m) => m.memoryBytes)} max={Math.max(memoryMb * 1024 ** 2, ...samples.map((m) => m.memoryBytes ?? 0))} />
    </div>
  );
}

const TONE = { ok: "text-foreground", warn: "text-warning", bad: "text-destructive" } as const;

/** A label, the current value and a small line of the last ten minutes. */
function Spark({ label, value, points, max, reference, tone = "ok" }: { label: string; value: string; points: (number | null)[]; max: number; reference?: number; tone?: keyof typeof TONE }) {
  const known = points.map((v, i) => [i, v] as const).filter((p): p is readonly [number, number] => p[1] !== null);
  const n = Math.max(1, points.length - 1);
  const xy = (i: number, v: number) => `${((i / n) * 100).toFixed(2)},${(30 - (Math.min(v, max) / max) * 28).toFixed(2)}`;
  const line = known.map(([i, v]) => xy(i, v)).join(" ");
  return (
    <div className="min-w-0">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className={cn("text-sm font-medium tabular-nums transition-colors duration-300", TONE[tone])}>{value}</p>
      <svg viewBox="0 0 100 32" preserveAspectRatio="none" className="mt-1 h-7 w-full overflow-visible text-muted-foreground" aria-hidden>
        {reference !== undefined && reference < max && <line x1="0" x2="100" y1={30 - (reference / max) * 28} y2={30 - (reference / max) * 28} className="stroke-current opacity-40" strokeDasharray="2 2" vectorEffect="non-scaling-stroke" />}
        {known.length > 1 && (
          <>
            <polygon points={`${xy(known[0][0], 0)} ${line} ${xy(known[known.length - 1][0], 0)}`} className={cn("opacity-[0.06]", tone === "ok" ? "fill-foreground" : tone === "warn" ? "fill-warning" : "fill-destructive")} />
            <polyline points={line} fill="none" className={cn("stroke-[1.5] transition-[stroke] duration-300", tone === "ok" ? "stroke-foreground/70" : tone === "warn" ? "stroke-warning" : "stroke-destructive")} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
          </>
        )}
      </svg>
    </div>
  );
}

function PlayersCard({ serverId, max }: { serverId: string; max: number }) {
  const { players } = useServerStream(serverId);
  const now = useNow(30_000);
  if (!players) return <div className="h-8 animate-pulse rounded bg-muted motion-reduce:animate-none" />;
  if (!players.length) return <p className="text-xs text-muted-foreground">Nobody is online. {max} slots.</p>;
  return (
    <ul className="space-y-1.5">
      {players.map((p) => (
        <li key={p.name} className="flex items-center gap-2 animate-in fade-in slide-in-from-bottom-1 duration-300 motion-reduce:animate-none">
          <PlayerAvatar name={p.name} uuid={p.uuid} size={20} className="rounded-sm" />
          <span className="font-medium">{p.name}</span>
          <span className="ml-auto text-[11px] text-muted-foreground">for {formatDuration(now - p.joinedAt)}</span>
        </li>
      ))}
      <li className="pt-0.5 text-[11px] text-muted-foreground">
        {players.length} of {max} online
      </li>
    </ul>
  );
}

// The console tab's colours, on its dark background in both themes.
const LEVEL: Partial<Record<ConsoleLine["level"], string>> = { WARN: "text-status-starting", ERROR: "text-status-crashed", FATAL: "text-status-crashed", DEBUG: "text-console-muted" };

function ConsoleCard({ serverId, filter }: { serverId: string; filter?: string }) {
  const { lines } = useServerStream(serverId);
  const shown = React.useMemo(() => {
    const f = filter?.toLowerCase();
    return (f ? lines.filter((l) => l.text.toLowerCase().includes(f)) : lines).slice(-10);
  }, [lines, filter]);
  const box = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    box.current?.scrollTo({ top: box.current.scrollHeight });
  }, [shown]);
  return (
    <div ref={box} className="scrollbar-thin -mx-1 max-h-44 overflow-y-auto rounded-md bg-console px-2 py-1.5 font-mono text-[11px] leading-relaxed">
      {shown.length ? (
        shown.map((l) => (
          <p key={l.seq} className={cn("whitespace-pre-wrap break-all animate-in fade-in duration-300 motion-reduce:animate-none", LEVEL[l.level] ?? "text-console-foreground")}>
            {l.text}
          </p>
        ))
      ) : (
        <p className="text-console-muted">{filter ? `No lines containing "${filter}".` : "No output yet."}</p>
      )}
    </div>
  );
}

const BACKUP_STATE: Record<BackupInfo["status"], string> = { completed: "text-success", failed: "text-destructive", running: "text-warning", pending: "text-muted-foreground" };

function BackupsCard({ serverId }: { serverId: string }) {
  const q = useQuery({ queryKey: ["backups", serverId], queryFn: () => api.get<BackupInfo[]>(`/api/backups?serverId=${serverId}`) });
  if (!q.data) return <div className="h-8 animate-pulse rounded bg-muted motion-reduce:animate-none" />;
  if (!q.data.length) return <p className="text-xs text-muted-foreground">No backups yet.</p>;
  return (
    <ul className="divide-y divide-border">
      {q.data.slice(0, 4).map((b) => (
        <li key={b.id} className="flex items-center gap-2 py-1.5 first:pt-0 last:pb-0">
          <span className={cn("size-1.5 shrink-0 rounded-full bg-current", BACKUP_STATE[b.status])} aria-hidden />
          <span className="min-w-0 truncate">{b.note || b.kind.replace("-", " ")}</span>
          <span className="ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground">
            {b.status === "completed" ? formatBytes(b.size) : b.status} · {timeAgo(b.createdAt)}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The current time, refreshed every `ms` (null: never), for durations that keep counting. */
function useNow(ms: number | null) {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!ms) return;
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
