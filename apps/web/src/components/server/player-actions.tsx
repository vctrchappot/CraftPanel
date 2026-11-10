"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Ban,
  ChevronRight,
  Crown,
  Eraser,
  FlaskConical,
  Gamepad2,
  Ghost,
  HeartPulse,
  Loader2,
  LogOut,
  MapPin,
  MessageSquare,
  PackagePlus,
  Rocket,
  ShieldOff,
  Skull,
  Sparkles,
  Trash2,
  Type,
  UserPlus,
  Users,
  Volume2,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { Badge, Button, Callout, ConfirmDialog, Dialog, DialogContent, DialogFooter, DialogHeader, Field, Input, NativeSelect, Panel, Section, Skeleton, Switch, cn } from "@craftpanel/ui";
import { PLAYER_ACTIONS, prettyId, type PlayerActionDef, type PlayerActionGroup, type PlayerActionParam, type PlayerActionValues, type PlayerInspect, type PlayerProfile, type ServerDetail } from "@craftpanel/shared";
import { api, ApiError } from "@/lib/api";
import { useCan } from "@/lib/auth";
import { useAction } from "@/lib/queries";
import { formatPlaytime, timeAgo } from "@/lib/format";
import { CopyButton } from "./workspace";
import { Card } from "./player-charts";
import { LiveTag, ReasonDialog, Row, usePlayerActions } from "./player-parts";

const ICONS: Record<string, LucideIcon> = {
  "teleport-player": Users,
  "teleport-coords": MapPin,
  heal: HeartPulse,
  gamemode: Gamepad2,
  "give-item": PackagePlus,
  "set-xp": Sparkles,
  "clear-effects": Eraser,
  message: MessageSquare,
  "clear-inventory": Trash2,
  title: Type,
  sound: Volume2,
  effect: FlaskConical,
  "fake-op": Ghost,
  launch: Rocket,
  lightning: Zap,
  kill: Skull,
};

/** Everything you can do with one player, in one place: what they have, what you can do to them, and who may join. */
export function PlayerActions({ server: s, p }: { server: ServerDetail; p: PlayerProfile }) {
  const canManage = useCan("players.manage");
  const inGame = s.status === "running" && p.online;
  const [setup, setSetup] = React.useState<PlayerActionDef | null>(null);
  const [confirm, setConfirm] = React.useState<PlayerActionDef | null>(null);

  const run = useAction((v: { def: PlayerActionDef; params: PlayerActionValues }) => api.post<{ summary: string }>(`/api/servers/${s.id}/players/${encodeURIComponent(p.name)}/actions/${v.def.id}`, { params: v.params }), {
    success: (r) => r.summary,
    invalidate: [["player", s.id], ["inspect", s.id, p.name]],
  });
  const pick = (def: PlayerActionDef) => {
    if (def.params.length) setSetup(def);
    else if (def.severity === "harsh") setConfirm(def);
    else run.mutate({ def, params: {} });
  };
  const running = run.isPending ? run.variables?.def.id : undefined;

  if (!canManage)
    return (
      <div className="max-w-2xl">
        <PlayerData s={s} p={p} />
      </div>
    );

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="space-y-6">
        {!inGame && (
          <Callout title={`${p.name} is not in the game`}>{s.status === "running" ? "Management and fun actions need the player online." : "Start the server and let the player join to use management and fun actions."}</Callout>
        )}
        <ActionGroup group="manage" title="Manage" description="Move, heal and equip." enabled={inGame} running={running} onPick={pick} />
        <ActionGroup group="fun" title="Fun" description="Show, play and prank." enabled={inGame} running={running} onPick={pick} />
      </div>
      <div className="space-y-6">
        <Access s={s} p={p} />
        <PlayerData s={s} p={p} />
      </div>

      <ActionDialog def={setup} others={s.players.map((x) => x.name).filter((n) => n.toLowerCase() !== p.name.toLowerCase())} onClose={() => setSetup(null)} onRun={(def, params) => run.mutateAsync({ def, params })} />
      <ConfirmDialog
        open={!!confirm}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={`${confirm?.label}: ${p.name}?`}
        description={confirm?.description}
        confirmLabel={confirm?.label}
        destructive
        onConfirm={() => run.mutateAsync({ def: confirm!, params: {} })}
      />
    </div>
  );
}

