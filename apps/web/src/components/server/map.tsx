"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Copy, ExternalLink, Map, Pause, Play, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge, Button, Callout, ConfirmDialog, EmptyState, Field, Input, NativeSelect, Panel, Section, Skeleton, Switch } from "@craftpanel/ui";
import { mapSettingsSchema, SOFTWARE_INFO, type MapSettings, type MapStatus, type ServerDetail } from "@craftpanel/shared";
import { api, API_BASE, errorMessage } from "@/lib/api";
import { useCan } from "@/lib/auth";
import { useAction } from "@/lib/queries";
import { formatBytes } from "@/lib/format";

export function useMap(server: ServerDetail) {
  return useQuery({ queryKey: ["map", server.id], queryFn: () => api.get<MapStatus>(`/api/servers/${server.id}/map`),
    enabled: !!SOFTWARE_INFO[server.software].addons && !SOFTWARE_INFO[server.software].proxy,
    refetchInterval: (q) => q.state.data?.setupStage ? 2000 : 15_000 });
}

/** An optional plugin in Browse; setup progress stays here until the map page is ready. */
export function MapPlugin({ server: s, discovery = false }: { server: ServerDetail; discovery?: boolean }) {
  const q = useMap(s);
  const canManage = useCan("map.manage");
  const [confirm, setConfirm] = React.useState(false);
  const activate = useAction(() => api.post(`/api/servers/${s.id}/map/install`, { acceptMojangEula: true }), {
    success: "Setting up the world map…", invalidate: [["map", s.id], ["plugins", s.id], ["server", s.id]],
  });
  const m = q.data;
  if (!m?.supported || !canManage || (!discovery && !m.installed && !m.setupStage && !m.setupError)) return null;
  const stage = m.setupStage === "installing" ? "Installing and configuring BlueMap…" : m.setupStage === "starting" ? "Starting the server…" : "Preparing the map and downloading textures…";
  return <Panel id="world-map-plugin" className="mb-4 flex flex-wrap items-start gap-4 p-4">
    <Map className="mt-1 size-5 shrink-0 text-muted-foreground" />
    <div className="min-w-0 flex-1 space-y-1">
      <p className="flex flex-wrap items-center gap-2 font-medium">World map <span className="text-sm font-normal text-muted-foreground">BlueMap</span>{m.pageReady && <Badge variant="success">Active</Badge>}</p>
      <p className="text-[13px] text-muted-foreground">Explore your world in 2D and 3D. CraftPanel handles installation, updates to the map and sharing. The Map tab appears when it is ready.</p>
      {m.setupStage && <p className="text-[13px]" role="status">{stage} The first setup can take several minutes.</p>}
      {m.setupError && <p className="text-[13px] text-destructive" role="alert">{m.setupError}</p>}
      {m.installed && !m.pageReady && !m.setupStage && <p className="text-[13px] text-muted-foreground">Waiting for BlueMap. Activate to finish setup and start the server.</p>}
    </div>
    {m.pageReady ? <Button asChild size="sm" variant="secondary"><Link href={`/server/?id=${s.id}&tab=map`}>Open map</Link></Button> :
      <Button size="sm" variant="secondary" disabled={!!m.setupStage || !s.eulaAccepted} loading={activate.isPending || !!m.setupStage} onClick={() => setConfirm(true)}>{m.setupError ? "Retry activation" : "Activate"}</Button>}
    <ConfirmDialog open={confirm} onOpenChange={setConfirm} title="Activate the world map?" confirmLabel="Accept and activate" description={<>
      <p>CraftPanel installs a compatible BlueMap version, configures it and starts{s.status === "running" ? " (restarts)" : ""} this Minecraft server. Connected players will be disconnected during a restart.</p>
      <p className="mt-3">BlueMap downloads Minecraft textures from Mojang. By activating, you agree to the <a className="underline" href="https://aka.ms/MinecraftEULA" target="_blank" rel="noreferrer">Mojang EULA</a> for this download.</p>
      <p className="mt-3">Initial limits: 3,000 blocks around 0, 0, one render thread and 5 GB of map data. Sign-in is required until you enable public sharing.</p>
    </>} onConfirm={() => activate.mutateAsync()} />
  </Panel>;
}

