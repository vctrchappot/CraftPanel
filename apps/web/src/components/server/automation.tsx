"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { CalendarClock, History, MoreHorizontal, Play, Plus, Trash2, Pencil } from "lucide-react";
import {
  Badge,
  Button,
  ChoiceCard,
  ConfirmDialog,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  Field,
  Input,
  NativeSelect,
  Panel,
  Section,
  Skeleton,
  Switch,
} from "@craftpanel/ui";
import type { ScheduleAction, ScheduleInfo, ServerDetail } from "@craftpanel/shared";
import { api } from "@/lib/api";
import { useCan } from "@/lib/auth";
import { useAction } from "@/lib/queries";
import { formatDateTime, timeAgo } from "@/lib/format";

const ACTIONS: { value: ScheduleAction; label: string; help: string }[] = [
  { value: "backup", label: "Back up", help: "Create a backup. Retention settings apply." },
  { value: "restart", label: "Restart", help: "Warn players, then restart gracefully." },
  { value: "start", label: "Start", help: "Start the server if it is stopped." },
  { value: "stop", label: "Stop", help: "Stop the server gracefully." },
  { value: "announce", label: "Announce", help: "Broadcast a chat message (/say)." },
  { value: "command", label: "Run command", help: "Send a console command." },
  { value: "prune-backups", label: "Prune backups", help: "Keep only the newest N backups." },
  { value: "cleanup-logs", label: "Clean up logs", help: "Delete archived logs older than N days." },
];

const PRESETS = [
  { label: "Every day at 04:00", cron: "0 4 * * *" },
  { label: "Every 6 hours", cron: "0 */6 * * *" },
  { label: "Every hour", cron: "0 * * * *" },
  { label: "Every 30 minutes", cron: "*/30 * * * *" },
  { label: "Sundays at 03:00", cron: "0 3 * * 0" },
];

interface Draft {
  id?: string;
  name: string;
  cron: string;
  action: ScheduleAction;
  enabled: boolean;
  message: string;
  command: string;
  keep: number;
  olderThanDays: number;
  warnSeconds: number;
}

const emptyDraft: Draft = { name: "Nightly backup", cron: "0 4 * * *", action: "backup", enabled: true, message: "", command: "", keep: 10, olderThanDays: 14, warnSeconds: 60 };

export function AutomationTab({ server: s }: { server: ServerDetail }) {
  const key = ["schedules", s.id];
  const q = useQuery({ queryKey: key, queryFn: () => api.get<ScheduleInfo[]>(`/api/schedules?serverId=${s.id}`) });
  const canManage = useCan("schedule.manage");
  const [draft, setDraft] = React.useState<Draft | null>(null);
  const [deleting, setDeleting] = React.useState<ScheduleInfo | null>(null);
  const [historyFor, setHistoryFor] = React.useState<ScheduleInfo | null>(null);
  const inv = [key];
  const toggle = useAction((sc: ScheduleInfo) => api.put(`/api/schedules/${sc.id}`, { ...sc, enabled: !sc.enabled }), { invalidate: inv });
  const run = useAction((id: string) => api.post(`/api/schedules/${id}/run`), { success: "Task started", invalidate: inv });
  const del = useAction((id: string) => api.del(`/api/schedules/${id}`), { success: "Schedule deleted", invalidate: inv });

  return (
    <Section
      title="Scheduled tasks"
      description="Schedules run in this machine's local time while CraftPanel is running. Each task runs at most once per scheduled minute, even across restarts."
      actions={
        canManage && (
          <Button size="sm" onClick={() => setDraft({ ...emptyDraft })}>
            <Plus /> New task
          </Button>
        )
      }
    >
      {q.isLoading ? (
        <Skeleton className="h-32 rounded-xl" />
      ) : !q.data?.length ? (
        <EmptyState icon={<CalendarClock />} title="No scheduled tasks" description="Automate backups, restarts, announcements and maintenance." />
      ) : (
        <Panel>
          <ul className="divide-y divide-border">
            {q.data.map((sc) => (
              <li key={sc.id} className="flex flex-wrap items-center gap-4 px-4 py-3.5 text-[13px]">
                <Switch checked={sc.enabled} disabled={!canManage} onCheckedChange={() => toggle.mutate(sc)} aria-label={`Enable ${sc.name}`} />
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 font-medium">
                    {sc.name}
                    <Badge>{ACTIONS.find((a) => a.value === sc.action)?.label ?? sc.action}</Badge>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    <code className="font-mono">{sc.cron}</code>
                    {sc.enabled && sc.nextRunAt ? ` · next ${formatDateTime(sc.nextRunAt)}` : ""}
                    {sc.lastRunAt ? ` · last ${timeAgo(sc.lastRunAt)} (${sc.lastStatus})` : " · never run"}
                  </p>
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="icon-sm" variant="ghost" aria-label="Task actions">
                      <MoreHorizontal />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent>
                    <DropdownMenuItem onSelect={() => setHistoryFor(sc)}>
                      <History /> Run history
                    </DropdownMenuItem>
                    {canManage && (
                      <>
                        <DropdownMenuItem onSelect={() => run.mutate(sc.id)}>
                          <Play /> Run now
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={() =>
                            setDraft({
                              ...emptyDraft,
                              id: sc.id,
                              name: sc.name,
                              cron: sc.cron,
                              action: sc.action,
                              enabled: sc.enabled,
                              ...(sc.payload as Partial<Draft>),
                            })
                          }
                        >
                          <Pencil /> Edit
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem destructive onSelect={() => setDeleting(sc)}>
                          <Trash2 /> Delete
                        </DropdownMenuItem>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </li>
            ))}
          </ul>
        </Panel>
      )}
      {draft && <ScheduleEditor serverId={s.id} draft={draft} onClose={() => setDraft(null)} />}
      <RunHistory schedule={historyFor} onClose={() => setHistoryFor(null)} />
      <ConfirmDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)} title={`Delete "${deleting?.name}"?`} destructive confirmLabel="Delete" onConfirm={() => del.mutateAsync(deleting!.id)} />
    </Section>
  );
}

