"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Cpu, Gauge, Info, Map as MapIcon, Pause, Play, RotateCw, Square, Zap } from "lucide-react";
import { Badge, Button, Callout, Field, NativeSelect, Panel, Progress, Section, Skeleton } from "@craftpanel/ui";
import { SOFTWARE_INFO, type HostFit, type PerformancePreset, type ServerDetail } from "@craftpanel/shared";
import { api } from "@/lib/api";
import { useCan } from "@/lib/auth";
import { useAction, useServerLifecycle } from "@/lib/queries";
import { Choice } from "../wizard";
import { HostFitCard } from "../host-fit";

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

export function PerformanceSettings({ server: s }: { server: ServerDetail }) {
  return (
    <div className="max-w-2xl space-y-8">
      <Presets server={s} />
      <Pregeneration server={s} />
    </div>
  );
}

function Presets({ server: s }: { server: ServerDetail }) {
  const canEdit = useCan("server.configure");
  const q = useQuery({ queryKey: ["performance", s.id, s.memoryMb, s.jvmArgs], queryFn: () => api.get<PerformanceInfo>(`/api/servers/${s.id}/performance`) });
  const [chosen, setChosen] = React.useState<PerformancePreset | null>(null);
  const running = !["stopped", "crashed", "error"].includes(s.status);
  const apply = useAction((preset: PerformancePreset) => api.post(`/api/servers/${s.id}/performance`, { preset }), {
    success: running ? "Preset applied. Restart the server to use it." : "Preset applied. It takes effect on the next start.",
    invalidate: [["server", s.id], ["servers"], ["performance", s.id], ["properties", s.id]],
    onSuccess: () => setChosen(null),
  });
  if (!q.data) return <Skeleton className="h-64 rounded-xl" />;
  const d = q.data;
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
      <HostFitCard fit={d.fit} />
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
        <Skeleton className="h-28 rounded-xl" />
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
                {task.chunks.toLocaleString()} chunks{task.rate !== null && <> · {task.rate} chunks/s</>}
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
                  <Badge variant="success">Done</Badge> {task.chunks.toLocaleString()} chunks generated in {task.world}.
                </p>
              )}
              <Field label="Radius around spawn" htmlFor="pgr" help={`About ${est.chunks.toLocaleString()} chunks and ${est.size} on disk. A Raspberry Pi manages roughly 20–60 chunks per second.`}>
                <NativeSelect id="pgr" value={radius} onChange={(e) => setRadius(Number(e.target.value))} className="max-w-xs" disabled={!canControl}>
                  {RADII.map((r) => (
                    <option key={r} value={r}>
                      {r.toLocaleString()} blocks
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
