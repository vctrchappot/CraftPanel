"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, Info, RefreshCw } from "lucide-react";
import { Badge, Button, Callout, Dialog, DialogContent, DialogFooter, DialogHeader, Field, NativeSelect, Panel, Section, Skeleton, Switch } from "@craftpanel/ui";
import { buildFieldLabel, buildName, SOFTWARE_INFO, softwareLabel, type ServerDetail, type ServerSoftware } from "@craftpanel/shared";
import { api, errorMessage } from "@/lib/api";
import { useCan } from "@/lib/auth";
import { useAction } from "@/lib/queries";
import { Choice, SOFTWARE_CHOICES, type VersionInfo, type VersionOption } from "../wizard";

interface SwitchPreview {
  downgrade: boolean;
  javaMajor: number;
  notes: { level: "info" | "warn" | "danger"; text: string }[];
}

/** Change software (any direction), Minecraft version or build, like the version changer of hosting panels. */
export function SoftwareSettings({ server: s }: { server: ServerDetail }) {
  const canEdit = useCan("server.configure");
  const [software, setSoftware] = React.useState<ServerSoftware>(s.software);
  const [version, setVersion] = React.useState(s.mcVersion);
  const [build, setBuild] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const [confirmDowngrade, setConfirmDowngrade] = React.useState(false);

  const versions = useQuery({ queryKey: ["catalog", software, "versions"], queryFn: () => api.get<VersionOption[]>(`/api/catalog/${software}/versions`), staleTime: 600_000 });
  const available = versions.data?.some((v) => v.id === version);
  const info = useQuery({ queryKey: ["catalog", software, "version", version], queryFn: () => api.get<VersionInfo>(`/api/catalog/${software}/versions/${version}`), enabled: !!available, staleTime: 300_000 });
  const preview = useQuery({
    queryKey: ["software-preview", s.id, software, version],
    queryFn: () => api.get<SwitchPreview>(`/api/servers/${s.id}/software/preview?software=${software}&version=${encodeURIComponent(version)}`),
    enabled: open && !!available,
  });

  const latestBuild = info.data?.builds.find((b) => b.channel === "STABLE")?.id ?? info.data?.builds[0]?.id;
  const sameTarget = software === s.software && version === s.mcVersion;
  const buildLabel = SOFTWARE_INFO[software].buildLabel;
  const chosenBuild = build || latestBuild || null;
  const unchanged = sameTarget && (!buildLabel || chosenBuild === s.build);
  const newerBuild = s.software === software && s.mcVersion === version && buildLabel && latestBuild && s.build && latestBuild !== s.build && !build;
  const running = !["stopped", "crashed", "error"].includes(s.status);

  const apply = useAction(() => api.post(`/api/servers/${s.id}/software`, { software, version, build: build || null, allowDowngrade: confirmDowngrade }), {
    success: () => `${sameTarget ? "Updated" : "Switched"} to ${softwareLabel(software)} ${version}. A backup was created first.`,
    invalidate: [["server", s.id], ["servers"], ["plugins", s.id], ["backups"], ["worlds", s.id]],
    onSuccess: () => setOpen(false),
  });

  const pick = (sw: ServerSoftware) => {
    setSoftware(sw);
    setBuild("");
  };

  return (
    <div className="max-w-2xl space-y-6">
      <Panel className="flex flex-wrap items-center gap-3 p-5">
        <div className="min-w-0 flex-1">
          <p className="text-[13px] text-muted-foreground">Currently running</p>
          <p className="text-sm font-medium">
            {softwareLabel(s.software)} {s.mcVersion}
            {s.build && <span className="text-muted-foreground"> · {SOFTWARE_INFO[s.software].buildLabel} {buildName(s.software, s.build)}</span>}
          </p>
        </div>
        {newerBuild && (
          <Badge variant="warning">
            {SOFTWARE_INFO[s.software].buildLabel} {buildName(s.software, latestBuild)} available
          </Badge>
        )}
      </Panel>

      {!SOFTWARE_INFO[s.software].proxy && (
        <Section title="Server software" description="Switch in any direction. Worlds, settings and player lists are kept; CraftPanel backs up the server first.">
          <div className="grid gap-3 sm:grid-cols-2">
            {SOFTWARE_CHOICES.map((c) => (
              <Choice key={c.id} selected={software === c.id} disabled={!canEdit} title={softwareLabel(c.id)} badge={c.id === s.software ? "Current" : undefined} description={c.description} icon={c.icon} onClick={() => pick(c.id)} />
            ))}
          </div>
        </Section>
      )}

      <Section title="Version">
        <Field
          label={SOFTWARE_INFO[s.software].proxy ? "Velocity version" : "Minecraft version"}
          htmlFor="swver"
          help={SOFTWARE_INFO[s.software].proxy ? "Velocity works with every Minecraft version the servers behind it run." : "Players must use the same version to join."}
        >
          {versions.isLoading ? (
            <Skeleton className="h-9" />
          ) : versions.error ? (
            <Callout variant="danger" icon={<AlertTriangle />} title="Could not load versions">
              {errorMessage(versions.error)}
            </Callout>
          ) : (
            <NativeSelect id="swver" value={available ? version : ""} onChange={(e) => (setVersion(e.target.value), setBuild(""))} disabled={!canEdit}>
              {!available && <option value="">Choose a version ({softwareLabel(software)} has no {version})</option>}
              {versions.data?.map((v, i) => (
                <option key={v.id} value={v.id}>
                  {v.id}
                  {i === 0 ? " (latest)" : ""}
                  {v.id === s.mcVersion ? " (current)" : ""}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
        {buildLabel && available && (
          <Field label={buildFieldLabel(software)} htmlFor="swbuild">
            <NativeSelect id="swbuild" value={build} onChange={(e) => setBuild(e.target.value)} disabled={!canEdit || !info.data}>
              <option value="">Latest stable{latestBuild ? ` (${buildName(software, latestBuild)})` : ""}</option>
              {info.data?.builds.map((b) => (
                <option key={b.id} value={b.id}>
                  {buildName(software, b.id)} · {b.channel.toLowerCase()}
                  {b.time ? ` · ${new Date(b.time).toLocaleDateString()}` : ""}
                  {b.id === s.build && s.software === software && s.mcVersion === version ? " (current)" : ""}
                </option>
              ))}
            </NativeSelect>
          </Field>
        )}
      </Section>

      {canEdit && (
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => (setConfirmDowngrade(false), setOpen(true))} disabled={!available || unchanged}>
            {sameTarget ? <RefreshCw /> : <ArrowRight />} {sameTarget ? `Update to ${buildLabel?.toLowerCase()} ${buildName(software, chosenBuild ?? "")}` : `Switch to ${softwareLabel(software)} ${version}`}
          </Button>
          {unchanged && <span className="text-[13px] text-muted-foreground">This is what the server runs now.</span>}
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader
            title={sameTarget ? `Update ${softwareLabel(software)} ${version}` : `${softwareLabel(s.software)} ${s.mcVersion} → ${softwareLabel(software)} ${version}`}
            description="Review what happens before you continue."
          />
          {preview.isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-12" />
              <Skeleton className="h-12" />
            </div>
          ) : preview.error ? (
            <Callout variant="danger" icon={<AlertTriangle />}>
              {errorMessage(preview.error)}
            </Callout>
          ) : (
            <div className="space-y-2">
              {preview.data?.notes.map((n, i) => (
                <Callout key={i} variant={n.level === "danger" ? "danger" : n.level === "warn" ? "warning" : "info"} icon={n.level === "info" ? <Info /> : <AlertTriangle />}>
                  {n.text}
                </Callout>
              ))}
              {preview.data?.downgrade && (
                <label className="flex items-center gap-3 rounded-lg border border-destructive/30 px-4 py-3 text-[13px]">
                  <Switch checked={confirmDowngrade} onCheckedChange={setConfirmDowngrade} aria-label="Confirm downgrade" />I understand that the world may break and I have a backup.
                </label>
              )}
            </div>
          )}
          {running && (
            <Callout variant="warning" icon={<AlertTriangle />}>
              Stop the server first.
            </Callout>
          )}
          <DialogFooter>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button disabled={running || !preview.data || (preview.data.downgrade && !confirmDowngrade)} loading={apply.isPending} onClick={() => apply.mutate()}>
              Back up & {sameTarget ? "update" : "switch"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
