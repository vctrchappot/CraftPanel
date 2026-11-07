"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Ban, Crown, LogOut, ShieldOff, UserMinus, UserPlus } from "lucide-react";
import { Button, Callout, ConfirmDialog, Dialog, DialogContent, DialogFooter, DialogHeader, Field, Input, Panel, Section, Skeleton, Switch, Tabs, TabsContent, TabsList, TabsTrigger } from "@craftpanel/ui";
import type { OnlinePlayer, ServerDetail } from "@craftpanel/shared";
import { api } from "@/lib/api";
import { useCan } from "@/lib/auth";
import { useAction } from "@/lib/queries";
import { useRealtimeEvent } from "@/lib/realtime";
import { formatDateTime, timeAgo } from "@/lib/format";

interface PlayersData {
  online: OnlinePlayer[];
  whitelist: { uuid: string; name: string }[];
  ops: { uuid: string; name: string; level: number }[];
  bans: { uuid?: string; name?: string; reason?: string; created?: string; source?: string }[];
  ipBans: { ip?: string; reason?: string; created?: string }[];
  whitelistEnabled: boolean;
  onlineMode: boolean;
  history: { id: number; name: string; uuid: string | null; ip: string | null; joinedAt: number; leftAt: number | null }[];
  live: boolean;
}