export function MapTab({ server: s }: { server: ServerDetail }) {
  const q = useMap(s);
  const canManage = useCan("map.manage");
  const [draft, setDraft] = React.useState<MapSettings | null>(null);
  const [password, setPassword] = React.useState<string | undefined>();
  const [rerender, setRerender] = React.useState(false);
  const [remove, setRemove] = React.useState(false);
  const [deleteData, setDeleteData] = React.useState(false);
  const inv = [["map", s.id], ["map-link", s.id], ["plugins", s.id]];
  const save = useAction((settings: MapSettings) => {
    const parsed = mapSettingsSchema.safeParse({ ...settings, ...(password !== undefined ? { password } : {}) });
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "Check the map settings");
    return api.put(`/api/servers/${s.id}/map`, parsed.data);
  }, { success: "Map settings saved", invalidate: inv, onSuccess: () => { setDraft(null); setPassword(undefined); } });
  const action = useAction((value: string) => api.post(`/api/servers/${s.id}/map/action`, { action: value }), { success: "Map command sent", invalidate: inv });
  const uninstall = useAction(() => api.del(`/api/servers/${s.id}/map?deleteData=${deleteData}`), { success: "World map removed", invalidate: inv });
  const viewer = useQuery({ queryKey: ["map-link", s.id], queryFn: () => api.post<{ url: string }>(`/api/servers/${s.id}/map/link`), enabled: !!q.data?.pageReady && !!q.data.webserver, refetchInterval: 45 * 60_000 });
  if (q.isLoading) return <Skeleton className="h-64 rounded-lg" />;
  if (q.error || !q.data) return <Callout variant="danger">{errorMessage(q.error)}</Callout>;
  const m = q.data;
  if (!m.pageReady) return <EmptyState title="The world map is not active" description="Activate World map under Plugins → Browse. The Map tab appears after setup finishes." />;
  const c = draft ?? m.settings;
  const edit = (patch: Partial<MapSettings>) => setDraft({ ...c, ...patch });
  const url = viewer.data ? API_BASE + viewer.data.url : null;
  return <div className="space-y-8">
    <Section title="World map" description="Pan and zoom to explore. Use the viewer's controls to switch between flat, perspective and free-flight views. Saved changes to the world are rendered automatically; large areas take time to catch up." actions={<>
      <Badge variant={m.webserver ? "success" : "warning"}>{m.webserver ? "Available" : "Server offline / map loading"}</Badge>
      {url && <Button asChild size="sm" variant="secondary"><a href={url} target="_blank" rel="noreferrer"><ExternalLink /> Open full screen</a></Button>}
    </>}>
      {viewer.error && <Callout variant="danger">{errorMessage(viewer.error)}</Callout>}
      {m.webserver && url ? (API_BASE ? <Callout>Open the full-screen map to explore it.</Callout> : <iframe title="World map" src={url} className="h-[min(70vh,700px)] min-h-96 w-full rounded-lg border border-border" referrerPolicy="no-referrer" allow="fullscreen" />) : <Callout>Start the Minecraft server to view the map. BlueMap may need a few minutes to load its resources.</Callout>}
      <p className="text-xs text-muted-foreground">{formatBytes(m.diskBytes)} of map data · {m.threads} render thread{m.threads === 1 ? "" : "s"} · {m.settings.radius ? `±${m.settings.radius.toLocaleString()} blocks around ${m.settings.centerX}, ${m.settings.centerZ}` : "Entire generated world"}</p>
      {!!m.warnings.length && <Callout variant="warning"><ul className="list-disc space-y-1 pl-4">{m.warnings.map((w) => <li key={w}>{w}</li>)}</ul></Callout>}
    </Section>
    {canManage && <>
      <Section title="Rendering" description="Only existing terrain is rendered. The map never generates new Minecraft chunks. The disk limit is checked every 30 seconds and can be exceeded between checks.">
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" disabled={!m.serverRunning || action.isPending} onClick={() => action.mutate(m.paused || m.diskLimitHit ? "resume" : "pause")}>{m.paused || m.diskLimitHit ? <Play /> : <Pause />}{m.paused || m.diskLimitHit ? "Resume rendering" : "Pause rendering"}</Button>
          <Button size="sm" variant="secondary" disabled={!m.serverRunning || action.isPending} onClick={() => action.mutate("update")}><RefreshCw /> Update changed areas</Button>
          <Button size="sm" variant="secondary" disabled={!m.serverRunning || action.isPending} onClick={() => setRerender(true)}>Re-render map</Button>
        </div>
        {m.rerenderRequired && <Callout variant="warning">Detail or visibility changed. Re-render the map to replace existing tiles with the new settings.</Callout>}
      </Section>
      <form className="max-w-3xl space-y-8" onSubmit={(e) => { e.preventDefault(); save.mutate(c); }}>
        <Section title="Area and detail" description="The area is a square, applied in each dimension's own block coordinates. The Nether ceiling is omitted so the terrain below it is visible.">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Radius in blocks (0 = entire world)" htmlFor="map-radius"><Input id="map-radius" type="number" min={0} max={30000000} value={c.radius} onChange={(e) => edit({ radius: Number(e.target.value) })} /></Field>
            <Field label="Detail" htmlFor="map-detail"><NativeSelect id="map-detail" value={c.detail} onChange={(e) => edit({ detail: e.target.value as MapSettings["detail"] })}><option value="3d">2D + 3D (all blocks)</option><option value="2d">2D only (smaller and faster)</option></NativeSelect></Field>
            <Field label="Centre X" htmlFor="map-x"><Input id="map-x" type="number" value={c.centerX} onChange={(e) => edit({ centerX: Number(e.target.value) })} /></Field>
            <Field label="Centre Z" htmlFor="map-z"><Input id="map-z" type="number" value={c.centerZ} onChange={(e) => edit({ centerZ: Number(e.target.value) })} /></Field>
          </div>
          <div className="flex flex-wrap gap-5">{([['overworld', 'Overworld'], ['nether', 'Nether'], ['end', 'The End']] as const).map(([key, label]) => <label key={key} className="flex items-center gap-2 text-sm"><Switch checked={c[key]} onCheckedChange={(v) => edit({ [key]: v })} />{label}</label>)}</div>
          <Setting label="Include underground caves" description="Adds underground blocks in the Overworld; increases render time and map size." checked={c.caves} change={(v) => edit({ caves: v })} />
          <Setting label="Only inhabited chunks" description="Skip chunks where players have spent less than 30 seconds nearby." checked={c.visitedOnly} change={(v) => edit({ visitedOnly: v })} />
        </Section>
        <Section title="Resource limits">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Render speed" htmlFor="map-speed"><NativeSelect id="map-speed" value={c.speed} onChange={(e) => edit({ speed: e.target.value as MapSettings["speed"] })}><option value="gentle">Gentle · 1 thread</option><option value="balanced">Balanced · about half the CPU cores</option><option value="fast">Fast · leave 1 CPU core for the game</option></NativeSelect></Field>
            <Field label="Map disk limit, MB (0 = unlimited)" htmlFor="map-disk"><Input id="map-disk" type="number" min={0} max={10000000} value={c.maxDiskMb} onChange={(e) => edit({ maxDiskMb: Number(e.target.value) })} /></Field>
            <Field label="Pause at this many players (0 = never)" htmlFor="map-players-limit"><Input id="map-players-limit" type="number" min={0} max={100000} value={c.pauseAtPlayers} onChange={(e) => edit({ pauseAtPlayers: Number(e.target.value) })} /></Field>
          </div>
        </Section>
        <Section title="Sharing and player privacy" description={`Reachable from ${m.reach}. A public map can only be opened by people who can reach this CraftPanel installation.`}>
          <Field label="Who can explore?" htmlFor="map-access"><NativeSelect id="map-access" value={c.access} onChange={(e) => edit({ access: e.target.value as MapSettings["access"] })}><option value="login">CraftPanel users with access to this server</option><option value="public">Anyone with the map link</option></NativeSelect></Field>
          {c.access === "public" && <Field label={m.passwordSet ? "New map password (leave untouched to keep it)" : "Optional map password"} htmlFor="map-password"><Input id="map-password" type="password" autoComplete="new-password" minLength={6} maxLength={128} value={password ?? ""} onChange={(e) => { setPassword(e.target.value); setDraft(c); }} placeholder={m.passwordSet ? "Password is set" : "At least 6 characters, or leave empty"} /></Field>}
          {c.access === "public" && m.passwordSet && <Button type="button" size="sm" variant="secondary" onClick={() => { setPassword(""); setDraft(c); }}>Remove map password</Button>}
          <Setting label="Show live players" description="Visitors can see player names and current positions." checked={c.players} change={(v) => edit({ players: v })} />
          <Setting label="Hide sneaking players" description="Invisible, vanished and spectator players are always hidden." checked={c.hideSneaking} change={(v) => edit({ hideSneaking: v })} />
          {m.settings.access === "public" && <Button type="button" variant="secondary" size="sm" onClick={async () => { try { await navigator.clipboard.writeText(new URL(API_BASE + m.url, window.location.origin).href); toast.success("Public map link copied"); } catch { toast.error("Could not copy the link"); } }}><Copy /> Copy public map link</Button>}
        </Section>
        <div className="flex gap-2"><Button type="submit" loading={save.isPending} disabled={!draft && password === undefined}>Save settings</Button>{draft && <Button type="button" variant="ghost" onClick={() => { setDraft(null); setPassword(undefined); }}>Discard</Button>}</div>
      </form>
      <Section title="Remove world map" description="Stop the Minecraft server first. Removing the plugin hides the Map tab."><Button variant="destructive-ghost" size="sm" disabled={m.serverRunning || !!m.setupStage} onClick={() => setRemove(true)}><Trash2 /> Remove map plugin</Button></Section>
    </>}
    <ConfirmDialog open={rerender} onOpenChange={setRerender} title="Re-render the map?" description="Deletes rendered tiles and recreates them from the current world. The map is incomplete while rendering; Minecraft world files are kept." confirmLabel="Re-render" onConfirm={() => action.mutateAsync("rerender")} />
    <ConfirmDialog open={remove} onOpenChange={setRemove} title="Remove the world map?" description={<><p>Removes BlueMap and its CraftPanel page. Minecraft worlds are kept.</p><label className="mt-3 flex items-center gap-2"><Switch checked={deleteData} onCheckedChange={setDeleteData} />Also delete rendered map data and settings</label></>} confirmLabel="Remove" destructive onConfirm={() => uninstall.mutateAsync()} />
  </div>;
}

function Setting({ label, description, checked, change }: { label: string; description: string; checked: boolean; change: (v: boolean) => void }) {
  return <label className="flex items-start justify-between gap-4"><span className="space-y-1"><span className="block text-sm font-medium">{label}</span><span className="block text-[13px] text-muted-foreground">{description}</span></span><Switch checked={checked} onCheckedChange={change} /></label>;
}
