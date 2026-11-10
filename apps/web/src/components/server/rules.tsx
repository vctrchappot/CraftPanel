"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Archive, BellRing, Moon, MoreHorizontal, Pencil, Plus, RotateCw, Snowflake, Trash2 } from "lucide-react";
import {
  Badge,
  Button,
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
  Field,
  Input,
  NativeSelect,
  Panel,
  Section,
  Skeleton,
  Switch,
} from "@craftpanel/ui";
import { describeAction, describeCondition, type RuleAction, type RuleCondition, type RuleInfo, type RuleInput, type ServerDetail } from "@craftpanel/shared";
import { api } from "@/lib/api";
import { useCan } from "@/lib/auth";
import { useAction } from "@/lib/queries";
import { timeAgo } from "@/lib/format";

const WHEN: { kind: RuleCondition["kind"]; label: string; make: () => RuleCondition }[] = [
  { kind: "empty", label: "Nobody is online", make: () => ({ kind: "empty" }) },
  { kind: "low-tps", label: "The server lags (low TPS)", make: () => ({ kind: "low-tps", below: 15 }) },
  { kind: "host-memory", label: "The machine runs out of memory", make: () => ({ kind: "host-memory", abovePercent: 90 }) },
  { kind: "low-disk", label: "Disk space runs low", make: () => ({ kind: "low-disk", belowGb: 5 }) },
  { kind: "uptime", label: "The server has been up for a long time", make: () => ({ kind: "uptime", hours: 24 }) },
];

const THEN: { kind: RuleAction["kind"]; label: string; make: () => RuleAction }[] = [
  { kind: "stop", label: "Stop the server", make: () => ({ kind: "stop", warnSeconds: 30, wake: false }) },
  { kind: "restart", label: "Restart the server", make: () => ({ kind: "restart", warnSeconds: 60 }) },
  { kind: "command", label: "Run a console command", make: () => ({ kind: "command", command: "" }) },
  { kind: "announce", label: "Announce in chat", make: () => ({ kind: "announce", message: "" }) },
  { kind: "backup", label: "Create a backup", make: () => ({ kind: "backup" }) },
  { kind: "notify", label: "Send a notification", make: () => ({ kind: "notify", message: "" }) },
  { kind: "pause-map", label: "Pause the map renderer", make: () => ({ kind: "pause-map" }) },
];

interface Starter {
  icon: React.ReactNode;
  title: string;
  text: string;
  rule: RuleInput;
}

const STARTERS: Starter[] = [
  {
    icon: <Moon />,
    title: "Sleep when empty",
    text: "Stops the server after 10 quiet minutes. The first player who tries to join wakes it up.",
    rule: { name: "Sleep when empty", enabled: true, when: { kind: "empty" }, forMinutes: 10, onlyIfEmpty: false, then: { kind: "stop", warnSeconds: 0, wake: true } },
  },
  {
    icon: <Snowflake />,
    title: "Freeze when empty",
    text: "Freezes the game world while nobody is there and thaws it when a player joins. Minecraft 1.20.3 or newer.",
    rule: { name: "Freeze when empty", enabled: true, when: { kind: "empty" }, forMinutes: 5, onlyIfEmpty: false, then: { kind: "command", command: "tick freeze", undoCommand: "tick unfreeze" } },
  },
  {
    icon: <Archive />,
    title: "Back up after the last player left",
    text: "A backup two minutes after the server became empty, once per session.",
    rule: { name: "Back up when empty", enabled: true, when: { kind: "empty" }, forMinutes: 2, onlyIfEmpty: false, then: { kind: "backup" } },
  },
  {
    icon: <RotateCw />,
    title: "Restart when it lags",
    text: "Restarts a server that stays below 12 TPS for three minutes, but only when nobody is playing.",
    rule: { name: "Restart on lag", enabled: true, when: { kind: "low-tps", below: 12 }, forMinutes: 3, onlyIfEmpty: true, then: { kind: "restart", warnSeconds: 0 } },
  },
  {
    icon: <BellRing />,
    title: "Warn about low disk space",
    text: "Sends a notification when less than 5 GB are free. Set up Discord or email under Settings → Notifications.",
    rule: { name: "Low disk space", enabled: true, when: { kind: "low-disk", belowGb: 5 }, forMinutes: 5, onlyIfEmpty: false, then: { kind: "notify", message: "Disk space is running out" } },
  },
];

