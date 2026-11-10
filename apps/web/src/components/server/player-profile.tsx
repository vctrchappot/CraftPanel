"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Ban, ChevronDown, Crown, LogOut, Save, ShieldOff, UserMinus, UserPlus } from "lucide-react";
import {
  Badge,
  Button,
  Callout,
  ConfirmDialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  Progress,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  cn,
} from "@craftpanel/ui";
import { prettyId, type ItemStack, type PlayerProfile, type PlayerState, type PlayerStats, type ServerDetail } from "@craftpanel/shared";
import { api, ApiError } from "@/lib/api";
import { useCan } from "@/lib/auth";
import { useRealtimeEvent } from "@/lib/realtime";
import { useAction } from "@/lib/queries";
import { formatDate, formatDateTime, formatDistance, formatNumber, formatPlaytime, timeAgo } from "@/lib/format";
import { advancementName, mainKiller, playerInsights, travelDistances } from "@/lib/player-insights";
import { eventStyle } from "@/lib/activity";
import { CopyButton } from "./workspace";
import { BarList, Card, DailyBars, Heatmap, Hearts, ItemIconsProvider, ItemSlot, KpiGrid, Pips, SlotGrid } from "./player-charts";
import { PlayerAvatar, ReasonDialog, usePlayerActions } from "./player-parts";

const DIMENSIONS: Record<string, string> = { "minecraft:overworld": "Overworld", "minecraft:the_nether": "Nether", "minecraft:the_end": "The End" };
const dimension = (d: string | null) => (d ? (DIMENSIONS[d] ?? prettyId(d)) : "Unknown");
const coords = (p: { x: number; y: number; z: number }) => `${Math.round(p.x)} ${Math.round(p.y)} ${Math.round(p.z)}`;
const sum = (n: { cm: number }[]) => n.reduce((a, b) => a + b.cm, 0);