// ---- management and fun ---------------------------------------------------------------------------

function ActionGroup({ group, title, description, enabled, running, onPick }: { group: PlayerActionGroup; title: string; description: string; enabled: boolean; running: string | undefined; onPick: (def: PlayerActionDef) => void }) {
  const defs = PLAYER_ACTIONS.filter((a) => a.group === group);
  const row = (a: PlayerActionDef) => {
    const Icon = ICONS[a.id] ?? Zap;
    const busy = running === a.id;
    return (
      <li key={a.id}>
        <button
          type="button"
          disabled={!enabled || running !== undefined}
          onClick={() => onPick(a)}
          className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
        >
          <span className={cn("grid size-8 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground [&_svg]:size-4", a.severity === "harsh" && "text-destructive")}>
            <Icon />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-medium">{a.label}</span>
            <span className="block text-xs text-muted-foreground">{a.description}</span>
          </span>
          {busy ? <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" /> : a.params.length ? <ChevronRight className="size-4 shrink-0 text-muted-foreground" /> : <span className="shrink-0 text-xs text-muted-foreground">Run</span>}
        </button>
      </li>
    );
  };
  const mild = defs.filter((a) => a.severity === "mild");
  const harsh = defs.filter((a) => a.severity === "harsh");
  return (
    <Section title={title} description={description}>
      <Panel className="overflow-hidden">
        <ul className="divide-y divide-border">
          {mild.map(row)}
          {harsh.length > 0 && (
            <li aria-hidden className="bg-muted/40 px-4 py-1.5 text-xs font-medium text-muted-foreground">
              Drastic
            </li>
          )}
          {harsh.map(row)}
        </ul>
      </Panel>
    </Section>
  );
}

const customKey = "__custom__";

function initialValue(p: PlayerActionParam, others: string[]): string {
  if (p.kind === "number") return String(p.default);
  if (p.kind === "select") return p.default;
  if (p.kind === "player") return others[0] ?? "";
  return "";
}

function paramInvalid(p: PlayerActionParam, v: string): boolean {
  if (p.kind === "text") return !p.optional && !v.trim();
  if (p.kind === "number") {
    const n = Number(v);
    return v.trim() === "" || !Number.isFinite(n) || n < p.min || n > p.max || (!!p.integer && !Number.isInteger(n));
  }
  return !v.trim();
}

function ActionDialog({ def, others, onClose, onRun }: { def: PlayerActionDef | null; others: string[]; onClose: () => void; onRun: (def: PlayerActionDef, params: PlayerActionValues) => Promise<unknown> }) {
  return (
    <Dialog open={!!def} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>{def && <ActionForm key={def.id} def={def} others={others} onClose={onClose} onRun={onRun} />}</DialogContent>
    </Dialog>
  );
}

function ActionForm({ def, others, onClose, onRun }: { def: PlayerActionDef; others: string[]; onClose: () => void; onRun: (def: PlayerActionDef, params: PlayerActionValues) => Promise<unknown> }) {
  const [values, setValues] = React.useState<Record<string, string>>(() => Object.fromEntries(def.params.map((p) => [p.key, initialValue(p, others)])));
  const [custom, setCustom] = React.useState<Record<string, boolean>>({});
  const [busy, setBusy] = React.useState(false);
  const set = (key: string, v: string) => setValues((cur) => ({ ...cur, [key]: v }));
  const invalid = def.params.some((p) => paramInvalid(p, values[p.key] ?? ""));
  const harsh = def.severity === "harsh";

  // Numbers that follow each other share a row (coordinates, duration and level).
  const groups: PlayerActionParam[][] = [];
  for (const p of def.params) {
    const last = groups[groups.length - 1];
    if (p.kind === "number" && last && last[0].kind === "number") last.push(p);
    else groups.push([p]);
  }

  const field = (p: PlayerActionParam, first: boolean) => {
    const id = `action-${def.id}-${p.key}`;
    const v = values[p.key] ?? "";
    let input: React.ReactNode;
    if (p.kind === "text") {
      input = <Input id={id} value={v} onChange={(e) => set(p.key, e.target.value)} maxLength={p.max} placeholder={p.placeholder} autoFocus={first} />;
    } else if (p.kind === "number") {
      input = <Input id={id} type="number" inputMode={p.integer ? "numeric" : "decimal"} value={v} min={p.min} max={p.max} step={p.step ?? (p.integer ? 1 : "any")} onChange={(e) => set(p.key, e.target.value)} />;
    } else if (p.kind === "player") {
      input = others.length ? (
        <NativeSelect id={id} value={v} onChange={(e) => set(p.key, e.target.value)}>
          {others.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </NativeSelect>
      ) : (
        <p className="rounded-md border border-dashed border-border px-3 py-2 text-[13px] text-muted-foreground">Nobody else is online.</p>
      );
    } else {
      const typed = !!custom[p.key];
      input = (
        <div className="space-y-2">
          <NativeSelect
            id={id}
            value={typed ? customKey : v}
            onChange={(e) => {
              const pick = e.target.value === customKey;
              setCustom((cur) => ({ ...cur, [p.key]: pick }));
              set(p.key, pick ? "" : e.target.value);
            }}
          >
            {p.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
            {p.custom && <option value={customKey}>Other id…</option>}
          </NativeSelect>
          {typed && <Input value={v} onChange={(e) => set(p.key, e.target.value.trim().toLowerCase())} placeholder="namespace:id" aria-label={`${p.label} id`} maxLength={80} autoFocus className="font-mono" />}
        </div>
      );
    }
    const label = p.kind === "number" && p.unit ? `${p.label} (${p.unit})` : p.label;
    return (
      <Field key={p.key} label={label} htmlFor={id} help={p.help}>
        {input}
      </Field>
    );
  };

  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        if (invalid || busy) return;
        setBusy(true);
        try {
          await onRun(
            def,
            Object.fromEntries(def.params.map((p) => [p.key, p.kind === "number" ? Number(values[p.key]) : (values[p.key] ?? "").trim()])),
          );
          onClose();
        } catch {
          // The failure is already shown as a toast; keep the form so the values can be corrected.
        } finally {
          setBusy(false);
        }
      }}
    >
      <DialogHeader title={def.label} description={def.description} />
      {groups.map((g, i) =>
        g.length > 1 ? (
          <div key={i} className={cn("grid gap-3", g.length === 2 ? "grid-cols-2" : "grid-cols-3")}>
            {g.map((p) => field(p, false))}
          </div>
        ) : (
          field(g[0], i === 0)
        ),
      )}
      <DialogFooter>
        <Button type="button" variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" variant={harsh ? "destructive" : "default"} disabled={invalid} loading={busy}>
          {def.label}
        </Button>
      </DialogFooter>
    </form>
  );
}

