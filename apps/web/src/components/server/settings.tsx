"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Download, RotateCw, Save, Search, ShieldCheck, Upload } from "lucide-react";
import { toast } from "sonner";
import { Badge, Button, Callout, ConfirmDialog, Field, Input, NativeSelect, Panel, Section, Skeleton, Switch, Tabs, TabsContent, TabsList, TabsTrigger, Textarea, cn } from "@craftpanel/ui";
import { SOFTWARE_INFO, type GameRuleInfo, type ServerDetail } from "@craftpanel/shared";
import { api, ApiError, downloadUrl, errorMessage } from "@/lib/api";
import { useCan } from "@/lib/auth";
import { useAction } from "@/lib/queries";
import { ToggleRow } from "../wizard";
import { SoftwareSettings } from "./software";
import { PerformanceSettings } from "./performance";

interface SettingDef {
  key: string;
  label: string;
  group: string;
  type: { kind: "boolean" } | { kind: "integer"; min?: number; max?: number } | { kind: "string"; maxLength?: number } | { kind: "enum"; options: { value: string; label: string }[] };
  default: string;
  help: string;
  restart: boolean;
  managed?: boolean;
  sensitive?: boolean;
}

export function SettingsTab({ server: s }: { server: ServerDetail }) {
  return (
    <Tabs defaultValue="properties" className="space-y-6">
      <TabsList>
        <TabsTrigger value="properties">Server properties</TabsTrigger>
        <TabsTrigger value="gamerules">Game rules</TabsTrigger>
        <TabsTrigger value="runtime">Runtime</TabsTrigger>
        <TabsTrigger value="software">Software & version</TabsTrigger>
        <TabsTrigger value="performance">Performance</TabsTrigger>
        <TabsTrigger value="raw">Raw file</TabsTrigger>
        <TabsTrigger value="danger">Danger zone</TabsTrigger>
      </TabsList>
      <TabsContent value="properties">
        <PropertiesEditor server={s} />
      </TabsContent>
      <TabsContent value="gamerules">
        <GameRules server={s} />
      </TabsContent>
      <TabsContent value="runtime">
        <RuntimeSettings server={s} />
      </TabsContent>
      <TabsContent value="software">
        <SoftwareSettings server={s} />
      </TabsContent>
      <TabsContent value="performance">
        <PerformanceSettings server={s} />
      </TabsContent>
      <TabsContent value="raw">
        <RawEditor server={s} />
      </TabsContent>
      <TabsContent value="danger">
        <DangerZone server={s} />
      </TabsContent>
    </Tabs>
  );
}

function useProperties(id: string) {
  return useQuery({ queryKey: ["properties", id], queryFn: () => api.get<{ raw: string; values: Record<string, string>; catalog: SettingDef[]; restartRequired: boolean; running: boolean }>(`/api/servers/${id}/properties`) });
}