function ScheduleEditor({ serverId, draft, onClose }: { serverId: string; draft: Draft; onClose: () => void }) {
  const [d, setD] = React.useState(draft);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((p) => ({ ...p, [k]: v }));
  const preview = useQuery({ queryKey: ["cron-preview", d.cron], queryFn: () => api.get<{ error: string | null; next: number[] }>(`/api/schedules/preview?cron=${encodeURIComponent(d.cron)}`), enabled: !!d.cron.trim() });
  const save = useAction(
    () => {
      const payload: Record<string, unknown> = {};
      if (d.action === "announce") payload.message = d.message;
      if (d.action === "command") payload.command = d.command;
      if (d.action === "prune-backups") payload.keep = d.keep;
      if (d.action === "cleanup-logs") payload.olderThanDays = d.olderThanDays;
      if (d.action === "restart") payload.warnSeconds = d.warnSeconds;
      const body = { serverId, name: d.name, cron: d.cron, action: d.action, enabled: d.enabled, payload };
      return d.id ? api.put(`/api/schedules/${d.id}`, body) : api.post("/api/schedules", body);
    },
    { success: "Schedule saved", invalidate: [["schedules", serverId]], onSuccess: onClose },
  );
  const action = ACTIONS.find((a) => a.value === d.action)!;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader title={d.id ? "Edit task" : "New scheduled task"} />
        <Field label="Name" htmlFor="sname">
          <Input id="sname" value={d.name} onChange={(e) => set("name", e.target.value)} maxLength={64} />
        </Field>
        <Field label="Action" htmlFor="saction" help={action.help}>
          <NativeSelect id="saction" value={d.action} onChange={(e) => set("action", e.target.value as ScheduleAction)}>
            {ACTIONS.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </NativeSelect>
        </Field>
        {d.action === "announce" && (
          <Field label="Message" htmlFor="smsg">
            <Input id="smsg" value={d.message} onChange={(e) => set("message", e.target.value)} maxLength={256} />
          </Field>
        )}
        {d.action === "command" && (
          <Field label="Command" htmlFor="scmd" help="Without the leading slash.">
            <Input id="scmd" value={d.command} onChange={(e) => set("command", e.target.value)} className="font-mono" maxLength={1000} />
          </Field>
        )}
        {d.action === "restart" && (
          <Field label="Warning before restart (seconds)" htmlFor="swarn">
            <Input id="swarn" type="number" min={0} max={600} value={d.warnSeconds} onChange={(e) => set("warnSeconds", Number(e.target.value))} />
          </Field>
        )}
        {d.action === "prune-backups" && (
          <Field label="Backups to keep" htmlFor="skeep">
            <Input id="skeep" type="number" min={1} max={1000} value={d.keep} onChange={(e) => set("keep", Number(e.target.value))} />
          </Field>
        )}
        {d.action === "cleanup-logs" && (
          <Field label="Delete logs older than (days)" htmlFor="sdays">
            <Input id="sdays" type="number" min={1} value={d.olderThanDays} onChange={(e) => set("olderThanDays", Number(e.target.value))} />
          </Field>
        )}
        <Field
          label="Schedule"
          htmlFor="scron"
          help={preview.data?.error ? undefined : preview.data?.next.length ? `Next: ${preview.data.next.slice(0, 3).map((t) => formatDateTime(t)).join(" · ")}` : "Cron expression: minute hour day month weekday"}
          error={preview.data?.error}
        >
          <div className="space-y-2">
            <div role="group" aria-label="Schedule presets" className="flex flex-wrap gap-1.5">
              {PRESETS.map((p) => (
                <ChoiceCard key={p.cron} selected={d.cron === p.cron} onClick={() => set("cron", p.cron)} className="px-2.5 py-1 text-xs">
                  {p.label}
                </ChoiceCard>
              ))}
            </div>
            <Input id="scron" value={d.cron} onChange={(e) => set("cron", e.target.value)} className="font-mono" />
          </div>
        </Field>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!!preview.data?.error || !d.name.trim()}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RunHistory({ schedule, onClose }: { schedule: ScheduleInfo | null; onClose: () => void }) {
  const q = useQuery({
    queryKey: ["schedule-runs", schedule?.id],
    queryFn: () => api.get<{ id: number; startedAt: number; finishedAt: number | null; status: string; output: string | null }[]>(`/api/schedules/${schedule!.id}/runs`),
    enabled: !!schedule,
  });
  return (
    <Dialog open={!!schedule} onOpenChange={(o) => !o && onClose()}>
      <DialogContent wide>
        <DialogHeader title={`Run history — ${schedule?.name}`} />
        {q.data?.length ? (
          <ul className="max-h-96 divide-y divide-border overflow-y-auto text-[13px]">
            {q.data.map((r) => (
              <li key={r.id} className="flex items-start gap-3 py-2.5">
                <Badge variant={r.status === "success" ? "success" : r.status === "failed" ? "danger" : "default"}>{r.status}</Badge>
                <div className="min-w-0">
                  <p>{formatDateTime(r.startedAt)}</p>
                  {r.output && <p className="break-words text-xs text-muted-foreground">{r.output}</p>}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[13px] text-muted-foreground">{q.isLoading ? "Loading…" : "This task has not run yet."}</p>
        )}
      </DialogContent>
    </Dialog>
  );
}
