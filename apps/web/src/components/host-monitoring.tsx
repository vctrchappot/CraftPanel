"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Cpu, HardDrive, MemoryStick } from "lucide-react";
import { Panel, Section, SegmentedControl, Skeleton } from "@craftpanel/ui";
import {
  METRIC_RANGE_MS,
  softwareLabel,
  type HostMetricBucket,
  type HostMetrics,
  type ServerOverviewMetrics,
  type SystemMetricsResponse,
} from "@craftpanel/shared";
import { api } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import { MetricChart, type Point } from "./charts";
import { StatusBadge } from "./status";
import { ServerIcon } from "./server-icon";
import type { SystemInfo } from "./home";

const RANGES = [
  ["15 min", "15m"],
  ["1 h", "1h"],
  ["24 h", "24h"],
  ["7 d", "7d"],
  ["30 d", "30d"],
] as const;
type ChartRange = (typeof RANGES)[number][1];
type StoredRange = Exclude<ChartRange, "15m" | "1h">;
const RAW_MINUTES: Record<"15m" | "1h", number> = { "15m": 15, "1h": 60 };
const isStored = (r: ChartRange): r is StoredRange => r !== "15m" && r !== "1h";
const RANGE_TEXT: Record<StoredRange, string> = {
  "24h": "Minute averages over the last 24 hours",
  "7d": "Hourly averages over the last 7 days",
  "30d": "Hourly averages over the last 30 days",
};

const pct = (v: number) => `${v.toFixed(1)}%`;
const pctAxis = (v: number) => `${Math.round(v)}%`;
const mem = (bytes: number) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${(bytes / 1024 ** 2).toFixed(0)} MB`);
const gbAxis = (bytes: number) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(0)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`);

type HostKey = "cpu" | "memory" | "disk";
type HostView = {
  series: Record<HostKey, Point[]>;
  stats: Record<HostKey, { avg: number | null; max: number | null; latest: number | null }>;
  memoryTotal: number;
  diskTotal: number | null;
};

function summarizeRaw(samples: HostMetrics[], pick: (m: HostMetrics) => number | null) {
  const vals = samples.map(pick).filter((v): v is number => v !== null && Number.isFinite(v));
  if (!vals.length) return { avg: null, max: null, latest: null };
  return {
    avg: vals.reduce((a, b) => a + b, 0) / vals.length,
    max: Math.max(...vals),
    latest: vals[vals.length - 1],
  };
}

function fromHostBuckets(buckets: HostMetricBucket[], width: number, fallbackMemTotal: number, fallbackDiskTotal: number | null): HostView {
  const line = (pick: (b: HostMetricBucket) => number | null): Point[] => buckets.map((b) => ({ ts: b.ts + width / 2, v: pick(b) }));
  const stat = (avgPick: (b: HostMetricBucket) => number | null, maxPick: (b: HostMetricBucket) => number | null) => {
    const avgs = buckets.map(avgPick).filter((v): v is number => v !== null);
    const maxes = buckets.map(maxPick).filter((v): v is number => v !== null);
    return {
      avg: avgs.length ? avgs.reduce((a, b) => a + b, 0) / avgs.length : null,
      max: maxes.length ? Math.max(...maxes) : null,
      latest: avgs.length ? avgs[avgs.length - 1] : null,
    };
  };
  const memTotals = buckets.map((b) => b.memoryTotalBytes).filter((v): v is number => v !== null && v > 0);
  const diskTotals = buckets.map((b) => b.diskTotalBytes).filter((v): v is number => v !== null && v > 0);
  return {
    series: {
      cpu: line((b) => b.cpuAvg),
      memory: line((b) => b.memoryUsedAvg),
      disk: line((b) => b.diskUsedAvg),
    },
    stats: {
      cpu: stat((b) => b.cpuAvg, (b) => b.cpuMax),
      memory: stat((b) => b.memoryUsedAvg, (b) => b.memoryUsedMax),
      disk: stat((b) => b.diskUsedAvg, (b) => b.diskUsedMax),
    },
    memoryTotal: memTotals.length ? Math.max(...memTotals) : fallbackMemTotal,
    diskTotal: diskTotals.length ? Math.max(...diskTotals) : fallbackDiskTotal,
  };
}

const ACTIVE_ORDER: Record<ServerOverviewMetrics["status"], number> = {
  running: 0,
  starting: 1,
  installing: 2,
  stopping: 3,
  crashed: 4,
  error: 5,
  orphaned: 6,
  stopped: 7,
  unknown: 8,
};

