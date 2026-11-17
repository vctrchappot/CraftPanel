"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { History, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { Badge, Button, ConfirmDialog, Dialog, DialogContent, DialogFooter, DialogHeader, Field, Input, Panel, Switch } from "@craftpanel/ui";
import type { ScheduleInfo } from "@craftpanel/shared";
import { api } from "@/lib/api";
import { useAction } from "@/lib/queries";
import { formatDateTime } from "@/lib/format";

const key = ["application-backup-schedules"];
const presets = [{ label: "Daily at 04:00", cron: "0 4 * * *" }, { label: "Every 6 hours", cron: "0 */6 * * *" }, { label: "Sundays at 03:00", cron: "0 3 * * 0" }];
interface Draft { id?: string; name: string; cron: string; enabled: boolean; includeServers: boolean; includeBackupHistory: boolean; encrypted: boolean; passphrase: string; confirm: string; keep: number }
const initial: Draft = { name: "Nightly application backup", cron: "0 4 * * *", enabled: true, includeServers: true, includeBackupHistory: false, encrypted: false, passphrase: "", confirm: "", keep: 7 };

export function AppBackupSchedules() {
  const [draft, setDraft] = React.useState<Draft | null>(null);
  const [deleting, setDeleting] = React.useState<ScheduleInfo | null>(null);
  const [history, setHistory] = React.useState<ScheduleInfo | null>(null);
  const q = useQuery({ queryKey: key, queryFn: () => api.get<ScheduleInfo[]>("/api/schedules"), select: (rows) => rows.filter((s) => s.action === "application-backup"), refetchInterval: 5000 });
  const toggle = useAction((s: ScheduleInfo) => api.put(`/api/schedules/${s.id}`, { ...s, enabled: !s.enabled }), { invalidate: [key] });
  const run = useAction((id: string) => api.post(`/api/schedules/${id}/run`), { success: "Backup task started", invalidate: [key, ["app-backups"]] });
  const remove = useAction((id: string) => api.del(`/api/schedules/${id}`), { success: "Schedule deleted", invalidate: [key] });
  return <div className="space-y-3 border-y border-border py-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h3 className="text-sm font-medium">Automatic application backups</h3><p className="mt-1 text-xs text-muted-foreground">Run in this computer&apos;s local time while CraftPanel is running. Missed runs are not caught up.</p></div>
      <Button size="sm" variant="secondary" onClick={() => setDraft({ ...initial })}><Plus /> Add schedule</Button>
    </div>
    {!!q.data?.length && <Panel><ul className="divide-y divide-border">{q.data.map((s) => <li key={s.id} className="flex flex-wrap items-center gap-3 p-3 text-[13px]">
      <Switch checked={s.enabled} disabled={toggle.isPending} onCheckedChange={() => toggle.mutate(s)} aria-label={`Enable ${s.name}`} />
      <div className="min-w-0 basis-[calc(100%-3rem)] sm:flex-1"><p className="break-words font-medium">{s.name}</p><p className="text-xs text-muted-foreground"><code>{s.cron}</code> · keep {Number(s.payload.keep ?? 7)} · {s.payload.includeServers === false ? "settings only" : "with server files"}</p>{s.enabled && s.nextRunAt && <p className="text-xs text-muted-foreground">Next {formatDateTime(s.nextRunAt)}</p>}</div>
      {s.lastStatus && <Badge variant={s.lastStatus === "failed" ? "danger" : s.lastStatus === "success" ? "success" : "default"}>{s.lastStatus}</Badge>}
      {!!s.payload.encrypted && <Badge variant="outline">Encrypted</Badge>}
      <div className="flex items-center gap-1">
        <Button size="icon-sm" variant="ghost" aria-label={`Run ${s.name} now`} disabled={run.isPending} onClick={() => run.mutate(s.id)}><Play /></Button>
        <Button size="icon-sm" variant="ghost" aria-label={`History of ${s.name}`} onClick={() => setHistory(s)}><History /></Button>
        <Button size="icon-sm" variant="ghost" aria-label={`Edit ${s.name}`} onClick={() => setDraft({ ...initial, id: s.id, name: s.name, cron: s.cron, enabled: s.enabled, includeServers: s.payload.includeServers !== false, includeBackupHistory: !!s.payload.includeBackupHistory, encrypted: !!s.payload.encrypted, keep: Number(s.payload.keep ?? 7) })}><Pencil /></Button>
        <Button size="icon-sm" variant="ghost" aria-label={`Delete schedule ${s.name}`} onClick={() => setDeleting(s)}><Trash2 /></Button>
      </div>
    </li>)}</ul></Panel>}
    <p className="text-xs text-muted-foreground">After a successful backup, keep only the newest files from that schedule. Manual backups are kept. Configure failure alerts in Settings → Notifications under Backups.</p>
    {draft && <ScheduleEditor draft={draft} close={() => setDraft(null)} />}
    <BackupRunHistory schedule={history} close={() => setHistory(null)} />
    <ConfirmDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)} title="Delete this backup schedule?" description="Existing backup files are kept." confirmLabel="Delete" destructive onConfirm={() => remove.mutateAsync(deleting!.id)} />
  </div>;
}

