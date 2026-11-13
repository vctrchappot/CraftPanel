"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity, AlertTriangle, Check, CheckCircle2, ChevronDown, Cpu, Download, Gauge, Info, Map as MapIcon, MemoryStick, Pause, Play, RotateCw, Save, SlidersHorizontal, Square, Timer, Users, Zap } from "lucide-react";
import { Badge, Button, Callout, ChoiceCard, Field, Input, Panel, Progress, Section, SegmentedControl, Skeleton, Textarea, cn } from "@craftpanel/ui";
import {
  analyzePerformance,
  applyPresetFlags,
  PRESET_INFO,
  SOFTWARE_INFO,
  summarize,
  type HostFit,
  type Insight,
  type InsightFix,
  type InsightLevel,
  type PerformancePreset,
  type ServerDetail,
  type ServerMetrics,
} from "@craftpanel/shared";
import { api, ApiError } from "@/lib/api";
import { useCan } from "@/lib/auth";
import { useAction, useServerLifecycle } from "@/lib/queries";
import { formatBytes, formatNumber } from "@/lib/format";
import { MetricChart } from "../charts";
import { Unavailable } from "../status";
import { SettingRow, useProperties } from "./settings";
import type { Stream } from "./workspace";

interface PerformanceInfo {
  current: PerformancePreset | null;
  recommended: PerformancePreset;
  fit: HostFit;
  viewDistance: number | null;
  simulationDistance: number | null;
  presets: { id: PerformancePreset; label: string; description: string; viewDistance: number; simulationDistance: number; jvmFlags: string[] }[];
}

interface PregenStatus {
  supported: boolean;
  installed: boolean;
  restartNeeded: boolean;
  running: boolean;
  task: { state: "running" | "finished" | "paused" | "stopped"; world: string; chunks: number; percent: number; eta: string | null; rate: number | null; at: number } | null;
}

