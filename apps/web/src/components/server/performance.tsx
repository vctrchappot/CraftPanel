"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Cpu, Gauge, Info, Map as MapIcon, Pause, Play, RotateCw, Save, Square, Zap } from "lucide-react";
import { Badge, Button, Callout, Field, NativeSelect, Panel, Progress, Section, SegmentedControl, Skeleton, Stat, Textarea, cn } from "@craftpanel/ui";
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
import { Choice } from "../wizard";
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
const ms = (v: number) => (v < 10 ? v.toFixed(1) : v.toFixed(0));
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
  const mem = summarize(windowed, (m) => m.memoryBytes);
  const players = summarize(windowed, (m) => m.playersOnline);
  const heap = s.memoryMb * 1024 * 1024;
  const pts = (pick: (m: ServerMetrics) => number | null) => samples.map((m) => ({ ts: m.ts, v: pick(m) }));
  const empty = running ? "Collecting data…" : "Start the server to collect data";
  const unavailable = <Unavailable reason={running ? "Waiting for the next sample" : "Server is not running"} />;
  const live = running ? stream.metrics : null;
  const avgLow = (x: typeof tps, f: (v: number) => string) => (x.avg === null ? undefined : `avg ${f(x.avg)} · low ${f(x.min!)}`);
  const avgPeak = (x: typeof tps, f: (v: number) => string) => (x.avg === null ? undefined : `avg ${f(x.avg)} · peak ${f(x.max!)}`);

  return (
    <div className="space-y-10">
      <Section title="Insights" description={proxy ? "What the live numbers and settings say about this proxy." : "What the live numbers and the settings say, with a fix where there is one."}>
        {insights ? <InsightList server={s} insights={insights} /> : <Skeleton className="h-24 rounded-lg" />}
      </Section>

      <Section
        title="Live"
        description={!running && samples.length ? "The server isn't running; this is its last run." : "Sampled every few seconds while a dashboard is open, kept for about an hour."}
        actions={
          <SegmentedControl aria-label="Time range" value={range} onValueChange={setRange} options={RANGES.map(([label, minutes]) => ({ value: minutes, label }))} />
        }
      >
        <Panel className={cn("grid grid-cols-2 gap-px overflow-hidden bg-border [&>*]:bg-surface", proxy ? "sm:grid-cols-3" : "sm:grid-cols-3 lg:grid-cols-5")}>
          {!proxy && (
            <>
              <div className="p-5">
                <Stat label="TPS" value={live?.tps != null ? live.tps.toFixed(1) : unavailable} sub={avgLow(tps, (v) => v.toFixed(1)) ?? "20 is the target"} />
              </div>
              <div className="p-5">
                <Stat label="Tick time" value={live?.mspt != null ? `${ms(live.mspt)} ms` : unavailable} sub={avgPeak(mspt, ms) ?? "50 ms is the budget"} />
              </div>
            </>
          )}
          <div className="p-5">
            <Stat label="CPU" value={live?.cpuPercent != null ? `${live.cpuPercent.toFixed(0)}%` : unavailable} sub={avgPeak(cpu, (v) => `${v.toFixed(0)}%`) ?? "100% = one core"} />
          </div>
          <div className="p-5">
            <Stat label="Memory" value={live?.memoryBytes != null ? formatBytes(live.memoryBytes) : unavailable} sub={mem.max === null ? `of ${gb(s.memoryMb)} heap` : `peak ${formatBytes(mem.max)} of ${gb(s.memoryMb)} heap`} />
          </div>
          <div className="p-5">
            <Stat label="Players" value={live ? `${live.playersOnline} / ${s.maxPlayers}` : unavailable} sub={players.max === null ? undefined : `peak ${players.max}`} />
          </div>
        </Panel>

        <div className="grid gap-4 md:grid-cols-2">
          {!proxy && <MetricChart title="TPS" points={pts((m) => m.tps)} from={from} to={to} max={20} format={(v) => v.toFixed(1)} empty={empty} />}
          {!proxy && (
            <MetricChart
              title="Tick time"
              points={pts((m) => m.mspt)}
              from={from}
              to={to}
              max={Math.max(60, Math.ceil((mspt.max ?? 0) / 10) * 10)}
              reference={{ value: 50, label: "50 ms budget" }}
              format={(v) => `${ms(v)} ms`}
              empty={empty}
            />
          )}
          <MetricChart
            title="CPU"
            points={pts((m) => m.cpuPercent)}
            from={from}
            to={to}
            max={Math.max(100, Math.ceil((cpu.max ?? 0) / 50) * 50)}
            reference={{ value: 100, label: "one core" }}
            format={(v) => `${v.toFixed(0)}%`}
            empty={empty}
          />
          <MetricChart title="Memory" points={pts((m) => m.memoryBytes)} from={from} to={to} max={Math.max(heap, mem.max ?? 0)} reference={{ value: heap, label: "heap" }} format={(v) => formatBytes(v)} empty={empty} />
          {!proxy && <MetricChart title="Players" points={pts((m) => m.playersOnline)} from={from} to={to} max={Math.max(4, players.max ?? 0)} format={(v) => v.toFixed(0)} empty={empty} />}
        </div>
      </Section>

      <Section title="Tuning" description="Changes apply on the next start.">
        {proxy ? (
          <div className="max-w-2xl">{d && <MemoryAndJvm server={s} fit={d.fit} />}</div>
        ) : (
          <div className="grid items-start gap-10 lg:grid-cols-2">
            <div className="space-y-10">
              <Presets server={s} info={d} />
              <div id="pregen" className="scroll-mt-6">
                <Pregeneration server={s} />
              </div>
            </div>
            <div className="space-y-10">
              {d && <MemoryAndJvm server={s} fit={d.fit} />}
              <PerformanceProperties server={s} />
            </div>
          </div>
        )}
      </Section>
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
        <div key={i.id} className="flex items-start gap-3 p-4">
          <span className={cn("mt-0.5 shrink-0 [&_svg]:size-4", LEVEL[i.level].className)}>{LEVEL[i.level].icon}</span>
          <div className="min-w-0 flex-1 space-y-0.5">
            <p className="text-[13px] font-medium">{i.title}</p>
            <p className="text-xs text-muted-foreground">{i.detail}</p>
          </div>
          {i.fix && (i.fix.kind === "pregen" || canEdit) && (
            <Button
              size="sm"
              variant="secondary"
              className="shrink-0"
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
      <div className="grid gap-3">
        {d.presets.map((p) => (
          <Choice
            key={p.id}
            selected={selected === p.id}
            disabled={!canEdit}
            title={p.label}
            badge={p.id === d.current ? "Current" : p.id === d.recommended ? "Recommended for this machine" : undefined}
            description={p.description}
            icon={ICONS[p.id]}
            onClick={() => setChosen(p.id)}
          />
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
    <Section title="Memory & JVM">
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
      <Field label="JVM arguments" htmlFor="pjvm" help="Each argument must start with '-'. Memory flags are managed by the slider. Presets replace earlier garbage collector flags.">
        <Textarea id="pjvm" rows={4} value={jvmArgs} onChange={(e) => setJvmArgs(e.target.value)} disabled={!canEdit} className="font-mono text-xs" />
      </Field>
      {canEdit && (
        <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!dirty}>
          <Save /> Save changes
        </Button>
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
  return (
    <Section title="Pre-generate the world" description="Generate terrain around spawn ahead of time, so exploring players don't cause lag spikes. Takes a while; the server stays playable.">
      {!d ? (
        <Skeleton className="h-28 rounded-lg" />
      ) : !d.supported ? (
        <Callout icon={<Info />} title={`${SOFTWARE_INFO[s.software].label} can't pre-generate`}>
          Pre-generation uses Chunky, which needs Paper, Purpur, Fabric or NeoForge. You can switch in Settings → Software &amp; version; your world is kept.
        </Callout>
      ) : !d.installed ? (
        <Panel className="flex flex-wrap items-center justify-between gap-4 p-5">
          <div className="min-w-0 flex-1 text-[13px]">
            <p className="font-medium">Chunky {SOFTWARE_INFO[s.software].addons === "mods" ? "mod" : "plugin"}</p>
            <p className="text-muted-foreground">A widely used pre-generator from Modrinth{s.software === "fabric" ? " (with Fabric API)" : ""}. It can be removed in the {SOFTWARE_INFO[s.software].addons === "mods" ? "Mods" : "Plugins"} tab later.</p>
          </div>
          {canInstall && (
            <Button onClick={() => install.mutate()} loading={install.isPending}>
              Install Chunky
            </Button>
          )}
        </Panel>
      ) : !d.running ? (
        <Callout icon={<Info />}>Chunky is installed. Start the server to pre-generate.</Callout>
      ) : d.restartNeeded ? (
        <Callout variant="warning" icon={<RotateCw />} title="Restart to load Chunky">
          <div className="mt-2">
            <Button size="sm" variant="secondary" onClick={() => life.restart.mutate()} loading={life.restart.isPending}>
              <RotateCw /> Restart server
            </Button>
          </div>
        </Callout>
      ) : (
        <Panel className="space-y-4 p-5">
          {task && (task.state === "running" || task.state === "paused") ? (
            <div className="space-y-2 text-[13px]">
              <div className="flex flex-wrap items-center gap-2">
                <MapIcon className="size-4 text-muted-foreground" />
                <span className="font-medium">
                  {task.state === "running" ? "Generating" : "Paused"} · {task.world}
                </span>
                <span className="ml-auto tabular-nums">{task.percent.toFixed(1)}%</span>
              </div>
              <Progress value={task.percent} />
              <p className="text-xs text-muted-foreground tabular-nums">
                {formatNumber(task.chunks)} chunks{task.rate !== null && <> · {task.rate} chunks/s</>}
                {task.eta && <> · about {task.eta} left</>}
              </p>
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
            <>
              {task?.state === "finished" && (
                <p className="flex items-center gap-2 text-[13px]">
                  <Badge variant="success">Done</Badge> {formatNumber(task.chunks)} chunks generated in {task.world}.
                </p>
              )}
              <Field label="Radius around spawn" htmlFor="pgr" help={`About ${formatNumber(est.chunks)} chunks and ${est.size} on disk. A Raspberry Pi manages roughly 20–60 chunks per second.`}>
                <NativeSelect id="pgr" value={radius} onChange={(e) => setRadius(Number(e.target.value))} className="max-w-xs" disabled={!canControl}>
                  {RADII.map((r) => (
                    <option key={r} value={r}>
                      {formatNumber(r)} blocks
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              {canControl && (
                <Button onClick={() => control.mutate("start")} loading={control.isPending}>
                  <Play /> Start pre-generation
                </Button>
              )}
            </>
          )}
        </Panel>
      )}
    </Section>
  );
}