// ---- access ---------------------------------------------------------------------------------------

function Access({ s, p }: { s: ServerDetail; p: PlayerProfile }) {
  const canOp = useCan("server.configure");
  const act = usePlayerActions(s.id);
  const [dialog, setDialog] = React.useState<{ action: "kick" | "ban"; name: string } | null>(null);
  const [confirmOp, setConfirmOp] = React.useState(false);
  const inGame = s.status === "running" && p.online;
  return (
    <Card title="Access" hint="Who may join, and what they may do when they do.">
      <ul className="-my-3 divide-y divide-border">
        <ControlRow title="Whitelist" description={p.whitelisted ? "Listed: can join when enforcement is on." : "Not listed."}>
          <Switch checked={p.whitelisted} disabled={act.isPending} onCheckedChange={(on) => act.mutate({ action: on ? "whitelist-add" : "whitelist-remove", name: p.name })} aria-label="Whitelisted" />
        </ControlRow>
        {canOp && (
          <ControlRow title="Operator" description={p.opLevel !== null ? `Level ${p.opLevel}: can use powerful in-game commands.` : "In-game command permissions. Not dashboard access."}>
            {p.opLevel !== null ? (
              <Button size="xs" variant="secondary" onClick={() => act.mutate({ action: "deop", name: p.name })}>
                <ShieldOff /> Revoke
              </Button>
            ) : (
              <Button size="xs" variant="secondary" onClick={() => setConfirmOp(true)}>
                <Crown /> Make operator…
              </Button>
            )}
          </ControlRow>
        )}
        {inGame && (
          <ControlRow title="Kick" description="Disconnect them; they may rejoin.">
            <Button size="xs" variant="secondary" onClick={() => setDialog({ action: "kick", name: p.name })}>
              <LogOut /> Kick…
            </Button>
          </ControlRow>
        )}
        <ControlRow title={p.ban ? "Banned" : "Ban"} description={p.ban ? (p.ban.reason ?? "No reason given") : "Disconnect and keep them out until unbanned."}>
          {p.ban ? (
            <Button size="xs" variant="secondary" onClick={() => act.mutate({ action: "pardon", name: p.name })}>
              <UserPlus /> Unban
            </Button>
          ) : (
            <Button size="xs" variant="destructive-ghost" onClick={() => setDialog({ action: "ban", name: p.name })}>
              <Ban /> Ban…
            </Button>
          )}
        </ControlRow>
      </ul>
      <ReasonDialog state={dialog} onClose={() => setDialog(null)} onSubmit={async (reason) => void (await act.mutateAsync({ action: dialog!.action, name: dialog!.name, reason: reason || undefined }))} />
      <ConfirmDialog
        open={confirmOp}
        onOpenChange={setConfirmOp}
        title={`Make ${p.name} an operator?`}
        description="Operators can use powerful in-game commands such as /gamemode, /give and /stop."
        confirmLabel="Grant operator"
        onConfirm={() => act.mutateAsync({ action: "op", name: p.name })}
      />
    </Card>
  );
}