function ScheduleEditor({ draft, close }: { draft: Draft; close: () => void }) {
  const [d, setD] = React.useState(draft);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((p) => ({ ...p, [k]: v }));
  const preview = useQuery({ queryKey: ["cron-preview", d.cron], queryFn: () => api.get<{ error: string | null; next: number[] }>(`/api/schedules/preview?cron=${encodeURIComponent(d.cron)}`), enabled: !!d.cron.trim() });
  const save = useAction(() => {
    const body = { name: d.name, cron: d.cron, enabled: d.enabled, serverId: null, action: "application-backup", payload: { keep: d.keep, includeServers: d.includeServers, includeBackupHistory: d.includeBackupHistory, encrypted: d.encrypted }, ...(d.encrypted && d.passphrase ? { backupPassphrase: d.passphrase } : {}) };
    return d.id ? api.put(`/api/schedules/${d.id}`, body) : api.post("/api/schedules", body);
  }, { success: "Backup schedule saved", invalidate: [key], onSuccess: close });
  return <Dialog open onOpenChange={(o) => !o && close()}><DialogContent>
    <DialogHeader title={d.id ? "Edit application backup schedule" : "Schedule application backups"} />
    <Field label="Name" htmlFor="ab-name"><Input id="ab-name" value={d.name} maxLength={64} onChange={(e) => set("name", e.target.value)} /></Field>
    <Field label="Schedule" htmlFor="ab-cron" error={preview.data?.error} help={preview.data?.next.length ? `Next: ${preview.data.next.slice(0, 3).map(formatDateTime).join(" · ")}` : "Cron: minute hour day month weekday, in this computer's local time."}>
      <div className="space-y-2"><div className="flex flex-wrap gap-1.5">{presets.map((p) => <Button key={p.cron} size="sm" variant="secondary" onClick={() => set("cron", p.cron)}>{p.label}</Button>)}</div><Input id="ab-cron" value={d.cron} className="font-mono" onChange={(e) => set("cron", e.target.value)} /></div>
    </Field>
    <Field label="Backups to keep" htmlFor="ab-keep" help="Applies only to this schedule, after a successful backup."><Input id="ab-keep" type="number" min={1} max={1000} value={d.keep} onChange={(e) => set("keep", Number(e.target.value))} /></Field>
    <label className="flex items-center gap-2 text-[13px]"><Switch checked={d.includeServers} aria-label="Include server files and worlds in scheduled backups" onCheckedChange={(v) => set("includeServers", v)} />Include server files and worlds</label>
    <label className="flex items-center gap-2 text-[13px]"><Switch checked={d.includeBackupHistory} aria-label="Include earlier server backups in this schedule" onCheckedChange={(v) => set("includeBackupHistory", v)} />Include earlier server backups</label>
    <label className="flex items-center gap-2 text-[13px]"><Switch checked={d.encrypted} aria-label="Encrypt scheduled application backups" onCheckedChange={(v) => set("encrypted", v)} />Encrypt with a passphrase</label>
    {d.encrypted && <>
      <Field label="Schedule passphrase" htmlFor="ab-schedule-passphrase" help="Stored privately on this computer, outside the backup. Enter it again after a move. Leave empty to keep the current passphrase."><Input id="ab-schedule-passphrase" type="password" autoComplete="new-password" minLength={10} maxLength={1024} value={d.passphrase} onChange={(e) => set("passphrase", e.target.value)} /></Field>
      <Field label="Confirm passphrase" htmlFor="ab-schedule-confirm" error={d.confirm && d.confirm !== d.passphrase ? "Passphrases do not match" : null}><Input id="ab-schedule-confirm" type="password" autoComplete="new-password" maxLength={1024} value={d.confirm} onChange={(e) => set("confirm", e.target.value)} /></Field>
    </>}
    <DialogFooter><Button variant="secondary" onClick={close}>Cancel</Button><Button loading={save.isPending} disabled={!d.name.trim() || !d.cron.trim() || !!preview.data?.error || !Number.isInteger(d.keep) || d.keep < 1 || d.keep > 1000 || (d.encrypted && ((!d.id && d.passphrase.length < 10) || (!!d.passphrase && (d.passphrase.length < 10 || d.passphrase !== d.confirm))))} onClick={() => save.mutate()}>Save schedule</Button></DialogFooter>
  </DialogContent></Dialog>;
}

function BackupRunHistory({ schedule, close }: { schedule: ScheduleInfo | null; close: () => void }) {
  const q = useQuery({ queryKey: ["schedule-runs", schedule?.id], queryFn: () => api.get<{ id: number; startedAt: number; status: string; output: string | null }[]>(`/api/schedules/${schedule!.id}/runs`), enabled: !!schedule, refetchInterval: schedule ? 2000 : false });
  return <Dialog open={!!schedule} onOpenChange={(o) => !o && close()}><DialogContent wide><DialogHeader title={`Run history — ${schedule?.name}`} />
    {q.data?.length ? <ul className="max-h-96 divide-y divide-border overflow-y-auto text-[13px]">{q.data.map((r) => <li key={r.id} className="flex items-start gap-3 py-2.5"><Badge variant={r.status === "failed" ? "danger" : r.status === "success" ? "success" : "default"}>{r.status}</Badge><div className="min-w-0"><p>{formatDateTime(r.startedAt)}</p>{r.output && <p className="break-words text-xs text-muted-foreground">{r.output}</p>}</div></li>)}</ul> : <p className="text-[13px] text-muted-foreground">{q.isLoading ? "Loading…" : "This task has not run yet."}</p>}
  </DialogContent></Dialog>;
}