function status(rule: RuleInfo, running: boolean): { label: string; variant: "default" | "success" | "warning" | "info" | "outline" } {
  if (!rule.enabled) return { label: "Off", variant: "outline" };
  if (rule.sleeping) return { label: "Asleep, wakes on connect", variant: "info" };
  if (rule.active) return { label: "In effect", variant: "warning" };
  if (!running) return { label: "Idle, the server is stopped", variant: "outline" };
  if (rule.holdingSince) {
    const done = Math.floor((Date.now() - rule.holdingSince) / 60_000);
    return { label: rule.forMinutes ? `Waiting, ${Math.min(done, rule.forMinutes)} of ${rule.forMinutes} min` : "Waiting", variant: "default" };
  }
  return { label: "Watching", variant: "success" };
}

export function RulesSection({ server: s }: { server: ServerDetail }) {
  const key = ["rules", s.id];
  const canManage = useCan("schedule.manage");
  const q = useQuery({ queryKey: key, queryFn: () => api.get<RuleInfo[]>(`/api/servers/${s.id}/rules`), refetchInterval: 15_000 });
  const [draft, setDraft] = React.useState<(RuleInput & { id?: string }) | null>(null);
  const [deleting, setDeleting] = React.useState<RuleInfo | null>(null);
  const toggle = useAction((r: RuleInfo) => api.put(`/api/servers/${s.id}/rules/${r.id}`, { ...r, enabled: !r.enabled }), { invalidate: [key] });
  const del = useAction((id: string) => api.del(`/api/servers/${s.id}/rules/${id}`), { success: "Rule deleted", invalidate: [key] });

  return (
    <Section
      title="Rules"
      description="React to what happens on the server: stop it when it's empty, freeze it, restart it when it lags, or get a message when the disk fills up. A rule acts once the condition has held for the time you set and starts over when it breaks."
      actions={
        canManage && (
          <Button size="sm" onClick={() => setDraft({ ...STARTERS[0]!.rule, name: "", then: { kind: "stop", warnSeconds: 30, wake: false }, forMinutes: 10 })}>
            <Plus /> New rule
          </Button>
        )
      }
    >
      {q.isLoading ? (
        <Skeleton className="h-32 rounded-lg" />
      ) : !q.data?.length ? (
        <div className="space-y-3">
          <p className="text-[13px] text-muted-foreground">No rules yet. Start from a template or build your own with <span className="font-medium text-foreground">New rule</span>.</p>
          {canManage && (
            <ul className="grid gap-3 sm:grid-cols-2" aria-label="Rule templates">
              {STARTERS.map((st) => (
                <li key={st.title}>
                  <button
                    type="button"
                    onClick={() => setDraft({ ...st.rule })}
                    className="flex h-full w-full items-start gap-3 rounded-lg border border-border bg-card p-3.5 text-left text-[13px] transition-colors hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-md border border-border bg-background text-muted-foreground [&_svg]:size-4">{st.icon}</span>
                    <span className="min-w-0">
                      <span className="block font-medium">{st.title}</span>
                      <span className="mt-0.5 block text-muted-foreground">{st.text}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <Panel>
          <ul className="divide-y divide-border">
            {q.data.map((r) => {
              const st = status(r, s.status === "running");
              return (
                <li key={r.id} className="flex flex-wrap items-center gap-4 px-4 py-3.5 text-[13px]">
                  <Switch checked={r.enabled} disabled={!canManage} onCheckedChange={() => toggle.mutate(r)} aria-label={`Enable ${r.name}`} />
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 font-medium">
                      {r.name}
                      <Badge variant={st.variant}>{st.label}</Badge>
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {describeCondition(r)}, then {describeAction(r.then)}.
                    </p>
                    <p className="text-xs text-muted-foreground">{r.lastTriggeredAt ? `Last ran ${timeAgo(r.lastTriggeredAt)}: ${r.lastResult}` : "Has not run yet"}</p>
                  </div>
                  {canManage && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button size="icon-sm" variant="ghost" aria-label="Rule actions">
                          <MoreHorizontal />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent>
                        <DropdownMenuItem onSelect={() => setDraft({ ...r })}>
                          <Pencil /> Edit
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem destructive onSelect={() => setDeleting(r)}>
                          <Trash2 /> Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </li>
              );
            })}
          </ul>
        </Panel>
      )}
      {draft && <RuleEditor serverId={s.id} draft={draft} onClose={() => setDraft(null)} />}
      <ConfirmDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)} title={`Delete "${deleting?.name}"?`} description={deleting?.sleeping ? "The server stays stopped, but it no longer wakes when a player connects." : undefined} destructive confirmLabel="Delete" onConfirm={() => del.mutateAsync(deleting!.id)} />
    </Section>
  );
}

function RuleEditor({ serverId, draft, onClose }: { serverId: string; draft: RuleInput & { id?: string }; onClose: () => void }) {
  const [d, setD] = React.useState(draft);
  const set = <K extends keyof RuleInput>(k: K, v: RuleInput[K]) => setD((p) => ({ ...p, [k]: v }));
  const { when, then } = d;
  const asleep = then.kind === "stop" && then.wake;
  const save = useAction(
    () => {
      const { id, ...body } = d;
      return id ? api.put(`/api/servers/${serverId}/rules/${id}`, body) : api.post(`/api/servers/${serverId}/rules`, body);
    },
    { success: "Rule saved", invalidate: [["rules", serverId]], onSuccess: onClose },
  );
  const num = (v: string) => (v === "" ? 0 : Number(v));
  const needsMessage = (then.kind === "announce" || then.kind === "notify") && !then.message.trim();
  const needsCommand = then.kind === "command" && !then.command.trim();
  const wakeProblem = then.kind === "stop" && then.wake && when.kind !== "empty" && !d.onlyIfEmpty;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader title={d.id ? "Edit rule" : "New rule"} />
        <Field label="Name" htmlFor="rname">
          <Input id="rname" value={d.name} onChange={(e) => set("name", e.target.value)} maxLength={64} />
        </Field>

        <fieldset className="space-y-3 rounded-lg border border-border p-3.5">
          <legend className="px-1 text-xs font-medium text-muted-foreground">When</legend>
          <Field label="Condition" htmlFor="rwhen">
            <NativeSelect id="rwhen" value={when.kind} onChange={(e) => set("when", WHEN.find((w) => w.kind === e.target.value)!.make())}>
              {WHEN.map((w) => (
                <option key={w.kind} value={w.kind}>
                  {w.label}
                </option>
              ))}
            </NativeSelect>
          </Field>
          {when.kind === "low-tps" && (
            <Field label="TPS is below" htmlFor="rtps" help="20 is perfect, below 15 players start to notice. The server's tick rate is read every 15 seconds.">
              <Input id="rtps" type="number" min={1} max={19.5} step={0.5} value={when.below} onChange={(e) => set("when", { kind: "low-tps", below: num(e.target.value) })} />
            </Field>
          )}
          {when.kind === "host-memory" && (
            <Field label="Machine memory in use above (%)" htmlFor="rmem">
              <Input id="rmem" type="number" min={50} max={99} value={when.abovePercent} onChange={(e) => set("when", { kind: "host-memory", abovePercent: num(e.target.value) })} />
            </Field>
          )}
          {when.kind === "low-disk" && (
            <Field label="Free disk space below (GB)" htmlFor="rdisk" help="Measured on the disk that holds this server's folder.">
              <Input id="rdisk" type="number" min={0.5} max={1000} step={0.5} value={when.belowGb} onChange={(e) => set("when", { kind: "low-disk", belowGb: num(e.target.value) })} />
            </Field>
          )}
          {when.kind === "uptime" && (
            <Field label="Running for more than (hours)" htmlFor="rup">
              <Input id="rup" type="number" min={1} max={720} value={when.hours} onChange={(e) => set("when", { kind: "uptime", hours: num(e.target.value) })} />
            </Field>
          )}
          {when.kind !== "uptime" && (
            <Field label="For at least (minutes)" htmlFor="rfor" help={when.kind === "empty" ? "Counted from the moment the server is online with nobody on it, including right after it started." : "The condition has to hold this long without a break. 0 acts right away."}>
              <Input id="rfor" type="number" min={when.kind === "empty" ? 1 : 0} max={1440} value={d.forMinutes} onChange={(e) => set("forMinutes", num(e.target.value))} />
            </Field>
          )}
          {when.kind !== "empty" && (
            <label className="flex items-center gap-3 text-[13px]">
              <Switch checked={d.onlyIfEmpty} onCheckedChange={(v) => set("onlyIfEmpty", v)} aria-label="Only while nobody is online" />
              Only while nobody is online
            </label>
          )}
        </fieldset>

        <fieldset className="space-y-3 rounded-lg border border-border p-3.5">
          <legend className="px-1 text-xs font-medium text-muted-foreground">Then</legend>
          <Field label="Action" htmlFor="rthen">
            <NativeSelect id="rthen" value={then.kind} onChange={(e) => set("then", THEN.find((t) => t.kind === e.target.value)!.make())}>
              {THEN.map((t) => (
                <option key={t.kind} value={t.kind}>
                  {t.label}
                </option>
              ))}
            </NativeSelect>
          </Field>
          {(then.kind === "stop" || then.kind === "restart") && (
            <Field label="Warn players beforehand (seconds)" htmlFor="rwarn" help="Only used when someone is online; an empty server is stopped right away.">
              <Input id="rwarn" type="number" min={0} max={600} value={then.warnSeconds} onChange={(e) => set("then", { ...then, warnSeconds: num(e.target.value) })} />
            </Field>
          )}
          {then.kind === "stop" && (
            <div className="space-y-1.5">
              <label className="flex items-center gap-3 text-[13px]">
                <Switch checked={then.wake} onCheckedChange={(v) => set("then", { ...then, wake: v })} aria-label="Wake the server when a player connects" />
                Wake the server when a player connects
              </label>
              <p className="text-xs text-muted-foreground">
                {asleep
                  ? "While it sleeps, CraftPanel answers on the server's port: the server list shows it as asleep, and the first player who tries to join starts it (about a minute, then they join again)."
                  : "Off: the server stays stopped until you start it."}
              </p>
              {wakeProblem && <p className="text-xs text-danger">Waking only works when the server sleeps because nobody was there: pick &quot;Nobody is online&quot; above or turn on &quot;Only while nobody is online&quot;.</p>}
            </div>
          )}
          {then.kind === "command" && (
            <>
              <Field label="Command" htmlFor="rcmd" help="Without the leading slash.">
                <Input id="rcmd" value={then.command} onChange={(e) => set("then", { ...then, command: e.target.value })} className="font-mono" maxLength={1000} />
              </Field>
              <Field label="Command when the condition ends (optional)" htmlFor="rundo" help="Undoes the first one, for example “tick unfreeze” after “tick freeze”. The rule then stays in effect until the condition ends.">
                <Input id="rundo" value={then.undoCommand ?? ""} onChange={(e) => set("then", { ...then, undoCommand: e.target.value || undefined })} className="font-mono" maxLength={1000} />
              </Field>
            </>
          )}
          {(then.kind === "announce" || then.kind === "notify") && (
            <Field label="Message" htmlFor="rmsg" help={then.kind === "notify" ? "Goes to Discord and email as set up under Settings → Notifications." : "Shown in chat with /say."}>
              <Input id="rmsg" value={then.message} onChange={(e) => set("then", { ...then, message: e.target.value })} maxLength={256} />
            </Field>
          )}
          {then.kind === "pause-map" && <p className="text-xs text-muted-foreground">The BlueMap renderer is paused while the condition holds and continues when it ends.</p>}
        </fieldset>

        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!d.name.trim() || needsMessage || needsCommand || wakeProblem}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