const ICONS: Record<PerformancePreset, React.ReactNode> = { "low-power": <Cpu />, balanced: <Gauge />, performance: <Zap /> };
const RANGES = [
  ["5 min", 5],
  ["15 min", 15],
  ["1 hour", 60],
] as const;
const MAX_LIVE = 1000;
const ms = (v: number) => v.toFixed(1);
const pct = (v: number) => `${v.toFixed(1)}%`;
/** Memory readings always carry one decimal, so 244.0 MB and 1.4 GB line up from one sample to the next. */
const mem = (bytes: number) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`);
const gb = (mb: number) => `${(mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1)} GB`;

/** The metric history the API kept, followed by whatever the live stream delivered since. */
function useSamples(s: ServerDetail, stream: Stream): ServerMetrics[] {
  // gcTime 0: a cached history from an earlier visit would hide everything sampled while this tab was closed.
  const hist = useQuery({ queryKey: ["metrics", s.id, s.startedAt], queryFn: () => api.get<{ samples: ServerMetrics[] }>(`/api/servers/${s.id}/metrics`), gcTime: 0, refetchOnWindowFocus: false });
  const [live, setLive] = React.useState<ServerMetrics[]>([]);
  const m = stream.metrics;
  React.useEffect(() => setLive([]), [s.id, s.startedAt]);
  React.useEffect(() => {
    if (m) setLive((prev) => (prev.length && prev[prev.length - 1].ts >= m.ts ? prev : [...prev.slice(-(MAX_LIVE - 1)), m]));
  }, [m]);
  return React.useMemo(() => {
    const base = hist.data?.samples ?? [];
    const last = base.length ? base[base.length - 1].ts : 0;
    return [...base, ...live.filter((x) => x.ts > last)];
  }, [hist.data, live]);
}

export function PerformanceTab({ server: s, stream }: { server: ServerDetail; stream: Stream }) {
  const proxy = SOFTWARE_INFO[s.software].proxy;
  const running = s.status === "running";
  const [range, setRange] = React.useState<number>(15);
  const samples = useSamples(s, stream);
  const perf = useQuery({ queryKey: ["performance", s.id, s.memoryMb, s.jvmArgs], queryFn: () => api.get<PerformanceInfo>(`/api/servers/${s.id}/performance`) });
  const pregen = useQuery({ queryKey: ["pregen", s.id, s.status], queryFn: () => api.get<PregenStatus>(`/api/servers/${s.id}/pregen`), enabled: !proxy, refetchInterval: (q) => (q.state.data?.task?.state === "running" ? 3000 : false) });

  // Charts end at the newest sample: sampling only runs while a dashboard is open, so "now" can be a while ago.
  const to = samples.length ? samples[samples.length - 1].ts : Date.now();
  // A window longer than the data would squeeze the line against the right edge; start at the first sample instead.
  const firstTs = samples.length ? samples[0].ts : to;
  const from = Math.max(to - range * 60_000, Math.min(firstTs, to - 60_000));
  const windowed = React.useMemo(() => samples.filter((m) => m.ts >= from), [samples, from]);
  const recent = React.useMemo(() => samples.filter((m) => m.ts >= to - 5 * 60_000), [samples, to]);

  const d = perf.data;
  const insights = React.useMemo(
    () =>
      d
        ? analyzePerformance({
            running,
            software: s.software,
            samples: recent,
            memoryMb: s.memoryMb,
            jvmArgs: s.jvmArgs,
            viewDistance: d.viewDistance,
            recommendedPreset: d.recommended,
            fit: d.fit,
            pregen: pregen.data ?? null,
          })
        : null,
    [d, running, s.software, s.memoryMb, s.jvmArgs, recent, pregen.data],
  );

  const tps = summarize(windowed, (m) => m.tps);
  const mspt = summarize(windowed, (m) => m.mspt);
  const cpu = summarize(windowed, (m) => m.cpuPercent);
  const memory = summarize(windowed, (m) => m.memoryBytes);
  const players = summarize(windowed, (m) => m.playersOnline);
  const heap = s.memoryMb * 1024 * 1024;
  const pts = (pick: (m: ServerMetrics) => number | null) => samples.map((m) => ({ ts: m.ts, v: pick(m) }));
  const empty = running ? "Collecting data…" : "Start the server to collect data";
  const unavailable = <Unavailable reason={running ? "Waiting for the next sample" : "Server is not running"} />;
  const live = running ? stream.metrics : null;
  const avgLow = (x: typeof tps, f: (v: number) => string) => (x.avg === null ? undefined : `avg ${f(x.avg)} · low ${f(x.min!)}`);
  const avgPeak = (x: typeof tps, f: (v: number) => string) => (x.avg === null ? undefined : `avg ${f(x.avg)} · peak ${f(x.max!)}`);

  const attention = insights?.filter((i) => i.level === "warning" || i.level === "danger").length ?? 0;
  const metric = (value: React.ReactNode, detail: string | undefined, hint: string, icon: React.ReactNode) => ({ value, detail: detail ?? "Waiting for samples in this time range", hint, icon });

  return (
    <div className="space-y-8">
      <section aria-labelledby="performance-overview" className="space-y-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-2.5">
              <h2 id="performance-overview" className="text-base font-medium">Performance overview</h2>
              <Badge variant={live ? "success" : "default"}>
                {live ? <Activity /> : <Pause />}
                {live ? "Live" : running ? "Waiting for data" : samples.length ? "Last run" : "Offline"}
              </Badge>
            </div>
            <p className="text-[13px] text-muted-foreground">
              {!running && samples.length ? "The server is offline. Charts show its last recorded run." : "Live readings with up to an hour of history. Hover or touch a chart to inspect."}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-3">
            <span className="text-xs text-muted-foreground">Chart range</span>
            <SegmentedControl aria-label="Time range" value={range} onValueChange={setRange} options={RANGES.map(([label, minutes]) => ({ value: minutes, label }))} />
          </div>
        </div>

        {!proxy && (
          <div className="grid gap-4 md:grid-cols-2">
            <MetricChart
              title="TPS"
              stat={metric(live?.tps != null ? live.tps.toFixed(1) : unavailable, avgLow(tps, (v) => v.toFixed(1)), "20 ticks per second is the target", <Gauge />)}
              points={pts((m) => m.tps)} from={from} to={to} max={20} alert={{ value: 18, below: true, label: "below 18 TPS" }} format={(v) => v.toFixed(1)} empty={empty}
            />
            <MetricChart
              title="Tick time"
              stat={metric(live?.mspt != null ? `${ms(live.mspt)} ms` : unavailable, avgPeak(mspt, (v) => `${ms(v)} ms`), "Stay below the 50 ms tick budget", <Timer />)}
              points={pts((m) => m.mspt)} from={from} to={to}
              max={Math.max(60, Math.ceil((mspt.max ?? 0) / 10) * 10)} reference={{ value: 50, label: "50 ms budget" }} alert={{ value: 50, label: "over the budget" }} format={(v) => `${ms(v)} ms`} axisFormat={(v) => `${Math.round(v)} ms`} empty={empty}
            />
          </div>
        )}
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <MetricChart
            title="CPU"
            stat={metric(live?.cpuPercent != null ? pct(live.cpuPercent) : unavailable, avgPeak(cpu, pct), "100% equals one fully used core", <Cpu />)}
            points={pts((m) => m.cpuPercent)} from={from} to={to}
            max={Math.max(100, Math.ceil((cpu.max ?? 0) / 50) * 50)} reference={{ value: 100, label: "one core" }} format={pct} axisFormat={(v) => `${Math.round(v)}%`} empty={empty}
          />
          <MetricChart
            title="Memory"
            stat={metric(live?.memoryBytes != null ? mem(live.memoryBytes) : unavailable, memory.max === null ? undefined : `peak ${mem(memory.max)}`, `${gb(s.memoryMb)} configured Java heap · process memory shown`, <MemoryStick />)}
            points={pts((m) => m.memoryBytes)} from={from} to={to} max={Math.max(heap, memory.max ?? 0)}
            reference={{ value: heap, label: "configured heap" }} format={mem} axisFormat={(v) => formatBytes(v)} empty={empty}
          />
          <MetricChart
            title="Players"
            className="md:col-span-2 xl:col-span-1"
            stat={metric(live ? `${live.playersOnline} / ${s.maxPlayers}` : unavailable, players.max === null ? undefined : `peak ${players.max} online`, "Connected players over time", <Users />)}
            points={pts((m) => m.playersOnline)} from={from} to={to} max={Math.max(4, players.max ?? 0)} format={(v) => v.toFixed(0)} empty={empty}
          />
        </div>
        <p className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0" />
          Values show the current reading; averages and peaks follow the selected chart range. Samples are collected every few seconds while a dashboard is open.
        </p>
      </section>

      <Section
        title={<span className="flex flex-wrap items-center gap-2">Insights {attention > 0 && <Badge variant="warning">{attention} to review</Badge>}</span>}
        description="Based on the last 5 minutes and your current configuration."
      >
        {insights ? <InsightList server={s} insights={insights} /> : perf.isError ? <Callout icon={<Info />} title="Insights unavailable">Performance settings could not be loaded. Try reopening this page.</Callout> : <Skeleton className="h-24 rounded-lg" />}
      </Section>

      <div className="space-y-5 border-t border-border pt-8">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <h2 className="text-base font-medium">Tuning</h2>
            <p className="text-[13px] text-muted-foreground">{proxy ? "Adjust the memory and Java settings for this proxy." : "Start with a preset, then fine-tune for your server."}</p>
          </div>
          <Badge variant="outline"><RotateCw /> Configuration applies on next start</Badge>
        </div>
        {!d && perf.isError ? (
          <Callout icon={<Info />} title="Tuning unavailable">Performance settings could not be loaded. Try reopening this page.</Callout>
        ) : (
          <>
            {!proxy && <Panel className="p-5 sm:p-6"><Presets server={s} info={d} /></Panel>}
            <div className={cn("grid gap-5", !proxy && "xl:grid-cols-2")}>
              <Panel className="min-w-0 p-5 sm:p-6">{d ? <MemoryAndJvm server={s} fit={d.fit} /> : <Skeleton className="h-64" />}</Panel>
              {!proxy && <Panel id="pregen" className="min-w-0 scroll-mt-6 p-5 sm:p-6"><Pregeneration server={s} /></Panel>}
            </div>
            <Panel id="limits" className="scroll-mt-6 p-5 sm:p-6"><ResourceLimits server={s} /></Panel>
          </>
        )}
        {!proxy && (
          <details className="group rounded-lg border border-border bg-surface">
            <summary className="flex cursor-pointer list-none items-center gap-3 rounded-lg p-5 outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-6 [&::-webkit-details-marker]:hidden">
              <SlidersHorizontal className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 space-y-1">
                <span className="block text-sm font-medium">Advanced server settings</span>
                <span className="block text-xs leading-relaxed text-muted-foreground">View and simulation distances, watchdog and chunk saving</span>
              </span>
              <ChevronDown className="size-4 shrink-0 text-muted-foreground group-open:rotate-180" />
            </summary>
            <div className="border-t border-border p-5 sm:p-6"><PerformanceProperties server={s} /></div>
          </details>
        )}
      </div>
    </div>
  );
}

const LEVEL: Record<InsightLevel, { icon: React.ReactNode; className: string }> = {
  ok: { icon: <CheckCircle2 />, className: "text-success" },
  info: { icon: <Info />, className: "text-muted-foreground" },
  warning: { icon: <AlertTriangle />, className: "text-warning" },
  danger: { icon: <AlertTriangle />, className: "text-destructive" },
};

function InsightList({ server: s, insights }: { server: ServerDetail; insights: Insight[] }) {
  const canEdit = useCan("server.configure");
  const running = !["stopped", "crashed", "error"].includes(s.status);
  const apply = useAction(
    (fix: InsightFix) => {
      if (fix.kind === "gc") return api.patch(`/api/servers/${s.id}`, { jvmArgs: applyPresetFlags(s.jvmArgs, fix.preset, s.memoryMb) });
      if (fix.kind === "memory") return api.patch(`/api/servers/${s.id}`, { memoryMb: fix.memoryMb });
      if (fix.kind === "view-distance") return api.put(`/api/servers/${s.id}/properties`, { values: { "view-distance": String(fix.value) } });
      return Promise.resolve();
    },
    { success: running ? "Saved. Restart the server to apply." : "Saved. It takes effect on the next start.", invalidate: [["server", s.id], ["servers"], ["performance", s.id], ["properties", s.id]] },
  );
  const label = (fix: InsightFix) =>
    fix.kind === "gc" ? `Apply ${PRESET_INFO[fix.preset].label} GC flags` : fix.kind === "memory" ? `Use ${gb(fix.memoryMb)}` : fix.kind === "view-distance" ? `Set to ${fix.value}` : "Open pre-generation";
  return (
    <Panel className="divide-y divide-border">
      {insights.length === 0 && <p className="p-4 text-[13px] text-muted-foreground">Nothing to flag. Start the server and open this page while it runs to see how it performs.</p>}
      {insights.map((i) => (
        <div key={i.id} className="flex flex-wrap items-start gap-3 p-4 sm:p-5">
          <span className={cn("mt-0.5 shrink-0 [&_svg]:size-4", LEVEL[i.level].className)}>{LEVEL[i.level].icon}</span>
          <div className="min-w-0 flex-[1_1_200px] space-y-1">
            <p className="text-[13px] font-medium">{i.title}</p>
            <p className="text-xs leading-relaxed text-muted-foreground">{i.detail}</p>
          </div>
          {i.fix && (i.fix.kind === "pregen" || canEdit) && (
            <Button
              size="sm"
              variant="secondary"
              className="ml-7 max-w-[calc(100%-1.75rem)] whitespace-normal text-left sm:ml-0"
              loading={apply.isPending && apply.variables === i.fix}
              onClick={() => (i.fix!.kind === "pregen" ? document.getElementById("pregen")?.scrollIntoView({ behavior: "smooth" }) : apply.mutate(i.fix!))}
            >
              {label(i.fix)}
            </Button>
          )}
        </div>
      ))}
    </Panel>
  );
}

function Presets({ server: s, info: d }: { server: ServerDetail; info: PerformanceInfo | undefined }) {
  const canEdit = useCan("server.configure");
  const [chosen, setChosen] = React.useState<PerformancePreset | null>(null);
  const running = !["stopped", "crashed", "error"].includes(s.status);
  const apply = useAction((preset: PerformancePreset) => api.post(`/api/servers/${s.id}/performance`, { preset }), {
    success: running ? "Preset applied. Restart the server to use it." : "Preset applied. It takes effect on the next start.",
    invalidate: [["server", s.id], ["servers"], ["performance", s.id], ["properties", s.id]],
    onSuccess: () => setChosen(null),
  });
  if (!d) return <Skeleton className="h-64 rounded-lg" />;
  const selected = chosen ?? d.current ?? d.recommended;
  const preset = d.presets.find((p) => p.id === selected)!;
  return (
    <Section
      title="Performance preset"
      description={
        <>
          Now: {d.current ? d.presets.find((p) => p.id === d.current)!.label : "custom settings"} · view distance {d.viewDistance ?? "default"} · simulation distance {d.simulationDistance ?? "default"}
        </>
      }
    >
      <div role="group" aria-label="Performance preset" className="grid gap-3 lg:grid-cols-3">
        {d.presets.map((p) => (
          <ChoiceCard key={p.id} selected={selected === p.id} disabled={!canEdit} onClick={() => setChosen(p.id)} className="flex min-w-0 flex-col gap-4 disabled:opacity-100">
            <span className="flex w-full flex-wrap items-center justify-between gap-2">
              <span className="text-muted-foreground [&_svg]:size-5">{ICONS[p.id]}</span>
              <span className="flex flex-wrap gap-1.5">
                {p.id === d.recommended && <Badge variant="outline">Recommended</Badge>}
                {p.id === d.current && <Badge>Current</Badge>}
              </span>
            </span>
            <span className="flex-1 space-y-1.5">
              <span className="flex items-start gap-2 text-sm font-medium">
                <span className="flex-1">{p.label}</span>
                {selected === p.id && <CheckCircle2 className="mt-0.5 size-4 shrink-0" />}
              </span>
              <span className="block text-xs leading-relaxed text-muted-foreground">{p.description}</span>
            </span>
            <span className="flex w-full flex-wrap gap-x-4 gap-y-1 border-t border-border pt-3 text-xs text-muted-foreground">
              <span>View <span className="font-mono text-foreground">{p.viewDistance}</span></span>
              <span>Simulation <span className="font-mono text-foreground">{p.simulationDistance}</span></span>
            </span>
          </ChoiceCard>
        ))}
      </div>
      <details className="text-xs">
        <summary className="cursor-pointer text-muted-foreground">JVM flags for {preset.label} with {(s.memoryMb / 1024).toFixed(1)} GB</summary>
        <p className="mt-2 break-words rounded-md bg-muted p-3 font-mono text-[11px] leading-relaxed">{preset.jvmFlags.join(" ")}</p>
        <p className="mt-2 text-muted-foreground">Your other JVM arguments are kept; earlier garbage collector flags are replaced.</p>
      </details>
      {canEdit && (
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => apply.mutate(selected)} loading={apply.isPending} disabled={selected === d.current}>
            Apply {preset.label}
          </Button>
          {selected === d.current && <span className="text-[13px] text-muted-foreground">This preset is active.</span>}
        </div>
      )}
    </Section>
  );
}

/** The server.properties keys the catalog files under "Performance": distances, watchdog, broadcast range, chunk saving. */
function PerformanceProperties({ server: s }: { server: ServerDetail }) {
  const q = useProperties(s.id);
  const canEdit = useCan("server.configure");
  const [edits, setEdits] = React.useState<Record<string, string>>({});
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const running = !["stopped", "crashed", "error"].includes(s.status);
  const save = useAction(
    () =>
      api.put(`/api/servers/${s.id}/properties`, { values: edits }).catch((err) => {
        if (err instanceof ApiError && err.details) setErrors(err.details);
        throw err;
      }),
    {
      success: running ? "Saved. Restart the server to apply." : "Settings saved",
      invalidate: [["properties", s.id], ["performance", s.id], ["server", s.id]],
      onSuccess: () => (setEdits({}), setErrors({})),
    },
  );
  if (!q.data) return <Skeleton className="h-64 rounded-lg" />;
  const defs = q.data.catalog.filter((d) => d.group === "performance");
  const values = { ...q.data.values, ...edits };
  const dirty = Object.keys(edits).length > 0;
  return (
    <Section title="Server settings" description="Distances, watchdog and chunk saving from server.properties. The rest of that file is under Settings.">
      <Panel className="divide-y divide-border">
        {defs.map((def) => (
          <SettingRow key={def.key} def={def} value={values[def.key] ?? def.default} present={def.key in q.data!.values} error={errors[def.key]} disabled={!canEdit || !!def.managed} onChange={(v) => setEdits((e) => ({ ...e, [def.key]: v }))} />
        ))}
      </Panel>
      {canEdit && (
        <div className="flex items-center gap-3">
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!dirty}>
            <Save /> Save settings
          </Button>
          {dirty && (
            <Button variant="ghost" onClick={() => (setEdits({}), setErrors({}))}>
              Discard
            </Button>
          )}
        </div>
      )}
    </Section>
  );
}

function MemoryAndJvm({ server: s, fit }: { server: ServerDetail; fit: HostFit }) {
  const canEdit = useCan("server.configure");
  const [memoryMb, setMemoryMb] = React.useState(s.memoryMb);
  const [jvmArgs, setJvmArgs] = React.useState(s.jvmArgs);
  // A preset or an insight fix changes these elsewhere on the page; follow it.
  React.useEffect(() => setMemoryMb(s.memoryMb), [s.memoryMb]);
  React.useEffect(() => setJvmArgs(s.jvmArgs), [s.jvmArgs]);
  const running = !["stopped", "crashed", "error"].includes(s.status);
  const save = useAction(() => api.patch(`/api/servers/${s.id}`, { memoryMb, jvmArgs }), {
    success: running ? "Saved. Restart the server to apply." : "Saved. It takes effect on the next start.",
    invalidate: [["server", s.id], ["servers"], ["performance", s.id]],
  });
  const dirty = memoryMb !== s.memoryMb || jvmArgs !== s.jvmArgs;
  const sliderMax = Math.max(s.memoryMb, Math.min(32768, Math.ceil((fit.availableMemoryMb + 1024) / 512) * 512));
  const over = memoryMb > fit.availableMemoryMb;
  return (
    <Section title="Memory & JVM" description="Allocate memory first. Edit Java arguments only when needed.">
      <Field label="Memory" htmlFor="pmem" aside={<span className="text-[13px] font-medium tabular-nums">{gb(memoryMb)}</span>}>
        <input id="pmem" type="range" min={512} max={sliderMax} step={512} value={memoryMb} onChange={(e) => setMemoryMb(Number(e.target.value))} disabled={!canEdit} className="w-full accent-[var(--foreground)]" />
        <p className={cn("text-xs", over ? "text-warning" : "text-muted-foreground")}>
          {over
            ? `This machine can spare about ${gb(fit.availableMemoryMb)} for this server; more risks swapping or the system stopping Java.`
            : `About ${gb(fit.availableMemoryMb)} can be spared here. ${gb(fit.suggestedMemoryMb)} is suggested for this setup.`}
          {canEdit && Math.abs(memoryMb - fit.suggestedMemoryMb) >= 512 && (
            <button type="button" className="ml-1.5 font-medium text-foreground underline underline-offset-2" onClick={() => setMemoryMb(fit.suggestedMemoryMb)}>
              Use {gb(fit.suggestedMemoryMb)}
            </button>
          )}
        </p>
      </Field>
      <details className="group/jvm border-t border-border pt-4" open={jvmArgs !== s.jvmArgs || undefined}>
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded text-[13px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
          JVM arguments <ChevronDown className="size-4 text-muted-foreground group-open/jvm:rotate-180" />
        </summary>
        <div className="mt-4">
          <Field label="JVM arguments" htmlFor="pjvm" help="Each argument must start with '-'. Memory flags are managed by the slider. Presets replace earlier garbage collector flags.">
            <Textarea id="pjvm" rows={4} value={jvmArgs} onChange={(e) => setJvmArgs(e.target.value)} disabled={!canEdit} className="font-mono text-xs" />
          </Field>
        </div>
      </details>
      {canEdit && (
        <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!dirty}>
          <Save /> Save changes
        </Button>
      )}
    </Section>
  );
}

type CapMode = "auto" | "custom" | "off";
const capMode = (v: number | null): CapMode => (v === null ? "auto" : v === 0 ? "off" : "custom");
const CAP_OPTIONS = [
  { value: "auto", label: "Automatic" },
  { value: "custom", label: "Custom" },
  { value: "off", label: "Off" },
] as const;
const cores = (percent: number) => `${(percent / 100).toFixed(percent % 100 === 0 ? 0 : 1)} ${percent === 100 ? "core" : "cores"}`;

/** Caps the system enforces; they apply to a running server at once. */
function ResourceLimits({ server: s }: { server: ServerDetail }) {
  const canEdit = useCan("server.configure");
  const system = useQuery({ queryKey: ["system"], queryFn: () => api.get<{ cpus: number }>("/api/system"), staleTime: 60_000 });
  const hostCores = system.data?.cpus ?? 4;
  const [memory, setMemory] = React.useState(s.limitMemoryMb);
  const [cpu, setCpu] = React.useState(s.limitCpuPercent);
  const [tasks, setTasks] = React.useState(s.limitProcesses);
  React.useEffect(() => setMemory(s.limitMemoryMb), [s.limitMemoryMb]);
  React.useEffect(() => setCpu(s.limitCpuPercent), [s.limitCpuPercent]);
  React.useEffect(() => setTasks(s.limitProcesses), [s.limitProcesses]);
  const lock = <T extends string>(options: readonly { value: T; label: string }[]) => options.map((o) => ({ ...o, disabled: !canEdit }));
  const running = !["stopped", "crashed", "error"].includes(s.status);
  const support = s.resourceLimits;
  // Windows job objects count processes; Linux cgroups count threads too.
  const processesOnly = support.controllers?.includes("processes") ?? false;
  const save = useAction(() => api.patch(`/api/servers/${s.id}`, { limitMemoryMb: memory, limitCpuPercent: cpu, limitProcesses: tasks }), {
    success: running && support.available ? "Limits applied to the running server" : "Limits saved",
    invalidate: [["server", s.id]],
  });
  const dirty = memory !== s.limitMemoryMb || cpu !== s.limitCpuPercent || tasks !== s.limitProcesses;
  const autoMemory = s.memoryMb + Math.max(1024, Math.ceil(s.memoryMb / 2));
  const minMemory = s.memoryMb + 256;
  const memoryTooLow = memory !== null && memory > 0 && memory < minMemory;
  return (
    <Section
      title={<span className="flex flex-wrap items-center gap-2">Resource limits {support.available && <Badge variant="outline"><Zap /> Applies at once</Badge>}</span>}
      description="Caps the system enforces, so one server cannot take memory, CPU or processes from the others or from the machine."
    >
      {!support.available && (
        <Callout icon={<Info />} title="Not enforced on this host">
          {(support.reason ?? "The runtime cannot apply limits here").replace(/\.?$/, ".")} Settings are kept and apply once the host supports them.
        </Callout>
      )}
      {support.available && support.reason && <Callout icon={<AlertTriangle />} variant="warning">{support.reason}</Callout>}
      <div className="grid gap-6 lg:grid-cols-3">
        <Field label="Memory cap" htmlFor="lim-mem" error={memoryTooLow ? `At least ${gb(minMemory)}: the ${gb(s.memoryMb)} heap plus room for Java itself.` : null}>
          <SegmentedControl aria-label="Memory cap" value={capMode(memory)} options={lock(CAP_OPTIONS)}
            onValueChange={(m) => setMemory(m === "auto" ? null : m === "off" ? 0 : Math.max(minMemory, s.limitMemoryMb || autoMemory))} />
          {memory !== null && memory > 0 ? (
            <div className="flex items-center gap-2">
              <Input id="lim-mem" type="number" min={minMemory} step={256} value={memory} disabled={!canEdit} onChange={(e) => setMemory(Number(e.target.value) || 0)} className="w-32 tabular-nums" />
              <span className="text-xs text-muted-foreground">MB</span>
            </div>
          ) : null}
          <p className="text-xs leading-relaxed text-muted-foreground">
            {memory === null ? `${gb(autoMemory)}: the heap plus room for Java itself. Follows the memory setting.` : memory === 0 ? "No cap. Java can take all the machine's memory." : "Above it, the server is stopped; it then shows as crashed with “Memory limit reached”."}
          </p>
        </Field>
        <Field label="CPU" htmlFor="lim-cpu" aside={cpu ? <span className="text-[13px] font-medium tabular-nums">{cores(cpu)}</span> : null}>
          <SegmentedControl aria-label="CPU limit" value={cpu ? "limit" : "none"} options={lock([{ value: "none", label: "Unlimited" }, { value: "limit", label: "Limit" }] as const)}
            onValueChange={(m) => setCpu(m === "none" ? null : Math.min(hostCores * 100, Math.max(100, Math.round(hostCores / 2) * 100)))} />
          {cpu ? <input id="lim-cpu" type="range" min={50} max={hostCores * 100} step={50} value={Math.min(cpu, hostCores * 100)} disabled={!canEdit} onChange={(e) => setCpu(Number(e.target.value))} className="w-full accent-[var(--foreground)]" /> : null}
          <p className="text-xs leading-relaxed text-muted-foreground">
            {cpu ? `At most ${cores(cpu)} of ${hostCores}. Minecraft's main thread uses one core; less than that makes it lag.` : `It may use all ${hostCores} cores when nothing else needs them.`}
          </p>
        </Field>
        <Field label={processesOnly ? "Processes" : "Processes and threads"} htmlFor="lim-tasks">
          <SegmentedControl aria-label="Process limit" value={capMode(tasks)} options={lock(CAP_OPTIONS)}
            onValueChange={(m) => setTasks(m === "auto" ? null : m === "off" ? 0 : s.limitProcesses || 4096)} />
          {tasks !== null && tasks > 0 ? <Input id="lim-tasks" type="number" min={128} step={128} value={tasks} disabled={!canEdit} onChange={(e) => setTasks(Number(e.target.value) || 0)} className="w-32 tabular-nums" /> : null}
          <p className="text-xs leading-relaxed text-muted-foreground">
            {tasks === null ? "4,096: plenty for large modpacks and still stops a plugin that spawns processes without end." : tasks === 0 ? "No limit." : processesOnly ? "Java itself is one process; this host counts processes, not threads." : "Java needs a few hundred threads; far fewer and the server fails to start."}
          </p>
        </Field>
      </div>
      {canEdit && (
        <div className="flex items-center gap-3">
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!dirty || memoryTooLow}>
            <Save /> Save limits
          </Button>
          {dirty && <Button variant="ghost" onClick={() => (setMemory(s.limitMemoryMb), setCpu(s.limitCpuPercent), setTasks(s.limitProcesses))}>Discard</Button>}
        </div>
      )}
    </Section>
  );
}