export function PlayerProfileView({ server: s, name }: { server: ServerDetail; name: string }) {
  const canManage = useCan("players.manage");
  const canOp = useCan("server.configure");
  const act = usePlayerActions(s.id);
  const q = useQuery({
    queryKey: ["player", s.id, name],
    queryFn: () => api.get<PlayerProfile>(`/api/servers/${s.id}/players/${encodeURIComponent(name)}/profile?tz=${new Date().getTimezoneOffset()}`),
    // An online player is asked of the running game every few seconds; otherwise the files only change on a save.
    refetchInterval: (query) => (query.state.data?.online ? 5_000 : s.status === "running" ? 20_000 : false),
    retry: (count, err) => !(err instanceof ApiError && err.status === 404) && count < 2,
  });
  useRealtimeEvent((m) => m.type === "players" && m.serverId === s.id && void q.refetch());
  // "5 minutes ago" and "online for 49 min" keep moving between refreshes.
  useTick(30_000);
  const [dialog, setDialog] = React.useState<{ action: "kick" | "ban"; name: string } | null>(null);
  const [confirmOp, setConfirmOp] = React.useState(false);

  const back = (
    <Link href={`/server/?id=${s.id}&tab=players`} scroll={false} className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground">
      <ArrowLeft className="size-3.5" /> Players
    </Link>
  );

  if (q.error instanceof ApiError && q.error.status === 404)
    return (
      <div className="space-y-6">
        {back}
        <EmptyState title={`${name} is unknown on this server`} description="CraftPanel has no session for this name and it is on no whitelist, operator or ban list." />
      </div>
    );
  if (q.error) return <div className="space-y-6">{back}<Callout variant="danger" title="Could not load the player">{(q.error as Error).message}</Callout></div>;
  if (!q.data)
    return (
      <div className="space-y-6">
        {back}
        <Skeleton className="h-24 rounded-lg" />
        <Skeleton className="h-64 rounded-lg" />
      </div>
    );
  const p = q.data;
  const live = s.status === "running";

  return (
    <ItemIconsProvider value={s.id}>
    <div className="space-y-6">
      {back}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-center gap-4">
          <PlayerAvatar name={p.name} uuid={p.uuid} size={64} className="shrink-0 rounded-lg border border-border" />
          <div className="min-w-0 space-y-1.5">
            <div className="flex flex-wrap items-center gap-2.5">
              <h2 className="truncate text-2xl font-medium tracking-tight">{p.name}</h2>
              {p.online ? <Badge variant="success">Online</Badge> : <Badge>Offline</Badge>}
              {p.opLevel !== null && (
                <Badge variant="warning">
                  <Crown /> Operator {p.opLevel}
                </Badge>
              )}
              {p.whitelisted && <Badge variant="outline">Whitelisted</Badge>}
              {p.ban && <Badge variant="danger">Banned</Badge>}
            </div>
            <p className="text-[13px] text-muted-foreground">
              {p.online && p.onlineSince ? `Online for ${formatPlaytime(Date.now() - p.onlineSince)}` : p.lastSeen ? `Last seen ${timeAgo(p.lastSeen)}` : "Never joined while CraftPanel managed this server"}
              {p.firstSeen ? ` · first seen ${formatDate(p.firstSeen)}` : ""}
            </p>
          </div>
        </div>
        {canManage && (
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {p.online && (
              <Button variant="secondary" onClick={() => setDialog({ action: "kick", name: p.name })}>
                <LogOut /> Kick
              </Button>
            )}
            {p.ban ? (
              <Button variant="secondary" onClick={() => act.mutate({ action: "pardon", name: p.name })} loading={act.isPending && act.variables?.action === "pardon"}>
                <UserPlus /> Unban
              </Button>
            ) : (
              <Button variant="secondary" onClick={() => setDialog({ action: "ban", name: p.name })}>
                <Ban /> Ban
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="secondary" aria-label="More actions">
                  More <ChevronDown />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem onSelect={() => act.mutate({ action: p.whitelisted ? "whitelist-remove" : "whitelist-add", name: p.name })}>
                  {p.whitelisted ? <UserMinus /> : <UserPlus />} {p.whitelisted ? "Remove from whitelist" : "Add to whitelist"}
                </DropdownMenuItem>
                {canOp && (
                  <>
                    <DropdownMenuSeparator />
                    {p.opLevel !== null ? (
                      <DropdownMenuItem onSelect={() => act.mutate({ action: "deop", name: p.name })}>
                        <ShieldOff /> Revoke operator
                      </DropdownMenuItem>
                    ) : (
                      <DropdownMenuItem onSelect={() => setConfirmOp(true)}>
                        <Crown /> Make operator…
                      </DropdownMenuItem>
                    )}
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </div>

      {p.ban && (
        <Callout variant="danger" icon={<Ban />} title="This player is banned">
          {p.ban.reason ?? "No reason given"}
          {p.ban.created ? ` · ${p.ban.created}` : ""}
          {p.ban.source ? ` · by ${p.ban.source}` : ""}
        </Callout>
      )}

      <Tabs defaultValue="overview" className="space-y-6">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="inventory">Inventory</TabsTrigger>
          <TabsTrigger value="statistics">Statistics</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          <Overview p={p} />
        </TabsContent>
        <TabsContent value="inventory">
          <Inventory p={p} live={live} serverId={s.id} />
        </TabsContent>
        <TabsContent value="statistics">
          <Statistics p={p} live={live} serverId={s.id} />
        </TabsContent>
        <TabsContent value="activity">
          <Activity p={p} canManage={canManage} />
        </TabsContent>
      </Tabs>

      <ReasonDialog state={dialog} onClose={() => setDialog(null)} onSubmit={async (reason) => void (await act.mutateAsync({ action: dialog!.action, name: dialog!.name, reason: reason || undefined }))} />
      <ConfirmDialog
        open={confirmOp}
        onOpenChange={setConfirmOp}
        title={`Make ${p.name} an operator?`}
        description="Operators can use powerful in-game commands such as /gamemode, /give and /stop."
        confirmLabel="Grant operator"
        onConfirm={() => act.mutateAsync({ action: "op", name: p.name })}
      />
    </div>
    </ItemIconsProvider>
  );
}

/** Re-render every `ms`, so relative times stay right on a page that isn't refetching. */
function useTick(ms: number) {
  const [, set] = React.useState(0);
  React.useEffect(() => {
    const t = setInterval(() => set((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

/** A pulsing dot and the word "live": the numbers beside it come from the running game. */
function LiveTag() {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="relative flex size-2">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-status-running opacity-60 motion-reduce:animate-none" />
        <span className="relative inline-flex size-2 rounded-full bg-status-running" />
      </span>
      live
    </span>
  );
}

/** Asks the server to write everything to disk now, so files-based figures catch up. */
function SaveNow({ serverId }: { serverId: string }) {
  const qc = useQueryClient();
  const save = useAction(() => api.post(`/api/servers/${serverId}/command`, { command: "save-all flush" }), {
    success: "Saving the world…",
    // The command returns before the files are written.
    onSuccess: () => void setTimeout(() => void qc.invalidateQueries({ queryKey: ["player", serverId] }), 2500),
  });
  return (
    <Button size="xs" variant="ghost" onClick={() => save.mutate()} loading={save.isPending}>
      <Save /> Save now
    </Button>
  );
}

/**
 * Where the numbers come from and how fresh they are. `kind` "state" (inventory, position) is live for an online
 * player; "stats" (statistics, advancements) only exist in Minecraft's files, which it writes on saves and when a
 * player leaves.
 */
function SavedNote({ p, live, serverId, kind }: { p: PlayerProfile; live: boolean; serverId: string; kind: "state" | "stats" }) {
  const canCommand = useCan("console.command");
  if (kind === "state" && p.stateSource === "game")
    return (
      <p className="text-xs text-muted-foreground">
        <LiveTag /> · asked of the running game every few seconds.
      </p>
    );
  if (!p.savedAt) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      <p>
        From Minecraft's files in “{p.world}”, as of the last save {timeAgo(p.savedAt)}.{live && p.online ? " They follow every world save and when the player leaves." : ""}
      </p>
      {live && p.online && canCommand && <SaveNow serverId={serverId} />}
    </div>
  );
}

function NoGameData({ what }: { what: string }) {
  return <EmptyState title={`No ${what} yet`} description="Minecraft writes this when the world is saved or the player leaves. It may also be missing on a different world, or if the player never joined it." />;
}

// ---- overview -------------------------------------------------------------------------------------

function Overview({ p }: { p: PlayerProfile }) {
  const s = p.stats;
  const insights = playerInsights(p);
  const travel = s ? travelDistances(s) : [];
  const distance = s ? sum(travel) : null;
  const gameTicks = s?.playTicks ?? null;
  return (
    <div className="space-y-6">
      <KpiGrid
        items={[
          { label: "Playtime", value: formatPlaytime(p.activity.playtimeMs), sub: gameTicks !== null ? `Minecraft counts ${formatPlaytime((gameTicks / 20) * 1000)}` : `${p.activity.sessions} ${p.activity.sessions === 1 ? "session" : "sessions"}` },
          { label: "Sessions", value: formatNumber(p.activity.sessions), sub: p.activity.sessions ? `avg ${formatPlaytime(p.activity.averageMs)}` : undefined },
          { label: "Deaths", value: s ? formatNumber(s.deaths) : "—", sub: s && mainKiller(s) ? `mostly ${prettyId(mainKiller(s)!.id)}` : undefined },
          { label: "Mob kills", value: s ? formatNumber(s.mobKills) : "—", sub: s ? `${s.playerKills} player ${s.playerKills === 1 ? "kill" : "kills"}` : undefined },
          { label: "Distance", value: distance !== null ? formatDistance(distance) : "—", sub: travel[0] ? `mostly ${travel[0].id.replaceAll("_", " ")}` : undefined },
          { label: "Advancements", value: p.advancements ? formatNumber(p.advancements.done) : "—", sub: p.advancements?.recent[0] ? `latest ${advancementName(p.advancements.recent[0].id)}` : undefined },
        ]}
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-6">
          <Card title="Playtime" hint="Time online per day, from CraftPanel's session log.">
            <DailyBars days={p.activity.daily} />
          </Card>
          {insights.length > 0 && (
            <Card title="What stands out">
              <ul className="space-y-2 text-[13px]">
                {insights.map((i) => (
                  <li key={i.id} className={cn("flex gap-2", i.tone === "warning" && "text-warning")}>
                    <span aria-hidden className="mt-[7px] size-1 shrink-0 rounded-full bg-current opacity-50" />
                    <span>{i.text}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
        <div className="space-y-6">
          {p.state ? <Vitals state={p.state} source={p.stateSource} online={p.online} /> : null}
          <Details p={p} />
        </div>
      </div>
    </div>
  );
}

function Vitals({ state, source, online }: { state: PlayerState; source: PlayerProfile["stateSource"]; online: boolean }) {
  return (
    <Card title="Status" aside={source === "game" ? <LiveTag /> : online ? "as of last save" : "when last saved"}>
      <div className="space-y-4">
        {state.health !== null && (
          <div className="space-y-1.5">
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>Health</span>
              <span className="font-mono tabular-nums">{Number.isInteger(state.health) ? state.health : state.health.toFixed(1)} / 20</span>
            </div>
            <Hearts health={state.health} />
          </div>
        )}
        {state.food !== null && (
          <div className="space-y-1.5">
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>Hunger</span>
              <span className="font-mono tabular-nums">{state.food} / 20</span>
            </div>
            <Pips value={state.food} className="bg-warning" />
          </div>
        )}
        {state.xpLevel !== null && (
          <div className="space-y-1.5">
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>Experience</span>
              <span className="font-mono tabular-nums">level {state.xpLevel}</span>
            </div>
            <Progress value={Math.round((state.xpProgress ?? 0) * 100)} />
          </div>
        )}
      </div>
    </Card>
  );
}

function Row({ label, children, wide }: { label: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2 text-[13px]">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className={cn("min-w-0 text-right", wide && "flex-1")}>{children}</dd>
    </div>
  );
}

function Details({ p }: { p: PlayerProfile }) {
  const st = p.state;
  return (
    <Card title="Details">
      <dl className="-my-2 divide-y divide-border">
        <Row label="UUID" wide>
          {p.uuid ? (
            <span className="flex min-w-0 items-center justify-end gap-1">
              <span className="truncate font-mono text-[11px]" title={p.uuid}>
                {p.uuid}
              </span>
              <CopyButton value={p.uuid} label="" />
            </span>
          ) : (
            "unknown"
          )}
        </Row>
        <Row label="First seen">{formatDateTime(p.firstSeen)}</Row>
        <Row label="Last seen">{p.online ? "now" : formatDateTime(p.lastSeen)}</Row>
        <Row label="Operator">{p.opLevel !== null ? `level ${p.opLevel}` : "no"}</Row>
        <Row label="Whitelist">{p.whitelisted ? "listed" : "not listed"}</Row>
        {st?.gameMode && <Row label="Game mode">{st.gameMode[0].toUpperCase() + st.gameMode.slice(1)}</Row>}
        {st?.pos && (
          <Row label="Position">
            <span className="inline-flex items-center gap-1">
              <span className="font-mono text-xs">
                {dimension(st.dimension)} · {coords(st.pos)}
              </span>
              <CopyButton value={coords(st.pos)} label="" />
            </span>
          </Row>
        )}
        {st?.spawn && (
          <Row label="Spawn point">
            <span className="font-mono text-xs">
              {dimension(st.spawn.dimension)} · {coords(st.spawn)}
            </span>
          </Row>
        )}
        {st?.lastDeath && (
          <Row label="Last death">
            <span className="font-mono text-xs">
              {dimension(st.lastDeath.dimension)} · {coords(st.lastDeath)}
            </span>
          </Row>
        )}
      </dl>
    </Card>
  );
}

// ---- inventory ------------------------------------------------------------------------------------

function Inventory({ p, live, serverId }: { p: PlayerProfile; live: boolean; serverId: string }) {
  const st = p.state;
  if (!st) return <NoGameData what="inventory data" />;
  const all = [...st.inventory, ...st.armor.filter((i): i is ItemStack => !!i), ...(st.offhand ? [st.offhand] : []), ...st.enderChest];
  const carried = st.inventory.length + st.armor.filter(Boolean).length + (st.offhand ? 1 : 0);
  const held = new Map<string, number>();
  for (const i of [...st.inventory, ...st.enderChest]) held.set(i.id, (held.get(i.id) ?? 0) + i.count);
  const enchanted = all.filter((i) => i.enchantments?.length);
  const ARMOR = ["Boots", "Leggings", "Chestplate", "Helmet"];
  const ARMOR_GHOST = ["Feet", "Legs", "Chest", "Head"];

  return (
    <div className="space-y-6">
      <SavedNote p={p} live={live} serverId={serverId} kind="state" />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-6">
          <Card title="Carrying" aside={`${carried} ${carried === 1 ? "stack" : "stacks"}`}>
            <div className="flex gap-4">
              <div className="w-[calc((100%-1rem)/10)] min-w-10 shrink-0 space-y-1.5">
                {[3, 2, 1, 0].map((i) => (
                  <ItemSlot key={i} item={st.armor[i] ?? null} label={ARMOR[i]} ghost={ARMOR_GHOST[i]} />
                ))}
                <div className="pt-1.5">
                  <ItemSlot item={st.offhand} label="Offhand" ghost="Off" />
                </div>
              </div>
              <div className="min-w-0 flex-1 space-y-3">
                <SlotGrid items={st.inventory} first={9} rows={3} label="Backpack slot" />
                <div className="border-t border-border pt-3">
                  <SlotGrid items={st.inventory} first={0} rows={1} selected={st.selectedSlot} label="Hotbar slot" />
                </div>
              </div>
            </div>
          </Card>
          <Card title="Ender chest" aside={`${st.enderChest.length} of 27 slots used`}>
            <SlotGrid items={st.enderChest} first={0} rows={3} label="Ender chest slot" />
          </Card>
        </div>
        <div className="space-y-6">
          <Card title="Most held" hint="Backpack, hotbar and ender chest together.">
            <BarList items={[...held].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([id, value]) => ({ label: prettyId(id), value, icon: id }))} empty="The inventory is empty." />
          </Card>
          <Card title="Enchanted gear" aside={enchanted.length ? String(enchanted.length) : undefined}>
            {enchanted.length ? (
              <ul className="space-y-2 text-[13px]">
                {enchanted.slice(0, 8).map((i, n) => (
                  <li key={`${i.slot}-${n}`}>
                    <p className="font-medium">{i.name ?? prettyId(i.id)}</p>
                    <p className="text-xs text-muted-foreground">{i.enchantments!.map((e) => `${prettyId(e.id)} ${e.level}`).join(" · ")}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[13px] text-muted-foreground">Nothing enchanted.</p>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

// ---- statistics -----------------------------------------------------------------------------------

/** Items and blocks get their picture; mobs (`icons` off) have none. */
const ranked = (rows: { id: string; count: number }[], icons = true) => rows.map((r) => ({ label: prettyId(r.id), value: r.count, icon: icons ? r.id : undefined }));

const HIGHLIGHT_LABEL: Record<string, string> = {
  fish_caught: "Fish caught",
  animals_bred: "Animals bred",
  traded_with_villager: "Villager trades",
  talked_to_villager: "Villager conversations",
  enchant_item: "Items enchanted",
  sleep_in_bed: "Nights slept",
  open_chest: "Chests opened",
  open_enderchest: "Ender chests opened",
  raid_win: "Raids won",
  bell_ring: "Bells rung",
  target_hit: "Targets hit",
  clean_armor: "Armor washed",
};

function Statistics({ p, live, serverId }: { p: PlayerProfile; live: boolean; serverId: string }) {
  const s = p.stats;
  const adv = p.advancements;
  if (!s && !adv) return <NoGameData what="statistics" />;
  return (
    <div className="space-y-6">
      <SavedNote p={p} live={live} serverId={serverId} kind="stats" />
      {s && <StatsBody s={s} />}
      {adv && (
        <div className="grid gap-6 md:grid-cols-2">
          <Card title="Advancements" aside={`${adv.done} done · ${adv.recipes} recipes unlocked`}>
            <BarList items={adv.categories.map((c) => ({ label: prettyId(c.id), value: c.done }))} />
          </Card>
          <Card title="Latest advancements">
            {adv.recent.length ? (
              <ul className="space-y-2 text-[13px]">
                {adv.recent.slice(0, 8).map((a) => (
                  <li key={a.id} className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0 truncate">{advancementName(a.id)}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{a.at ? timeAgo(a.at) : ""}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[13px] text-muted-foreground">None yet.</p>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}

function StatsBody({ s }: { s: PlayerStats }) {
  const travel = travelDistances(s);
  const distance = sum(travel);
  const ratio = s.damageTaken && s.damageDealt ? s.damageDealt / s.damageTaken : null;
  const otherDeaths = Math.max(0, s.deaths - s.totals.killedBy);
  return (
    <>
      <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
        <Card title="Combat" hint="Damage is counted in half hearts.">
          <dl className="-my-2 divide-y divide-border">
            <Row label="Mobs killed">{formatNumber(s.mobKills)}</Row>
            <Row label="Players killed">{formatNumber(s.playerKills)}</Row>
            <Row label="Deaths">{formatNumber(s.deaths)}</Row>
            <Row label="Damage dealt">{formatNumber(s.damageDealt)}</Row>
            <Row label="Damage taken">{formatNumber(s.damageTaken)}</Row>
            {ratio !== null && <Row label="Dealt per taken">{ratio < 0.01 ? "<0.01" : ratio < 1 ? ratio.toFixed(2) : ratio.toFixed(1)}×</Row>}
            {s.sinceDeathTicks !== null && <Row label="Alive for">{formatPlaytime((s.sinceDeathTicks / 20) * 1000)}</Row>}
          </dl>
        </Card>
        <Card title="Travel" aside={formatDistance(distance)}>
          <BarList items={travel.slice(0, 7).map((d) => ({ label: prettyId(d.id), value: d.cm, display: formatDistance(d.cm) }))} empty="Hasn't moved yet." />
        </Card>
        <Card title="Everyday" hint="Counters Minecraft keeps besides blocks and items.">
          <dl className="-my-2 divide-y divide-border">
            <Row label="Jumps">{formatNumber(s.jumps)}</Row>
            <Row label="Blocks mined">{formatNumber(s.totals.mined)}</Row>
            <Row label="Items crafted">{formatNumber(s.totals.crafted)}</Row>
            <Row label="Items picked up">{formatNumber(s.totals.pickedUp)}</Row>
            <Row label="Tools broken">{formatNumber(s.totals.broken)}</Row>
            {s.highlights.map((h) => (
              <Row key={h.id} label={HIGHLIGHT_LABEL[h.id] ?? prettyId(h.id)}>
                {formatNumber(h.count)}
              </Row>
            ))}
          </dl>
        </Card>
      </div>
      <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
        <Card title="Blocks mined" aside={formatNumber(s.totals.mined)}>
          <BarList items={ranked(s.mined)} />
        </Card>
        <Card title="Items crafted" aside={formatNumber(s.totals.crafted)}>
          <BarList items={ranked(s.crafted)} />
        </Card>
        <Card title="Items used" hint="Placed blocks, tools swung, food eaten." aside={formatNumber(s.totals.used)}>
          <BarList items={ranked(s.used)} />
        </Card>
        <Card title="Mobs killed" aside={formatNumber(s.mobKills)}>
          <BarList items={ranked(s.killed, false)} tone="bg-success" />
        </Card>
        <Card title="Killed by mobs" aside={formatNumber(s.totals.killedBy)} hint={otherDeaths ? `${otherDeaths} of ${s.deaths} deaths had other causes (falling, fire, drowning, …); Minecraft doesn't break those down.` : undefined}>
          <BarList items={ranked(s.killedBy, false)} tone="bg-destructive" empty="No death caused by a mob." />
        </Card>
        <Card title="Tools broken" aside={formatNumber(s.totals.broken)}>
          <BarList items={ranked(s.broken)} tone="bg-warning" />
        </Card>
      </div>
    </>
  );
}

// ---- activity -------------------------------------------------------------------------------------

function Activity({ p, canManage }: { p: PlayerProfile; canManage: boolean }) {
  const a = p.activity;
  const longest = Math.max(1, ...a.recent.map((r) => (r.leftAt ?? Date.now()) - r.joinedAt));
  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <Card title="When they play">
          <Heatmap heat={a.heat} />
        </Card>
        <Card title="Sessions" aside={formatNumber(a.sessions)}>
          <dl className="-my-2 divide-y divide-border">
            <Row label="Total playtime">{formatPlaytime(a.playtimeMs)}</Row>
            <Row label="Average session">{formatPlaytime(a.averageMs)}</Row>
            <Row label="Longest session">{formatPlaytime(a.longestMs)}</Row>
            {canManage && <Row label="Addresses">{a.addresses.length}</Row>}
          </dl>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Recent sessions" aside={a.sessions > a.recent.length ? `latest ${a.recent.length} of ${a.sessions}` : undefined}>
          {a.recent.length ? (
            <ul className="scrollbar-thin -my-2 max-h-[30rem] divide-y divide-border overflow-y-auto pr-1" tabIndex={0} aria-label="Recent sessions">
              {a.recent.map((r) => {
                const ms = (r.leftAt ?? Date.now()) - r.joinedAt;
                return (
                  <li key={r.id} className="space-y-1.5 py-2.5 text-[13px]">
                    <div className="flex items-baseline justify-between gap-3">
                      <span>{formatDateTime(r.joinedAt)}</span>
                      <span className="font-mono text-xs tabular-nums text-muted-foreground">{r.leftAt ? formatPlaytime(ms) : `online · ${formatPlaytime(ms)}`}</span>
                    </div>
                    <div className="h-1 overflow-hidden rounded-full bg-muted">
                      <div className={cn("h-full rounded-full", r.leftAt ? "bg-foreground" : "bg-status-running")} style={{ width: `${Math.max(2, (ms / longest) * 100)}%` }} />
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-[13px] text-muted-foreground">Sessions are recorded while CraftPanel manages the server.</p>
          )}
        </Card>

        <div className="space-y-6">
          <Card title="Addresses" hint="Where this player connected from.">
            {!canManage ? (
              <p className="text-[13px] text-muted-foreground">IP addresses are only shown to users who can manage players.</p>
            ) : a.addresses.length ? (
              <ul className="-my-2 divide-y divide-border">
                {a.addresses.map((x) => (
                  <li key={x.ip} className="flex items-baseline justify-between gap-3 py-2 text-[13px]">
                    <span className="font-mono text-xs">{x.ip}</span>
                    <span className="text-xs text-muted-foreground">
                      {x.sessions} {x.sessions === 1 ? "session" : "sessions"} · {timeAgo(x.lastSeen)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[13px] text-muted-foreground">No address recorded.</p>
            )}
          </Card>
          <Card title="Moderation and actions" hint="Kicks, bans and list changes made through CraftPanel.">
            {p.events.length ? (
              <ul className="-my-2 divide-y divide-border">
                {p.events.map((e) => (
                  <li key={e.id} className="flex items-baseline justify-between gap-3 py-2 text-[13px]">
                    <span className={cn("min-w-0", eventStyle(e).tone === "crashed" && "text-destructive")}>{e.message}</span>
                    <span className="shrink-0 text-xs text-muted-foreground" title={formatDateTime(e.createdAt)}>
                      {timeAgo(e.createdAt)}
                      {e.actor ? ` · ${e.actor}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[13px] text-muted-foreground">Nothing yet.</p>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
