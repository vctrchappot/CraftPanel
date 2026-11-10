"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Globe, Home, Info, Radar, ShieldCheck, XCircle } from "lucide-react";
import { Button, Callout, ChoiceCard, Field, Input, NativeSelect, Panel, Section, Skeleton } from "@craftpanel/ui";
import type { NetworkAddressKind, ServerDetail } from "@craftpanel/shared";
import { api } from "@/lib/api";
import { useCan } from "@/lib/auth";
import { connectEntries, type ConnectionAddresses } from "@/lib/network";
import { useAction } from "@/lib/queries";
import { CopyButton } from "./workspace";

interface NetworkInfo {
  mode: "lan" | "wan";
  port: number;
  bindAddress: string;
  lan: { interface: string; address: string; kind: NetworkAddressKind; label: string }[];
  addresses: ConnectionAddresses;
  publicIp: string | null;
  ddnsDomain: string | null;
  running: boolean;
}
interface Diagnosis {
  publicIp: string | null;
  portBoundLocally: boolean;
  cgnatLikely: boolean;
  findings: { level: "ok" | "warn" | "error" | "info"; message: string }[];
}

export function NetworkTab({ server: s }: { server: ServerDetail }) {
  const q = useQuery({ queryKey: ["network", s.id], queryFn: () => api.get<NetworkInfo>(`/api/servers/${s.id}/network`) });
  const canManage = useCan("network.manage");
  const [form, setForm] = React.useState<{ mode: "lan" | "wan"; port: number; bindAddress: string } | null>(null);
  React.useEffect(() => {
    if (q.data && !form) setForm({ mode: q.data.mode, port: q.data.port, bindAddress: q.data.bindAddress });
  }, [q.data, form]);
  const save = useAction(() => api.put(`/api/servers/${s.id}/network`, form!), { success: s.status === "running" ? "Saved. Restart to apply." : "Network settings saved", invalidate: [["network", s.id], ["server", s.id], ["servers"]] });
  const [diag, setDiag] = React.useState<Diagnosis | null>(null);
  const diagnose = useAction((lookup: boolean) => api.post<Diagnosis>(`/api/servers/${s.id}/network/diagnose?lookupPublicIp=${lookup}`), { onSuccess: setDiag });

  if (!q.data || !form) return <Skeleton className="h-96 rounded-lg" />;
  const n = q.data;
  const portSuffix = n.port === 25565 ? "" : `:${n.port}`;
  // The router forwards to the real LAN address, never to a WSL, Docker or VPN adapter.
  const forwardTarget = n.lan.find((a) => a.kind === "lan")?.address;

  return (
    <div className="grid gap-10 lg:grid-cols-2">
      <div className="space-y-10">
        <Section title="How players connect">
          <Panel className="divide-y divide-border text-[13px]">
            {connectEntries(n.addresses).map((a) => (
              <AddressRow key={a.address} label={a.label} value={a.address} />
            ))}
            <AddressRow label="This computer" value={n.addresses.local} />
            {n.mode === "wan" && n.publicIp && <AddressRow label="Internet (public IP)" value={`${n.publicIp}${portSuffix}`} />}
            {n.mode === "wan" && n.ddnsDomain && <AddressRow label="Internet (DDNS)" value={`${n.ddnsDomain}${portSuffix}`} />}
          </Panel>
          <p className="text-xs text-muted-foreground">In Minecraft: Multiplayer → Add Server → enter the address.</p>
        </Section>

        {canManage && (
          <Section title="Settings" description="Changes apply after a restart.">
            <div role="group" aria-label="Who can join" className="grid grid-cols-2 gap-2">
              {(["lan", "wan"] as const).map((m) => (
                <ChoiceCard key={m} selected={form.mode === m} onClick={() => setForm({ ...form, mode: m })} className="flex items-center gap-2 p-3 text-[13px] font-medium">
                  {m === "lan" ? <Home className="size-4" /> : <Globe className="size-4" />}
                  {m === "lan" ? "Local network" : "Internet"}
                </ChoiceCard>
              ))}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Port" htmlFor="nport">
                <Input id="nport" type="number" min={1024} max={65535} value={form.port} onChange={(e) => setForm({ ...form, port: Number(e.target.value) })} />
              </Field>
              <Field label="Bind address" htmlFor="nbind">
                <NativeSelect id="nbind" value={form.bindAddress} onChange={(e) => setForm({ ...form, bindAddress: e.target.value })}>
                  <option value="">All interfaces</option>
                  <option value="127.0.0.1">127.0.0.1 (this computer only)</option>
                  {n.lan.map((a) => (
                    <option key={a.address} value={a.address}>
                      {a.address} ({a.kind === "lan" ? a.interface : `${a.label}, ${a.interface}`})
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            </div>
            <Button onClick={() => save.mutate()} loading={save.isPending}>
              Save network settings
            </Button>
          </Section>
        )}
      </div>

      <div className="space-y-10">
        {form.mode === "lan" ? (
          <Section title="Local network checklist">
            <ol className="list-decimal space-y-2 pl-5 text-[13px] text-muted-foreground">
              <li>Players must be on the same Wi-Fi/LAN as this computer.</li>
              <li>
                Allow Java through the firewall for private networks. On Windows, accept the firewall prompt the first time the server starts, or add an inbound rule for TCP port {n.port}. On Linux with ufw: <code className="font-mono">sudo ufw allow {n.port}/tcp</code>.
              </li>
              <li>Guest or isolated Wi-Fi networks usually block connections between devices.</li>
            </ol>
          </Section>
        ) : (
          <Section title="Internet access guide">
            <ol className="list-decimal space-y-2 pl-5 text-[13px] text-muted-foreground">
              <li>Give this computer a fixed LAN address ({forwardTarget ?? "see above"}) in your router&apos;s DHCP settings.</li>
              <li>
                Create a port forwarding rule: external TCP port {n.port} → {forwardTarget ?? "this computer"}:{n.port}. CraftPanel does not change router settings automatically.
              </li>
              <li>Allow TCP port {n.port} in this computer&apos;s firewall.</li>
              <li>Share your public address (or a DDNS name, configurable in Settings) with players.</li>
            </ol>
            <Callout icon={<ShieldCheck />} title="Only the game port is exposed">
              Forward only the Minecraft port. The CraftPanel dashboard should never be forwarded to the internet; use a VPN or a private network for remote administration.
            </Callout>
          </Section>
        )}

        <Section title="Diagnostics" description="Checks run on this machine. Looking up your public IP contacts api.ipify.org.">
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={() => diagnose.mutate(false)} loading={diagnose.isPending && diagnose.variables === false}>
              <Radar /> Run local checks
            </Button>
            <Button variant="secondary" size="sm" onClick={() => diagnose.mutate(true)} loading={diagnose.isPending && diagnose.variables === true}>
              <Globe /> Check public IP & CGNAT
            </Button>
          </div>
          {diag && (
            <Panel className="divide-y divide-border">
              {diag.findings.map((f, i) => (
                <div key={i} className="flex gap-3 px-4 py-3 text-[13px]">
                  {f.level === "ok" ? <CheckCircle2 className="size-4 shrink-0 text-success" /> : f.level === "error" ? <XCircle className="size-4 shrink-0 text-destructive" /> : f.level === "warn" ? <AlertTriangle className="size-4 shrink-0 text-warning" /> : <Info className="size-4 shrink-0 text-muted-foreground" />}
                  <p>{f.message}</p>
                </div>
              ))}
            </Panel>
          )}
        </Section>
      </div>
    </div>
  );
}

function AddressRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2 px-4 py-3">
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="truncate font-mono">{value}</p>
      </div>
      <CopyButton value={value} />
    </div>
  );
}