const RADII = [500, 1000, 2000, 3000, 5000];
/** Rough size on disk: about 8 KB per generated chunk in compressed region files. */
const estimate = (r: number) => {
  const chunks = Math.pow(Math.ceil((2 * r) / 16), 2);
  const mb = (chunks * 8) / 1024;
  return { chunks, size: mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB` };
};

type StepState = "done" | "current" | "todo";

/** Where pre-generation stands: install Chunky, let the server load it, then generate. */
function Steps({ steps }: { steps: { label: string; state: StepState }[] }) {
  return (
    <ol className="flex items-center gap-2 text-xs" aria-label="Steps to pre-generate the world">
      {steps.map((st, i) => (
        <React.Fragment key={st.label}>
          {i > 0 && <li aria-hidden className={cn("h-px min-w-3 flex-1", steps[i - 1].state === "done" ? "bg-foreground/50" : "bg-border")} />}
          <li className="flex items-center gap-1.5" aria-current={st.state === "current" ? "step" : undefined}>
            <span
              className={cn(
                "grid size-5 shrink-0 place-items-center rounded-full border text-[11px] font-medium tabular-nums",
                st.state === "done" && "border-foreground bg-foreground text-background",
                st.state === "current" && "border-foreground text-foreground",
                st.state === "todo" && "border-border text-muted-foreground",
              )}
            >
              {st.state === "done" ? <Check className="size-3" aria-label="done" /> : i + 1}
            </span>
            <span className={cn(st.state === "todo" ? "text-muted-foreground" : "font-medium text-foreground")}>{st.label}</span>
          </li>
        </React.Fragment>
      ))}
    </ol>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-background px-3 py-2.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-[15px] font-medium tabular-nums">{value}</p>
    </div>
  );
}

/** "40 s", "6 min" or "1.5 h": rough on purpose, the estimate is only a ballpark. */
function roughTime(seconds: number): string {
  if (seconds < 90) return `${Math.max(1, Math.round(seconds))} s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`;
  return `${(seconds / 3600).toFixed(1)} h`;
}

/** "4–13 min": the unit is said once when both ends share it, so the range fits a narrow card. */
function roughRange(from: number, to: number): string {
  const a = roughTime(from);
  const b = roughTime(to);
  const unit = (t: string) => t.slice(t.indexOf(" "));
  return unit(a) === unit(b) ? `${a.slice(0, a.indexOf(" "))}–${b}` : `${a}–${b}`;
}

function Pregeneration({ server: s }: { server: ServerDetail }) {
  const canInstall = useCan("plugins.manage");
  const canControl = useCan("console.command");
  const life = useServerLifecycle(s.id);
  const [radius, setRadius] = React.useState(1000);
  const q = useQuery({
    queryKey: ["pregen", s.id, s.status],
    queryFn: () => api.get<PregenStatus>(`/api/servers/${s.id}/pregen`),
    refetchInterval: (query) => (query.state.data?.task?.state === "running" ? 3000 : false),
  });
  const install = useAction(() => api.post(`/api/servers/${s.id}/pregen/install`), {
    success: "Chunky installed",
    invalidate: [["pregen", s.id], ["plugins", s.id], ["server", s.id]],
  });
  const control = useAction((action: "start" | "pause" | "continue" | "cancel") => api.post<PregenStatus>(`/api/servers/${s.id}/pregen`, { action, radius }), {
    onSuccess: () => setTimeout(() => void q.refetch(), 1500),
  });
  const d = q.data;
  const est = estimate(radius);
  const task = d?.task;
  const mods = SOFTWARE_INFO[s.software].addons === "mods";
  const kind = mods ? "mod" : "plugin";
  const loaded = !!d?.installed && !!d.running && !d.restartNeeded;
  const steps: { label: string; state: StepState }[] = [
    { label: "Install Chunky", state: d?.installed ? "done" : "current" },
    { label: "Load it", state: loaded ? "done" : d?.installed ? "current" : "todo" },
    { label: "Generate", state: loaded ? "current" : "todo" },
  ];
  return (
    <Section title="Pre-generate the world" description="Generate terrain around spawn ahead of time, so exploring players don't cause lag spikes. Takes a while; the server stays playable.">
      {!d ? (
        <Skeleton className="h-40 rounded-lg" />
      ) : !d.supported ? (
        <Callout icon={<Info />} title={`${SOFTWARE_INFO[s.software].label} can't pre-generate`}>
          Pre-generation uses Chunky, which needs Paper, Purpur, Fabric or NeoForge. You can switch in Settings → Software &amp; version; your world is kept.
        </Callout>
      ) : (
        <div className="space-y-5">
          <Steps steps={steps} />
          {!d.installed ? (
            <div className="space-y-4">
              <div className="flex items-start gap-3">
                <span className="grid size-10 shrink-0 place-items-center rounded-lg border border-border bg-background text-muted-foreground">
                  <MapIcon className="size-5" />
                </span>
                <div className="min-w-0 space-y-1 text-[13px]">
                  <p className="flex flex-wrap items-center gap-2 font-medium">
                    Chunky <Badge>{kind}</Badge>
                    <span className="text-xs font-normal text-muted-foreground">from Modrinth</span>
                  </p>
                  <p className="text-muted-foreground">A widely used pre-generator{s.software === "fabric" ? ", installed together with Fabric API" : ""}. CraftPanel installs it for you.</p>
                </div>
              </div>
              <ul className="space-y-1.5 text-[13px] text-muted-foreground">
                {["Terrain around spawn is ready before players arrive", "Pause, resume or cancel at any time", `Remove it later in the ${mods ? "Mods" : "Plugins"} tab`].map((line) => (
                  <li key={line} className="flex items-start gap-2">
                    <Check className="mt-0.5 size-3.5 shrink-0 text-foreground" aria-hidden /> {line}
                  </li>
                ))}
              </ul>
              {canInstall ? (
                <Button onClick={() => install.mutate()} loading={install.isPending} className="w-full sm:w-auto">
                  <Download /> Install Chunky
                </Button>
              ) : (
                <p className="text-xs text-muted-foreground">Installing needs the permission to manage {mods ? "mods" : "plugins"}.</p>
              )}
            </div>
          ) : !d.running ? (
            <div className="space-y-3 text-[13px]">
              <p className="text-muted-foreground">Chunky is installed. It loads when the server starts, then you can pick how far to generate.</p>
              {canControl && s.status === "stopped" && (
                <Button variant="secondary" onClick={() => life.start.mutate()} loading={life.start.isPending}>
                  <Play /> Start the server
                </Button>
              )}
            </div>
          ) : d.restartNeeded ? (
            <Callout variant="warning" icon={<RotateCw />} title="Restart to load Chunky">
              <div className="mt-2">
                <Button size="sm" variant="secondary" onClick={() => life.restart.mutate()} loading={life.restart.isPending}>
                  <RotateCw /> Restart server
                </Button>
              </div>
            </Callout>
          ) : task && (task.state === "running" || task.state === "paused") ? (
            <div className="space-y-4 text-[13px]">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="text-2xl font-medium tabular-nums">{task.percent.toFixed(1)}%</span>
                <span className="text-muted-foreground">
                  {task.state === "running" ? "Generating" : "Paused"} · {task.world}
                </span>
              </div>
              <Progress value={task.percent} />
              <div className="grid grid-cols-3 gap-2">
                <Stat label="Chunks" value={formatNumber(task.chunks)} />
                <Stat label="Speed" value={task.rate !== null ? `${task.rate}/s` : "—"} />
                <Stat label="Left" value={task.eta ? `about ${task.eta}` : "—"} />
              </div>
              {canControl && (
                <div className="flex gap-2">
                  {task.state === "running" ? (
                    <Button size="sm" variant="secondary" onClick={() => control.mutate("pause")} loading={control.isPending}>
                      <Pause /> Pause
                    </Button>
                  ) : (
                    <Button size="sm" onClick={() => control.mutate("continue")} loading={control.isPending}>
                      <Play /> Continue
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => control.mutate("cancel")} disabled={control.isPending}>
                    <Square /> Cancel
                  </Button>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              {task?.state === "finished" && (
                <p className="flex items-center gap-2 text-[13px]">
                  <Badge variant="success">Done</Badge> {formatNumber(task.chunks)} chunks generated in {task.world}.
                </p>
              )}
              <div className="space-y-2">
                <p className="text-[13px] font-medium">How far from spawn?</p>
                <div className="-mx-1 overflow-x-auto px-1 pb-1">
                  <SegmentedControl aria-label="Radius around spawn in blocks" value={radius} onValueChange={setRadius} options={RADII.map((r) => ({ value: r, label: formatNumber(r), disabled: !canControl }))} />
                </div>
                <p className="text-xs text-muted-foreground">Blocks in every direction from the world spawn.</p>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <Stat label="Chunks" value={formatNumber(est.chunks)} />
                <Stat label="On disk" value={est.size} />
                <Stat label="Raspberry Pi" value={roughRange(est.chunks / 60, est.chunks / 20)} />
              </div>
              <p className="text-xs text-muted-foreground">A Raspberry Pi manages roughly 20–60 chunks per second; a PC is usually faster.</p>
              {canControl && (
                <Button onClick={() => control.mutate("start")} loading={control.isPending} className="w-full sm:w-auto">
                  <Play /> Start pre-generation
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </Section>
  );
}