export function HostMonitoringSection({ system }: { system?: SystemInfo }) {
  const [range, setRange] = React.useState<ChartRange>("15m");
  const long = isStored(range);
  const apiRange = long ? range : "1h";

  const metrics = useQuery({
    queryKey: ["system-metrics", apiRange],
    queryFn: () => api.get<SystemMetricsResponse>(`/api/system/metrics?range=${apiRange}`),
    refetchInterval: long ? 60_000 : 15_000,
  });

  const data = metrics.data;
  const rawSamples = data && data.host.range === "1h" ? data.host.samples : [];
  const storedHost = data && data.host.range !== "1h" ? data.host : null;
  const width = storedHost?.resolutionMs ?? 60_000;

  const fallbackMemTotal = system?.memory.total ?? 1;
  const fallbackDiskTotal = system?.disk?.total ?? null;

  const lastTs = rawSamples.length ? rawSamples[rawSamples.length - 1].ts : metrics.dataUpdatedAt || Date.now();
  const firstTs = rawSamples.length ? rawSamples[0].ts : lastTs;
  const to = long ? metrics.dataUpdatedAt || Date.now() : lastTs;
  const from = long ? to - METRIC_RANGE_MS[range] : Math.max(to - RAW_MINUTES[range] * 60_000, Math.min(firstTs, to - 60_000));

  const windowed = React.useMemo(() => rawSamples.filter((m) => m.ts >= from), [rawSamples, from]);

  const view = React.useMemo<HostView>(() => {
    if (long) return fromHostBuckets(storedHost?.buckets ?? [], width, fallbackMemTotal, fallbackDiskTotal);
    const pts = (pick: (m: HostMetrics) => number | null): Point[] => rawSamples.map((m) => ({ ts: m.ts, v: pick(m) }));
    const memTotals = rawSamples.map((m) => m.memoryTotalBytes).filter((v) => v > 0);
    const diskTotals = rawSamples.map((m) => m.diskTotalBytes).filter((v): v is number => v !== null && v > 0);
    return {
      series: {
        cpu: pts((m) => m.cpuPercent),
        memory: pts((m) => m.memoryUsedBytes),
        disk: pts((m) => m.diskUsedBytes),
      },
      stats: {
        cpu: summarizeRaw(windowed, (m) => m.cpuPercent),
        memory: summarizeRaw(windowed, (m) => m.memoryUsedBytes),
        disk: summarizeRaw(windowed, (m) => m.diskUsedBytes),
      },
      memoryTotal: memTotals.length ? Math.max(...memTotals) : fallbackMemTotal,
      diskTotal: diskTotals.length ? Math.max(...diskTotals) : fallbackDiskTotal,
    };
  }, [long, storedHost, width, rawSamples, windowed, fallbackMemTotal, fallbackDiskTotal]);

  const gapMs = long ? width * 2.5 : 45_000;

  const overviewServers = React.useMemo(() => {
    if (!data?.servers.length) return [];
    return [...data.servers].sort((a, b) => (ACTIVE_ORDER[a.status] - ACTIVE_ORDER[b.status]) || a.name.localeCompare(b.name));
  }, [data?.servers]);

  const totalServerMemBytes = overviewServers.reduce((n, s) => n + (s.memoryBytes ?? 0), 0);
  const totalServerCpu = overviewServers.reduce((n, s) => n + (s.cpuPercent ?? 0), 0);
  const runningCount = overviewServers.filter((s) => s.status === "running").length;

  return (
    <Section
      title="Host history"
      description={long ? RANGE_TEXT[range] : "Machine CPU, memory and disk usage, sampled continuously even when no dashboard is open."}
      actions={
        <SegmentedControl
          aria-label="Host history time range"
          value={range}
          onValueChange={(v) => setRange(v as ChartRange)}
          options={RANGES.map(([label, value]) => ({ label, value }))}
        />
      }
    >
      {metrics.isLoading && !data ? (
        <div className="grid gap-4 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-64 rounded-lg" />
          ))}
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-3">
            <MetricChart
              title="Host CPU"
              points={view.series.cpu}
              from={from}
              to={to}
              max={100}
              alert={{ value: 85, label: "above 85%" }}
              format={pct}
              axisFormat={pctAxis}
              gapMs={gapMs}
              empty="Collecting CPU samples…"
              stat={{
                icon: <Cpu />,
                value: view.stats.cpu.latest !== null ? pct(view.stats.cpu.latest) : "—",
                hint: system ? `${system.cpus} cores · ${runningCount} server${runningCount === 1 ? "" : "s"} running` : "Machine processor usage",
                detail:
                  view.stats.cpu.avg !== null && view.stats.cpu.max !== null
                    ? `Avg ${pct(view.stats.cpu.avg)} · peak ${pct(view.stats.cpu.max)}`
                    : "Waiting for samples",
              }}
            />

            <MetricChart
              title="Host memory"
              points={view.series.memory}
              from={from}
              to={to}
              max={Math.max(1, view.memoryTotal)}
              alert={{ value: view.memoryTotal * 0.9, label: "above 90%" }}
              format={mem}
              axisFormat={gbAxis}
              gapMs={gapMs}
              empty="Collecting memory samples…"
              stat={{
                icon: <MemoryStick />,
                value: view.stats.memory.latest !== null ? mem(view.stats.memory.latest) : "—",
                hint: `of ${formatBytes(view.memoryTotal)}${totalServerMemBytes > 0 ? ` · ${mem(totalServerMemBytes)} used by servers` : ""}`,
                detail:
                  view.stats.memory.avg !== null && view.stats.memory.max !== null
                    ? `Avg ${mem(view.stats.memory.avg)} · peak ${mem(view.stats.memory.max)}`
                    : "Waiting for samples",
              }}
            />

            <MetricChart
              title="Disk usage"
              points={view.series.disk}
              from={from}
              to={to}
              max={Math.max(1, view.diskTotal ?? (view.stats.disk.max ?? 1))}
              alert={view.diskTotal ? { value: view.diskTotal * 0.9, label: "above 90%" } : undefined}
              format={mem}
              axisFormat={gbAxis}
              gapMs={gapMs}
              empty={view.diskTotal ? "Collecting disk samples…" : "Disk usage unavailable on this platform"}
              stat={{
                icon: <HardDrive />,
                value: view.stats.disk.latest !== null ? mem(view.stats.disk.latest) : "—",
                hint:
                  view.diskTotal && view.stats.disk.latest !== null
                    ? `${formatBytes(Math.max(0, view.diskTotal - view.stats.disk.latest))} free of ${formatBytes(view.diskTotal)}`
                    : view.diskTotal
                      ? `of ${formatBytes(view.diskTotal)}`
                      : "Data directory volume",
                detail:
                  view.stats.disk.avg !== null && view.stats.disk.max !== null
                    ? `Avg ${mem(view.stats.disk.avg)} · peak ${mem(view.stats.disk.max)}`
                    : "Waiting for samples",
              }}
            />
          </div>

          {overviewServers.length > 0 && (
            <Panel className="overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
                <h3 className="text-[13px] font-medium">All servers at a glance</h3>
                <p className="text-xs tabular-nums text-muted-foreground">
                  {runningCount} of {overviewServers.length} running
                  {runningCount > 0 && totalServerMemBytes > 0 && ` · ${mem(totalServerMemBytes)} RAM`}
                  {runningCount > 0 && totalServerCpu > 0 && ` · ${pct(totalServerCpu)} CPU`}
                </p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-[13px]">
                  <thead className="border-b border-border text-xs text-muted-foreground">
                    <tr>
                      <th className="px-4 py-2.5 font-medium">Server</th>
                      <th className="px-3 py-2.5 font-medium">Status</th>
                      <th className="px-3 py-2.5 text-right font-medium">Players</th>
                      <th className="px-3 py-2.5 text-right font-medium">CPU</th>
                      <th className="px-3 py-2.5 text-right font-medium">Memory</th>
                      <th className="px-4 py-2.5 text-right font-medium">TPS</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {overviewServers.map((srv) => (
                      <tr key={srv.id} className="transition-colors hover:bg-muted/40">
                        <td className="px-4 py-2.5">
                          <Link href={`/server/?id=${srv.id}&tab=performance`} className="flex min-w-0 items-center gap-2.5 hover:underline">
                            <ServerIcon server={srv} size={24} />
                            <div className="min-w-0">
                              <p className="truncate font-medium">{srv.name}</p>
                              <p className="truncate text-xs text-muted-foreground">
                                {softwareLabel(srv.software)} {srv.mcVersion}
                              </p>
                            </div>
                          </Link>
                        </td>
                        <td className="px-3 py-2.5">
                          <StatusBadge status={srv.status} />
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
                          {srv.status === "running" ? `${srv.playersOnline}/${srv.maxPlayers}` : "—"}
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums">
                          {srv.cpuPercent !== null ? pct(srv.cpuPercent) : "—"}
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums">
                          {srv.memoryBytes !== null ? (
                            <>
                              {mem(srv.memoryBytes)} <span className="text-muted-foreground">/ {(srv.memoryMb / 1024).toFixed(1)} GB</span>
                            </>
                          ) : (
                            <span className="text-muted-foreground">{(srv.memoryMb / 1024).toFixed(1)} GB</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums">
                          {srv.tps !== null ? (
                            <span className={srv.tps < 18 ? "text-warning" : undefined}>{srv.tps.toFixed(1)}</span>
                          ) : (
                            "—"
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          )}
        </div>
      )}
    </Section>
  );
}