function PropertiesEditor({ server: s }: { server: ServerDetail }) {
  const q = useProperties(s.id);
  const catalog = useQuery({ queryKey: ["catalog-settings"], queryFn: () => api.get<{ groups: { id: string; label: string; description: string }[] }>("/api/catalog/settings"), staleTime: Infinity });
  const canEdit = useCan("server.configure");
  const [edits, setEdits] = React.useState<Record<string, string>>({});
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [filter, setFilter] = React.useState("");
  const [group, setGroup] = React.useState("general");
  const [saving, setSaving] = React.useState(false);

  if (!q.data || !catalog.data) return <Skeleton className="h-96 rounded-xl" />;
  const values = { ...q.data.values, ...edits };
  const dirty = Object.keys(edits).length > 0;
  const fl = filter.toLowerCase();
  const visible = q.data.catalog.filter((d) => (fl ? d.label.toLowerCase().includes(fl) || d.key.includes(fl) || d.help.toLowerCase().includes(fl) : d.group === group));
  const unknownKeys = Object.keys(q.data.values).filter((k) => !q.data!.catalog.some((d) => d.key === k));

  const save = async () => {
    setSaving(true);
    setErrors({});
    try {
      await api.put(`/api/servers/${s.id}/properties`, { values: edits });
      toast.success(s.status === "running" ? "Saved. Restart the server to apply." : "Settings saved");
      setEdits({});
      await q.refetch();
    } catch (err) {
      if (err instanceof ApiError && err.details) setErrors(err.details);
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid gap-8 lg:grid-cols-[180px_1fr]">
      <div className="space-y-3">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search…" className="h-8 pl-8 text-[13px]" aria-label="Search settings" />
        </div>
        <nav className="flex gap-1 overflow-x-auto lg:flex-col">
          {catalog.data.groups.map((g) => (
            <button
              key={g.id}
              onClick={() => (setGroup(g.id), setFilter(""))}
              className={cn("whitespace-nowrap rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors", !filter && group === g.id ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground")}
            >
              {g.label}
            </button>
          ))}
        </nav>
      </div>
      <div className="space-y-6">
        {!filter && <p className="text-[13px] text-muted-foreground">{catalog.data.groups.find((g) => g.id === group)?.description}</p>}
        <Panel className="divide-y divide-border">
          {visible.map((d) => (
            <SettingRow key={d.key} def={d} value={values[d.key] ?? d.default} present={d.key in q.data!.values} error={errors[d.key]} disabled={!canEdit || !!d.managed} onChange={(v) => setEdits((e) => ({ ...e, [d.key]: v }))} />
          ))}
          {visible.length === 0 && <p className="p-4 text-[13px] text-muted-foreground">No matching settings.</p>}
        </Panel>
        {!filter && group === "advanced" && unknownKeys.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Other keys in this file ({unknownKeys.join(", ")}) are preserved and can be edited in the Raw file tab.
          </p>
        )}
        {canEdit && (
          <div className={cn("sticky bottom-4 flex items-center justify-between gap-4 rounded-xl border border-border bg-surface px-4 py-3 shadow-lg transition-opacity", dirty ? "opacity-100" : "pointer-events-none opacity-0")}>
            <p className="text-[13px]">
              {Object.keys(edits).length} unsaved change{Object.keys(edits).length === 1 ? "" : "s"}
              {s.status === "running" && <span className="text-muted-foreground"> · applies after restart</span>}
            </p>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={() => (setEdits({}), setErrors({}))}>
                Discard
              </Button>
              <Button size="sm" onClick={save} loading={saving}>
                <Save /> Save
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function SettingRow({ def, value, present, error, disabled, onChange }: { def: SettingDef; value: string; present: boolean; error?: string; disabled: boolean; onChange: (v: string) => void }) {
  const id = `prop-${def.key}`;
  const t = def.type;
  return (
    <div className="grid gap-3 px-4 py-4 sm:grid-cols-[1fr_240px] sm:items-center">
      <div className="space-y-0.5">
        <label htmlFor={id} className="flex flex-wrap items-center gap-2 text-[13px] font-medium">
          {def.label}
          <code className="font-mono text-[11px] font-normal text-muted-foreground">{def.key}</code>
          {def.restart && <Badge className="text-[10px]">restart</Badge>}
          {def.managed && <Badge className="text-[10px]">managed</Badge>}
          {!present && <span className="text-[11px] font-normal text-muted-foreground">(default)</span>}
        </label>
        <p className={cn("text-xs", error ? "text-destructive" : "text-muted-foreground")}>{error ?? def.help}</p>
      </div>
      <div className="sm:justify-self-end sm:w-full">
        {t.kind === "boolean" ? (
          <div className="flex sm:justify-end">
            <Switch id={id} checked={value === "true"} onCheckedChange={(v) => onChange(String(v))} disabled={disabled} />
          </div>
        ) : t.kind === "enum" ? (
          <NativeSelect id={id} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
            {!t.options.some((o) => o.value === value) && <option value={value}>{value}</option>}
            {t.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </NativeSelect>
        ) : (
          <Input
            id={id}
            type={t.kind === "integer" ? "number" : def.sensitive ? "password" : "text"}
            min={t.kind === "integer" ? t.min : undefined}
            max={t.kind === "integer" ? t.max : undefined}
            maxLength={t.kind === "string" ? t.maxLength : undefined}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            disabled={disabled}
            aria-invalid={!!error}
          />
        )}
      </div>
    </div>
  );
}

function GameRules({ server: s }: { server: ServerDetail }) {
  const running = s.status === "running";
  const q = useQuery({ queryKey: ["gamerules", s.id, running], queryFn: () => api.get<{ rules: GameRuleInfo[]; live: boolean }>(`/api/servers/${s.id}/gamerules`), enabled: s.installState === "installed", staleTime: 30_000 });
  const canEdit = useCan("server.configure");
  const [filter, setFilter] = React.useState("");
  const set = useAction((v: { name: string; value: string }) => api.put(`/api/servers/${s.id}/gamerules`, v), { success: (_) => "Game rule updated", invalidate: [["gamerules", s.id]] });

  if (q.isLoading)
    return (
      <div className="space-y-3">
        <p className="text-[13px] text-muted-foreground">Detecting the game rules available in Minecraft {s.mcVersion}… The first time this runs Mojang&apos;s data generator, which can take up to a minute.</p>
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );
  if (q.error) return <Callout variant="danger" icon={<AlertTriangle />}>{errorMessage(q.error)}</Callout>;
  const rules = q.data!.rules.filter((r) => r.name.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="space-y-4">
      {!q.data!.live && <Callout title="Start the server to view and change game rules">Game rules are stored inside the world and changed with the /gamerule command on a running server. The list below shows which rules exist in Minecraft {s.mcVersion}.</Callout>}
      <div className="flex items-center gap-3">
        <div className="relative max-w-xs flex-1">
          <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={`Filter ${q.data!.rules.length} rules…`} className="h-8 pl-8 text-[13px]" />
        </div>
        <Button variant="ghost" size="sm" onClick={() => q.refetch()} loading={q.isFetching}>
          <RotateCw /> Refresh
        </Button>
      </div>
      <Panel className="divide-y divide-border">
        {rules.map((r) => (
          <GameRuleRow key={r.name} rule={r} disabled={!q.data!.live || !canEdit} onSave={(value) => set.mutateAsync({ name: r.name, value })} />
        ))}
      </Panel>
      <p className="text-xs text-muted-foreground">Detected from Mojang&apos;s command reports for this exact version. Rules shown without a value could not be queried (for example experimental rules).</p>
    </div>
  );
}

function GameRuleRow({ rule, disabled, onSave }: { rule: GameRuleInfo; disabled: boolean; onSave: (v: string) => Promise<unknown> }) {
  const [value, setValue] = React.useState(rule.value ?? "");
  React.useEffect(() => setValue(rule.value ?? ""), [rule.value]);
  return (
    <div className="flex items-center gap-4 px-4 py-2.5">
      <code className="min-w-0 flex-1 truncate font-mono text-[12px]">{rule.name}</code>
      {rule.type === "boolean" ? (
        <Switch checked={value === "true"} disabled={disabled || rule.value === null} onCheckedChange={(v) => (setValue(String(v)), onSave(String(v)).catch(() => setValue(rule.value ?? "")))} aria-label={rule.name} />
      ) : (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void onSave(value);
          }}
        >
          <Input type="number" value={value} onChange={(e) => setValue(e.target.value)} disabled={disabled || rule.value === null} className="h-8 w-28 text-[13px]" aria-label={rule.name} />
          {value !== (rule.value ?? "") && (
            <Button size="sm" type="submit">
              Set
            </Button>
          )}
        </form>
      )}
    </div>
  );
}

function RuntimeSettings({ server: s }: { server: ServerDetail }) {
  const canEdit = useCan("server.configure");
  const java = useQuery({ queryKey: ["java"], queryFn: () => api.get<{ path: string; major: number; version: string; vendor: string | null; managed: boolean }[]>("/api/java") });
  const [f, setF] = React.useState({ name: s.name, description: s.description, memoryMb: s.memoryMb, jvmArgs: s.jvmArgs, javaPath: s.javaPath ?? "", autoStart: s.autoStart, infoCommand: s.infoCommand });
  const save = useAction(() => api.patch(`/api/servers/${s.id}`, { ...f, javaPath: f.javaPath || null }), { success: "Saved", invalidate: [["server", s.id], ["servers"]] });
  return (
    <div className="max-w-2xl space-y-6">
      <Section title="General">
        <Field label="Name" htmlFor="rname">
          <Input id="rname" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} disabled={!canEdit} maxLength={48} />
        </Field>
        <Field label="Description" htmlFor="rdesc">
          <Input id="rdesc" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} disabled={!canEdit} maxLength={280} />
        </Field>
        <ToggleRow label="Start with CraftPanel" help="Start automatically when CraftPanel starts." checked={f.autoStart} onChange={(v) => setF({ ...f, autoStart: v })} disabled={!canEdit} />
        <Field
          label="In-game info command"
          htmlFor="rinfo"
          help={`Players see a short card about CraftPanel with ${SOFTWARE_INFO[s.software].addons === "plugins" ? "/craftpanel (or /trigger craftpanel)" : "/trigger craftpanel"}. Installed or removed on the next start.`}
        >
          <NativeSelect
            id="rinfo"
            value={f.infoCommand === null ? "default" : f.infoCommand ? "on" : "off"}
            onChange={(e) => setF({ ...f, infoCommand: e.target.value === "default" ? null : e.target.value === "on" })}
            disabled={!canEdit}
            className="max-w-xs"
          >
            <option value="default">Use the global setting</option>
            <option value="on">On for this server</option>
            <option value="off">Off for this server</option>
          </NativeSelect>
        </Field>
      </Section>
      <Section title="Java & memory" description="Changes apply on the next start.">
        <Field label="Memory" htmlFor="rmem" aside={<span className="text-[13px] font-medium tabular-nums">{(f.memoryMb / 1024).toFixed(1)} GB</span>}>
          <input id="rmem" type="range" min={512} max={32768} step={512} value={f.memoryMb} onChange={(e) => setF({ ...f, memoryMb: Number(e.target.value) })} disabled={!canEdit} className="w-full accent-[var(--foreground)]" />
        </Field>
        <Field label="Java runtime" htmlFor="rjava" help={`Minecraft ${s.mcVersion} requires Java ${s.javaMajor}. Automatic picks a compatible runtime and downloads one if needed.`}>
          <NativeSelect id="rjava" value={f.javaPath} onChange={(e) => setF({ ...f, javaPath: e.target.value })} disabled={!canEdit}>
            <option value="">Automatic</option>
            {java.data?.map((j) => (
              <option key={j.path} value={j.path}>
                Java {j.version} · {j.vendor ?? "unknown"} {j.managed ? "(managed)" : ""} — {j.path}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field label="JVM arguments" htmlFor="rjvm" help="Each argument must start with '-'. Memory flags are managed above.">
          <Textarea id="rjvm" rows={3} value={f.jvmArgs} onChange={(e) => setF({ ...f, jvmArgs: e.target.value })} disabled={!canEdit} className="font-mono text-xs" />
        </Field>
        {s.log4shell && (
          <Callout icon={<ShieldCheck />} title="Log4Shell protection active">
            Minecraft {s.mcVersion} is affected by Log4Shell. CraftPanel adds {s.log4shell} on every start. Setting your own <code>-Dlog4j.configurationFile</code> or <code>-Dlog4j2.formatMsgNoLookups</code> argument turns this off.
          </Callout>
        )}
      </Section>
      {canEdit && (
        <Button onClick={() => save.mutate()} loading={save.isPending}>
          <Save /> Save changes
        </Button>
      )}
    </div>
  );
}

function RawEditor({ server: s }: { server: ServerDetail }) {
  const q = useProperties(s.id);
  const canEdit = useCan("server.configure");
  const [raw, setRaw] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (q.data) setRaw(q.data.raw);
  }, [q.data]);
  const save = useAction(() => api.put(`/api/servers/${s.id}/properties/raw`, { raw: raw ?? "" }), { success: "server.properties saved", invalidate: [["properties", s.id], ["server", s.id]] });
  const fileRef = React.useRef<HTMLInputElement>(null);
  if (raw === null) return <Skeleton className="h-96 rounded-xl" />;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="flex-1 text-[13px] text-muted-foreground">Values are validated before saving. Port and bind address are re-applied from the Network settings.</p>
        <input
          ref={fileRef}
          type="file"
          accept=".properties,.txt"
          hidden
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) setRaw(await f.text());
          }}
        />
        {canEdit && (
          <Button size="sm" variant="secondary" onClick={() => fileRef.current?.click()}>
            <Upload /> Import
          </Button>
        )}
        <Button size="sm" variant="secondary" onClick={() => downloadUrl(`/api/servers/${s.id}/properties/export`)}>
          <Download /> Export
        </Button>
        {canEdit && (
          <Button size="sm" onClick={() => save.mutate()} loading={save.isPending} disabled={raw === q.data?.raw}>
            <Save /> Save
          </Button>
        )}
      </div>
      <textarea
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        readOnly={!canEdit}
        spellCheck={false}
        className="scrollbar-thin h-[60vh] w-full resize-none rounded-xl border border-border bg-surface p-4 font-mono text-[12px] leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring/25"
        aria-label="server.properties"
      />
    </div>
  );
}

