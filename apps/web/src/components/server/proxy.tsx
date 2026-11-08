"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Eye, EyeOff, Info, KeyRound, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Badge, Button, Callout, ConfirmDialog, Field, Input, NativeSelect, Panel, Section, Skeleton } from "@craftpanel/ui";
import { softwareLabel, type ProxyBackend, type ProxyConfig, type ProxyOverview, type ServerDetail } from "@craftpanel/shared";
import { api, errorMessage } from "@/lib/api";
import { useCan } from "@/lib/auth";
import { useAction } from "@/lib/queries";
import { StatusBadge } from "../status";
import { ToggleRow } from "../wizard";

const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "server";

/** Velocity: which servers sit behind the proxy, in try order, and how forwarding is set up on each. */
export function ProxyTab({ server: s }: { server: ServerDetail }) {
  const canEdit = useCan("server.configure");
  const q = useQuery({ queryKey: ["proxy", s.id], queryFn: () => api.get<ProxyOverview>(`/api/servers/${s.id}/proxy`), refetchInterval: 15_000 });
  const [draft, setDraft] = React.useState<ProxyConfig | null>(null);
  const [adding, setAdding] = React.useState("");
  const save = useAction((c: ProxyConfig) => api.put<ProxyOverview>(`/api/servers/${s.id}/proxy`, c as never), {
    success: "Proxy settings saved",
    invalidate: [["proxy", s.id], ["servers"]],
    onSuccess: () => setDraft(null),
  });
  if (q.isLoading) return <Skeleton className="h-64 rounded-xl" />;
  if (q.error || !q.data) return <Callout variant="danger">{errorMessage(q.error)}</Callout>;
  const ov = q.data;
  const config = draft ?? ov.config;
  const edit = (c: Partial<ProxyConfig>) => setDraft({ ...config, ...c });
  const setBackend = (i: number, b: Partial<ProxyBackend>) => edit({ backends: config.backends.map((x, j) => (j === i ? { ...x, ...b } : x)) });
  const move = (i: number, d: -1 | 1) => {
    const list = [...config.backends];
    [list[i], list[i + d]] = [list[i + d], list[i]];
    edit({ backends: list });
  };
  const known = new Map([...ov.backends.map((b) => [b.serverId, b] as const)]);
  const candidates = ov.candidates.filter((c) => !config.backends.some((b) => b.serverId === c.id));
  const nameOf = (id: string) => known.get(id)?.serverName ?? ov.candidates.find((c) => c.id === id)?.name ?? id;

  return (
    <div className="max-w-3xl space-y-8">
      <Section
        title="Servers behind the proxy"
        description="Players connect to the proxy's port and join the first server in this list that is online. They switch with /server <name>. CraftPanel sets up Velocity's modern forwarding on each server."
      >
        {config.backends.length ? (
          <Panel>
            <ul className="divide-y divide-border">
              {config.backends.map((b, i) => {
                const st = known.get(b.serverId);
                return (
                  <li key={b.serverId} className="space-y-3 px-4 py-3.5 text-[13px]">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="w-5 text-muted-foreground tabular-nums">{i + 1}.</span>
                      <Link href={`/server/?id=${b.serverId}`} className="font-medium hover:underline">
                        {nameOf(b.serverId)}
                      </Link>
                      {st && (
                        <span className="text-muted-foreground">
                          {softwareLabel(st.software)} · port {st.port}
                        </span>
                      )}
                      {st && <StatusBadge status={st.status as never} />}
                      {st ? (
                        st.setup === "ready" ? (
                          <Badge variant="success">Forwarding ready</Badge>
                        ) : st.setup === "restart" ? (
                          <Badge variant="warning">Restart needed</Badge>
                        ) : (
                          <Badge variant="warning">Needs setup</Badge>
                        )
                      ) : (
                        <Badge>Not saved yet</Badge>
                      )}
                      {canEdit && (
                        <span className="ml-auto flex gap-1">
                          <Button size="sm" variant="ghost" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                            <ArrowUp />
                          </Button>
                          <Button size="sm" variant="ghost" aria-label="Move down" disabled={i === config.backends.length - 1} onClick={() => move(i, 1)}>
                            <ArrowDown />
                          </Button>
                          <Button size="sm" variant="ghost" aria-label="Remove" onClick={() => edit({ backends: config.backends.filter((_, j) => j !== i) })}>
                            <Trash2 />
                          </Button>
                        </span>
                      )}
                    </div>
                    <div className="grid gap-3 pl-7 sm:grid-cols-2">
                      <Field label="Name in /server" htmlFor={`pn-${i}`}>
                        <Input id={`pn-${i}`} value={b.name} disabled={!canEdit} maxLength={32} onChange={(e) => setBackend(i, { name: slug(e.target.value) })} className="font-mono text-xs" />
                      </Field>
                      <Field label="Forced host" htmlFor={`ph-${i}`} help="Optional, e.g. survival.example.com">
                        <Input
                          id={`ph-${i}`}
                          value={b.host ?? ""}
                          disabled={!canEdit}
                          maxLength={253}
                          placeholder="None"
                          onChange={(e) => setBackend(i, { host: e.target.value.trim() || undefined })}
                        />
                      </Field>
                    </div>
                    {st?.notes.map((n) => (
                      <p key={n} className="pl-7 text-xs text-muted-foreground">
                        {n}
                      </p>
                    ))}
                  </li>
                );
              })}
            </ul>
          </Panel>
        ) : (
          <p className="text-[13px] text-muted-foreground">No servers yet. Add the servers players should reach through this proxy.</p>
        )}
        {canEdit && (
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Add a server" htmlFor="padd" className="min-w-0 flex-1">
              <NativeSelect id="padd" value={adding} onChange={(e) => setAdding(e.target.value)} disabled={!candidates.length}>
                <option value="">{candidates.length ? "Choose a server" : "No other servers"}</option>
                {candidates.map((c) => (
                  <option key={c.id} value={c.id} disabled={c.software === "vanilla"}>
                    {c.name} ({softwareLabel(c.software)}, port {c.port}){c.software === "vanilla" ? " – needs Paper or Fabric" : ""}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Button
              variant="secondary"
              disabled={!adding}
              onClick={() => {
                const c = candidates.find((x) => x.id === adding)!;
                let name = slug(c.name);
                while (config.backends.some((b) => b.name === name)) name = `${name.slice(0, 29)}-${Math.floor(Math.random() * 90 + 10)}`;
                edit({ backends: [...config.backends, { serverId: c.id, name }] });
                setAdding("");
              }}
            >
              <Plus /> Add
            </Button>
          </div>
        )}
      </Section>

      <Section title="Security">
        <div className="space-y-5">
          <ToggleRow
            label="Authenticate players with Mojang"
            help="The proxy checks accounts (online mode). Turn off only for offline networks: anyone could then join as any name."
            checked={config.onlineMode}
            disabled={!canEdit}
            onChange={(v) => edit({ onlineMode: v })}
          />
          <ToggleRow
            label="Only reachable through the proxy"
            help="Binds the servers above to 127.0.0.1, so players can't bypass the proxy. Turn off if the proxy runs on another machine."
            checked={config.localOnly}
            disabled={!canEdit}
            onChange={(v) => edit({ localOnly: v })}
          />
          {!config.onlineMode && <Callout variant="danger">Offline mode lets people impersonate any player, including operators.</Callout>}
        </div>
      </Section>

      {canEdit && (
        <div className="flex items-center gap-3">
          <Button onClick={() => save.mutate(config)} loading={save.isPending} disabled={!draft}>
            Save and apply
          </Button>
          {draft && (
            <Button variant="ghost" onClick={() => setDraft(null)}>
              Discard changes
            </Button>
          )}
          <p className="text-xs text-muted-foreground">Running servers need a restart; the proxy reloads its server list by itself.</p>
        </div>
      )}

      {canEdit && <Secret server={s} />}
    </div>
  );
}

/** The forwarding secret: shown on request, regenerated with a confirmation. */
function Secret({ server: s }: { server: ServerDetail }) {
  const [shown, setShown] = React.useState(false);
  const [confirm, setConfirm] = React.useState(false);
  const q = useQuery({ queryKey: ["proxy-secret", s.id], queryFn: () => api.get<{ secret: string }>(`/api/servers/${s.id}/proxy/secret`), enabled: shown, staleTime: 0, gcTime: 0 });
  const regen = useAction(() => api.post(`/api/servers/${s.id}/proxy/secret`), {
    success: "New secret saved. Restart the proxy and its servers.",
    invalidate: [
      ["proxy", s.id],
      ["proxy-secret", s.id],
    ],
  });
  return (
    <Section
      title="Forwarding secret"
      description="Shared by the proxy and its servers so they only accept players forwarded by this proxy. CraftPanel writes it everywhere it is needed; you only need it for servers CraftPanel doesn't manage."
    >
      <div className="flex flex-wrap items-center gap-2">
        <Input readOnly value={shown ? (q.data?.secret ?? "…") : "••••••••••••••••••••••••••••••••"} className="max-w-sm font-mono text-xs" aria-label="Forwarding secret" />
        <Button size="sm" variant="secondary" onClick={() => setShown(!shown)}>
          {shown ? <EyeOff /> : <Eye />} {shown ? "Hide" : "Show"}
        </Button>
        <Button size="sm" variant="secondary" onClick={() => setConfirm(true)}>
          <RefreshCw /> New secret
        </Button>
      </div>
      <Callout icon={<Info />}>
        <span className="inline-flex items-center gap-1.5">
          <KeyRound className="size-3.5" /> Anyone with this secret who can reach a server's port can join it as any player. Keep it private.
        </span>
      </Callout>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Create a new forwarding secret?"
        description="CraftPanel writes it to the proxy and every server behind it. Players can't join until the proxy and the servers have been restarted."
        confirmLabel="Create new secret"
        onConfirm={() => regen.mutateAsync()}
      />
    </Section>
  );
}