function ControlRow({ title, description, children }: { title: string; description: React.ReactNode; children: React.ReactNode }) {
  return (
    <li className="flex items-center justify-between gap-4 py-3">
      <div className="min-w-0">
        <p className="text-[13px] font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">
          {description}
        </p>
      </div>
      <div className="shrink-0">{children}</div>
    </li>
  );
}

// ---- player data ----------------------------------------------------------------------------------

function Subhead({ children, aside }: { children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <div className="mb-1.5 flex items-baseline justify-between gap-3">
      <h4 className="text-xs font-medium text-muted-foreground">{children}</h4>
      {aside && <span className="text-xs text-muted-foreground">{aside}</span>}
    </div>
  );
}

/** Flags worth a chip: what is switched on, and the one that is notable when it is off. */
const chip = (f: PlayerInspect["flags"][number]) => (f.id === "mayBuild" ? (f.on ? null : "Can't build") : f.on ? f.label : null);

/** What Minecraft and plugins keep about the player: ability flags, scoreboard tags, effects and plugin data. */
function PlayerData({ s, p }: { s: ServerDetail; p: PlayerProfile }) {
  const q = useQuery({
    queryKey: ["inspect", s.id, p.name],
    queryFn: () => api.get<PlayerInspect>(`/api/servers/${s.id}/players/${encodeURIComponent(p.name)}/inspect`),
    refetchInterval: p.online && s.status === "running" ? 5_000 : false,
    retry: (count, err) => !(err instanceof ApiError && err.status === 404) && count < 2,
  });
  const [raw, setRaw] = React.useState(false);

  if (q.isPending) return <Skeleton className="h-64 rounded-xl" />;
  if (q.error)
    return (
      <Card title="Player data">
        <p className="text-[13px] text-muted-foreground">{q.error instanceof ApiError && q.error.status === 404 ? "Minecraft has not saved data for this player yet. It appears after they have been in the game." : (q.error as Error).message}</p>
      </Card>
    );
  const d = q.data;
  const chips = d.flags.map(chip).filter((c): c is string => !!c);

  return (
    <Card title="Player data" aside={d.source === "game" ? <LiveTag /> : d.savedAt ? `saved ${timeAgo(d.savedAt)}` : undefined}>
      <div className="space-y-5">
        <div>
          <Subhead>Flags</Subhead>
          {chips.length ? (
            <div className="flex flex-wrap gap-1.5">
              {chips.map((c) => (
                <Badge key={c} variant="outline">
                  {c}
                </Badge>
              ))}
            </div>
          ) : (
            <p className="text-[13px] text-muted-foreground">Nothing unusual.</p>
          )}
        </div>

        <div>
          <Subhead aside="/tag">Tags</Subhead>
          {d.tags.length ? (
            <div className="flex flex-wrap gap-1.5">
              {d.tags.map((t) => (
                <Badge key={t} variant="outline" className="font-mono">
                  {t}
                </Badge>
              ))}
            </div>
          ) : (
            <p className="text-[13px] text-muted-foreground">No scoreboard tags.</p>
          )}
        </div>

        <div>
          <Subhead>Effects</Subhead>
          {d.effects.length ? (
            <ul className="space-y-1 text-[13px]">
              {d.effects.map((e) => (
                <li key={e.id} className="flex items-baseline justify-between gap-3">
                  <span>
                    {prettyId(e.id)}
                    {e.level > 1 ? ` ${e.level}` : ""}
                  </span>
                  <span className="font-mono text-xs tabular-nums text-muted-foreground">{e.seconds === null ? "infinite" : formatPlaytime(e.seconds * 1000)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[13px] text-muted-foreground">No active effects.</p>
          )}
        </div>

        {d.values.length > 0 && (
          <dl className="divide-y divide-border">
            {d.values.map((v) => (
              <Row key={v.label} label={v.label}>
                <span className="font-mono text-xs">{v.value}</span>
              </Row>
            ))}
          </dl>
        )}

        <div>
          <Subhead aside={d.plugins.length ? `${d.plugins.length} ${d.plugins.length === 1 ? "plugin" : "plugins"}` : undefined}>Plugin data</Subhead>
          {d.plugins.length ? (
            <div className="space-y-1.5">
              {d.plugins.map((g) => (
                <details key={g.namespace} className="group rounded-md border border-border">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-md px-3 py-2 text-[13px] hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                    <span className="flex items-center gap-1.5 font-mono text-xs">
                      <ChevronRight className="size-3.5 text-muted-foreground transition-transform group-open:rotate-90" />
                      {g.namespace}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {g.entries.length} {g.entries.length === 1 ? "entry" : "entries"}
                    </span>
                  </summary>
                  <dl className="divide-y divide-border border-t border-border px-3">
                    {g.entries.map((e) => (
                      <div key={e.key} className="flex items-baseline justify-between gap-4 py-1.5">
                        <dt className="shrink-0 font-mono text-xs text-muted-foreground">{e.key}</dt>
                        <dd className="min-w-0 break-all text-right font-mono text-xs">{e.value}</dd>
                      </div>
                    ))}
                  </dl>
                </details>
              ))}
            </div>
          ) : (
            <p className="text-[13px] text-muted-foreground">Nothing stored by plugins. Paper-based servers keep it on the player.</p>
          )}
        </div>

        <Button variant="secondary" size="sm" onClick={() => setRaw(true)}>
          View raw data
        </Button>
      </div>

      <Dialog open={raw} onOpenChange={setRaw}>
        <DialogContent wide>
          <DialogHeader title={`${p.name}: raw data`} description="As Minecraft stores it, without inventory, ender chest and recipe book." />
          <pre className="scrollbar-thin max-h-[60vh] overflow-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-xs leading-relaxed">{d.raw}</pre>
          <DialogFooter>
            <CopyButton value={d.raw} label="Copy" />
            <Button variant="secondary" onClick={() => setRaw(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