export function PlayersTab({ server: s }: { server: ServerDetail }) {
  const key = ["players", s.id];
  const q = useQuery({ queryKey: key, queryFn: () => api.get<PlayersData>(`/api/servers/${s.id}/players`) });
  const canManage = useCan("players.manage");
  const canOp = useCan("server.configure");
  useRealtimeEvent((m) => m.type === "players" && m.serverId === s.id && void q.refetch());

  const act = useAction((v: { action: string; name?: string; reason?: string; ip?: string; enabled?: boolean }) => api.post(`/api/servers/${s.id}/players/${v.action}`, { name: v.name, reason: v.reason, ip: v.ip, enabled: v.enabled }), {
    success: "Done",
    invalidate: [key],
  });
  const [dialog, setDialog] = React.useState<{ action: "kick" | "ban"; name: string } | null>(null);
  const [confirmOp, setConfirmOp] = React.useState<string | null>(null);

  if (!q.data) return <Skeleton className="h-64 rounded-xl" />;
  const d = q.data;

  return (
    <div className="space-y-8">
      {!d.live && <Callout title="Server is offline">Changes are written directly to the server's access lists and apply on the next start.</Callout>}
      <Section title={`Online (${d.online.length})`}>
        <Panel>
          {d.online.length ? (
            <ul className="divide-y divide-border">
              {d.online.map((p) => (
                <li key={p.name} className="flex flex-wrap items-center gap-3 px-4 py-3 text-[13px]">
                  <span className="flex size-6 items-center justify-center rounded bg-muted text-[11px] font-semibold uppercase">{p.name.slice(0, 1)}</span>
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{p.name}</p>
                    <p className="text-xs text-muted-foreground">
                      joined {timeAgo(p.joinedAt)}
                      {p.uuid ? ` · ${p.uuid}` : ""}
                    </p>
                  </div>
                  {canManage && (
                    <div className="flex gap-1">
                      <Button size="xs" variant="ghost" onClick={() => setDialog({ action: "kick", name: p.name })}>
                        <LogOut /> Kick
                      </Button>
                      <Button size="xs" variant="destructive-ghost" onClick={() => setDialog({ action: "ban", name: p.name })}>
                        <Ban /> Ban
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="p-4 text-[13px] text-muted-foreground">{d.live ? "Nobody is online." : "Server is not running."}</p>
          )}
        </Panel>
      </Section>

      <Tabs defaultValue="whitelist" className="space-y-4">
        <TabsList>
          <TabsTrigger value="whitelist">Whitelist ({d.whitelist.length})</TabsTrigger>
          <TabsTrigger value="ops">Operators ({d.ops.length})</TabsTrigger>
          <TabsTrigger value="bans">Bans ({d.bans.length + d.ipBans.length})</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>

        <TabsContent value="whitelist" className="space-y-4">
          <div className="flex items-center justify-between gap-4 rounded-lg border border-border px-4 py-3">
            <div>
              <p className="text-[13px] font-medium">Whitelist enforcement</p>
              <p className="text-xs text-muted-foreground">When on, only listed players can join.</p>
            </div>
            <Switch checked={d.whitelistEnabled} disabled={!canManage} onCheckedChange={(v) => act.mutate({ action: "whitelist-toggle", enabled: v })} />
          </div>
          {canManage && <AddPlayer label="Add to whitelist" onAdd={(name) => act.mutateAsync({ action: "whitelist-add", name })} />}
          <NameList
            items={d.whitelist.map((w) => ({ name: w.name, sub: w.uuid }))}
            empty="The whitelist is empty."
            action={canManage ? { label: "Remove", icon: <UserMinus />, run: (name) => act.mutate({ action: "whitelist-remove", name }) } : undefined}
          />
        </TabsContent>

        <TabsContent value="ops" className="space-y-4">
          <Callout icon={<Crown />} title="Minecraft operators are not CraftPanel users">
            Operator status grants in-game command permissions (level {d.ops[0]?.level ?? 4}). It does not give access to this dashboard. Dashboard access is managed under Settings → Users.
          </Callout>
          {canOp && <AddPlayer label="Grant operator" onAdd={async (name) => setConfirmOp(name)} />}
          <NameList
            items={d.ops.map((o) => ({ name: o.name, sub: `level ${o.level} · ${o.uuid}` }))}
            empty="No operators."
            action={canOp ? { label: "Revoke", icon: <ShieldOff />, run: (name) => act.mutate({ action: "deop", name }) } : undefined}
          />
        </TabsContent>

        <TabsContent value="bans" className="space-y-4">
          {canManage && <AddPlayer label="Ban player" onAdd={async (name) => setDialog({ action: "ban", name })} />}
          <NameList
            items={d.bans.map((b) => ({ name: b.name ?? b.uuid ?? "?", sub: `${b.reason ?? "No reason"}${b.created ? ` · ${b.created}` : ""}${b.source ? ` · by ${b.source}` : ""}` }))}
            empty="No banned players."
            action={canManage ? { label: "Unban", icon: <UserPlus />, run: (name) => act.mutate({ action: "pardon", name }) } : undefined}
          />
          <IpBans data={d.ipBans} canManage={canManage} onBan={(ip, reason) => act.mutateAsync({ action: "ip-ban", ip, reason })} onPardon={(ip) => act.mutate({ action: "ip-pardon", ip })} />
        </TabsContent>

        <TabsContent value="history">
          <Panel className="overflow-x-auto">
            {d.history.length ? (
              <table className="w-full min-w-[520px] text-[13px]">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="px-4 py-2 font-medium">Player</th>
                    <th className="px-4 py-2 font-medium">Joined</th>
                    <th className="px-4 py-2 font-medium">Left</th>
                    <th className="px-4 py-2 font-medium">IP</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {d.history.map((h) => (
                    <tr key={h.id}>
                      <td className="px-4 py-2 font-medium">{h.name}</td>
                      <td className="px-4 py-2 text-muted-foreground">{formatDateTime(h.joinedAt)}</td>
                      <td className="px-4 py-2 text-muted-foreground">{h.leftAt ? formatDateTime(h.leftAt) : "online"}</td>
                      <td className="px-4 py-2 font-mono text-xs text-muted-foreground">{h.ip ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="p-4 text-[13px] text-muted-foreground">Player sessions are recorded while CraftPanel manages the server.</p>
            )}
          </Panel>
        </TabsContent>
      </Tabs>

      <ReasonDialog
        state={dialog}
        onClose={() => setDialog(null)}
        onSubmit={async (reason) => {
          await act.mutateAsync({ action: dialog!.action, name: dialog!.name, reason: reason || undefined });
        }}
      />
      <ConfirmDialog
        open={!!confirmOp}
        onOpenChange={(o) => !o && setConfirmOp(null)}
        title={`Make ${confirmOp} an operator?`}
        description="Operators can use powerful in-game commands such as /gamemode, /give and /stop."
        confirmLabel="Grant operator"
        onConfirm={() => act.mutateAsync({ action: "op", name: confirmOp! })}
      />
    </div>
  );
}

function AddPlayer({ label, onAdd }: { label: string; onAdd: (name: string) => Promise<unknown> }) {
  const [name, setName] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const valid = /^[A-Za-z0-9_]{1,16}$/.test(name);
  return (
    <form
      className="flex max-w-md gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!valid) return;
        setBusy(true);
        try {
          await onAdd(name);
          setName("");
        } finally {
          setBusy(false);
        }
      }}
    >
      <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Minecraft username" aria-label="Minecraft username" maxLength={16} />
      <Button type="submit" variant="secondary" disabled={!valid} loading={busy}>
        {label}
      </Button>
    </form>
  );
}

function NameList({ items, empty, action }: { items: { name: string; sub?: string }[]; empty: string; action?: { label: string; icon: React.ReactNode; run: (name: string) => void } }) {
  return (
    <Panel>
      {items.length ? (
        <ul className="divide-y divide-border">
          {items.map((i) => (
            <li key={i.name} className="flex items-center gap-3 px-4 py-2.5 text-[13px]">
              <div className="min-w-0 flex-1">
                <p className="font-medium">{i.name}</p>
                {i.sub && <p className="truncate text-xs text-muted-foreground">{i.sub}</p>}
              </div>
              {action && (
                <Button size="xs" variant="ghost" onClick={() => action.run(i.name)}>
                  {action.icon} {action.label}
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="p-4 text-[13px] text-muted-foreground">{empty}</p>
      )}
    </Panel>
  );
}

function IpBans({ data, canManage, onBan, onPardon }: { data: { ip?: string; reason?: string }[]; canManage: boolean; onBan: (ip: string, reason?: string) => Promise<unknown>; onPardon: (ip: string) => void }) {
  const [ip, setIp] = React.useState("");
  return (
    <Section title="IP bans">
      {canManage && (
        <form
          className="flex max-w-md gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            await onBan(ip.trim());
            setIp("");
          }}
        >
          <Input value={ip} onChange={(e) => setIp(e.target.value)} placeholder="IP address" aria-label="IP address" />
          <Button type="submit" variant="secondary" disabled={!ip.trim()}>
            Ban IP
          </Button>
        </form>
      )}
      <NameList items={data.map((b) => ({ name: b.ip ?? "?", sub: b.reason }))} empty="No banned IP addresses." action={canManage ? { label: "Unban", icon: <UserPlus />, run: onPardon } : undefined} />
    </Section>
  );
}

function ReasonDialog({ state, onClose, onSubmit }: { state: { action: "kick" | "ban"; name: string } | null; onClose: () => void; onSubmit: (reason: string) => Promise<void> }) {
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => setReason(""), [state]);
  return (
    <Dialog open={!!state} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader title={state?.action === "ban" ? `Ban ${state.name}` : `Kick ${state?.name}`} description={state?.action === "ban" ? "The player is disconnected and cannot rejoin until unbanned." : "The player is disconnected but may rejoin."} />
        <Field label="Reason" htmlFor="reason" help="Optional. Shown to the player.">
          <Input id="reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} autoFocus />
        </Field>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={state?.action === "ban" ? "destructive" : "default"}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onSubmit(reason.trim());
                onClose();
              } finally {
                setBusy(false);
              }
            }}
          >
            {state?.action === "ban" ? "Ban player" : "Kick player"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