function DangerZone({ server: s }: { server: ServerDetail }) {
  const canDelete = useCan("server.delete");
  const canConfigure = useCan("server.configure");
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [deleteFiles, setDeleteFiles] = React.useState(true);
  const [backupFirst, setBackupFirst] = React.useState(true);
  const reinstall = useAction(() => api.post(`/api/servers/${s.id}/install`), { success: "Reinstalling server software…", invalidate: [["server", s.id]] });
  const stopped = !["running", "starting", "stopping", "orphaned"].includes(s.status);

  return (
    <div className="max-w-2xl space-y-6">
      {canConfigure && (
        <Panel className="flex items-center justify-between gap-4 p-5">
          <div>
            <p className="text-[13px] font-medium">Reinstall server software</p>
            <p className="text-xs text-muted-foreground">Re-download and verify the server jar and Java runtime. Worlds and settings are untouched.</p>
          </div>
          <Button variant="secondary" size="sm" onClick={() => reinstall.mutate()} disabled={!stopped} loading={reinstall.isPending}>
            Reinstall
          </Button>
        </Panel>
      )}
      {canDelete && (
        <Panel className="flex items-center justify-between gap-4 border-destructive/30 p-5">
          <div>
            <p className="text-[13px] font-medium">Delete server</p>
            <p className="text-xs text-muted-foreground">{stopped ? "Remove this server from CraftPanel." : "Stop the server before deleting it."}</p>
          </div>
          <Button variant="destructive" size="sm" onClick={() => setOpen(true)} disabled={!stopped}>
            Delete server
          </Button>
        </Panel>
      )}
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`Delete "${s.name}"?`}
        description="This cannot be undone."
        confirmLabel="Delete server"
        destructive
        confirmText={s.name}
        onConfirm={async () => {
          try {
            await api.del(`/api/servers/${s.id}?deleteFiles=${deleteFiles}&backup=${backupFirst}`);
            toast.success("Server deleted");
            router.replace("/servers/");
          } catch (err) {
            toast.error(errorMessage(err));
            throw err;
          }
        }}
      >
        <div className="space-y-3">
          <ToggleRow label="Create a final backup first" help="Kept in the backups folder after deletion." checked={backupFirst} onChange={setBackupFirst} />
          <ToggleRow label="Delete server files" help={`Removes ${s.directory}`} checked={deleteFiles} onChange={setDeleteFiles} />
        </div>
      </ConfirmDialog>
    </div>
  );
}
