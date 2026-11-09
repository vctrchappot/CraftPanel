"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Globe, Lock } from "lucide-react";
import { Badge, Button, Callout, Field, NativeSelect, Panel, Section, Skeleton, Textarea } from "@craftpanel/ui";
import { api } from "@/lib/api";
import { useAction } from "@/lib/queries";
import { useSystem } from "./home";
import { CopyButton } from "./server/workspace";

type Policy = "local" | "private" | "any";

const KIND_LABEL = { local: "This computer", lan: "Local network", vpn: "VPN", virtual: "Virtual adapter" } as const;

const POLICY_HELP: Record<Policy, string> = {
  local: "Other devices get an “access not allowed” page, even if the dashboard listens on the network.",
  private:
    "Home and office networks (10.x, 172.16–31.x, 192.168.x), VPNs such as Tailscale (100.64.0.0/10) and private IPv6 ranges. Requests from public internet addresses are refused, which also protects you if the port is forwarded by accident.",
  any: "Anyone who can reach the port may try to sign in. Only use this behind HTTPS with strong passwords; for teams a VPN is usually the better choice.",
};

const code = (s: string) => <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">{s}</code>;

export function RemoteAccess() {
  const settings = useQuery({ queryKey: ["app-settings"], queryFn: () => api.get<{ dashboardAccess: Policy; allowedNetworks: string[] }>("/api/settings") });
  const system = useSystem();
  const diagnostics = useQuery({
    queryKey: ["deployment-diagnostics"],
    queryFn: () => api.get<{ ok: boolean; checks: { id: string; status: "ok" | "warning" | "error"; message: string; hint?: string }[] }>("/api/system/diagnostics"),
  });
  const [form, setForm] = React.useState<{ policy: Policy; networks: string } | null>(null);
  React.useEffect(() => {
    if (settings.data && !form) setForm({ policy: settings.data.dashboardAccess, networks: settings.data.allowedNetworks.join("\n") });
  }, [settings.data, form]);
  const save = useAction(
    () =>
      api.put("/api/settings", {
        dashboardAccess: form!.policy,
        allowedNetworks: form!.networks
          .split(/[\s,]+/)
          .map((n) => n.trim())
          .filter(Boolean),
      }),
    { success: "Access rules saved. They apply immediately.", invalidate: [["app-settings"]] },
  );

  const d = system.data?.dashboard;
  if (!form || !d) return <Skeleton className="h-64 rounded-xl" />;
  const hasLan = d.urls.some((u) => u.kind === "lan" || u.kind === "vpn");
  const urls = d.urls.filter((u) => u.kind !== "virtual" || !hasLan);
  const encrypted = d.transportSecure;

  return (
    <div className="max-w-3xl space-y-8">
      <Section
        title="Where the dashboard is reachable"
        description={`Profile “${d.profile}” · listening on ${d.host}:${d.port} · this connection uses ${encrypted ? "HTTPS" : "plain HTTP"}.`}
      >
        {d.publicUrl && <Panel className="mb-3 flex items-center justify-between gap-3 p-4 text-[13px]">
          <div className="min-w-0"><p className="text-xs text-muted-foreground">Dashboard address for your team</p><p className="break-all font-mono">{d.publicUrl}</p></div>
          <CopyButton value={d.publicUrl} />
        </Panel>}
        {d.behindProxy && <p className="mb-3 text-[13px] text-muted-foreground">The addresses below are internal backend addresses. Forwarding headers are accepted only from {d.trustedProxies.join(", ")}. Configure CRAFTPANEL_PUBLIC_URL with the external HTTPS address to share.</p>}
        <Panel>
          <ul className="divide-y divide-border">
            {urls.map((u) => (
              <li key={u.url} className="flex items-center gap-3 px-4 py-2.5 text-[13px]">
                {d.https ? <Lock className="size-4 shrink-0 text-success" /> : <Globe className="size-4 shrink-0 text-muted-foreground" />}
                <span className="min-w-0 flex-1 truncate font-mono text-xs" title={u.interface}>
                  {u.url}
                </span>
                <Badge variant={u.kind === "vpn" ? "info" : undefined}>{u.label ?? KIND_LABEL[u.kind]}</Badge>
                <CopyButton value={u.url} />
              </li>
            ))}
          </ul>
        </Panel>
        {d.loopbackOnly && (
          <Callout className="mt-3">
            The dashboard only listens on this computer. To open it from other devices, restart CraftPanel with the {code("lan")} profile ({code("pnpm start:lan")}, or {code("CRAFTPANEL_PROFILE=lan")} for the Linux service).
            Restarting CraftPanel currently saves and stops its Minecraft servers. Enable “Start with CraftPanel” on servers that should come back automatically.
          </Callout>
        )}
        {!d.loopbackOnly && !encrypted && (
          <Callout variant="warning" className="mt-3">
            Other devices connect over plain HTTP, so passwords travel unencrypted. That is fine on a trusted home network or inside a VPN; for anything else use HTTPS (see below).
          </Callout>
        )}
      </Section>

      <Section title="Who may connect" description={`Checked on every request and live connection, effective immediately. This computer is always allowed. Your address: ${d.clientIp}`}>
        <div className="space-y-4">
          <Field label="Allowed networks" htmlFor="access-policy">
            <NativeSelect id="access-policy" value={form.policy} onChange={(e) => setForm({ ...form, policy: e.target.value as Policy })} className="max-w-md">
              <option value="local">This computer only</option>
              <option value="private">Private networks and VPNs (recommended)</option>
              <option value="any">Anywhere, including the internet</option>
            </NativeSelect>
          </Field>
          <p className="max-w-2xl text-[13px] text-muted-foreground">{POLICY_HELP[form.policy]}</p>
          <Field
            label="Additional allowed addresses"
            htmlFor="access-networks"
            help="One IP address or CIDR range per line, for example an office's public IP (203.0.113.7) or range (198.51.100.0/24). Always allowed, whatever the setting above."
          >
            <Textarea id="access-networks" rows={3} value={form.networks} onChange={(e) => setForm({ ...form, networks: e.target.value })} placeholder="203.0.113.7" className="max-w-md font-mono text-xs" />
          </Field>
          {form.policy === "any" && !encrypted && <Callout variant="danger">Without HTTPS, passwords and session cookies would cross the internet unencrypted. Set up HTTPS first.</Callout>}
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={form.policy === "any" && (!encrypted || !d.secureCookies)}>
            Save access rules
          </Button>
        </div>
      </Section>

      <Section title="Deployment checks" description="Checks run on the host as the CraftPanel service account. They do not change settings or restart servers." actions={<Button variant="secondary" size="sm" onClick={() => void diagnostics.refetch()} loading={diagnostics.isFetching}>Check again</Button>}>
        {diagnostics.isLoading ? <Skeleton className="h-24 rounded-xl" /> : diagnostics.error ? <Callout variant="warning">Could not load deployment checks. Try again.</Callout> : <Panel className="divide-y divide-border">
          {diagnostics.data?.checks.map((check) => <div key={check.id} className="flex items-start gap-3 p-4 text-[13px]">
            <Badge variant={check.status === "error" ? "danger" : check.status === "warning" ? "warning" : "success"}>{check.status}</Badge>
            <div className="min-w-0"><p className="break-words">{check.message}</p>{check.hint && <p className="mt-1 text-xs text-muted-foreground">{check.hint}</p>}</div>
          </div>)}
        </Panel>}
      </Section>

      <Section title="Giving a team access from other networks">
        <div className="grid gap-3 text-[13px] sm:grid-cols-3">
          <Panel className="space-y-1.5 p-4">
            <p className="font-medium">VPN (recommended)</p>
            <p className="text-muted-foreground">
              Install Tailscale or WireGuard here and on your team's devices. Everyone opens the dashboard at its VPN address, nothing is exposed to the internet and no port forwarding is needed. Works with the default rule.
            </p>
          </Panel>
          <Panel className="space-y-1.5 p-4">
            <p className="font-medium">HTTPS reverse proxy</p>
            <p className="text-muted-foreground">
              Put Caddy or nginx with a real certificate in front, use the {code("proxy")} profile and set {code("CRAFTPANEL_PUBLIC_URL")}. For a proxy on another host, set {code("CRAFTPANEL_TRUSTED_PROXIES")} to its address and restrict the backend port to that host. Open the HTTPS address before allowing public access.
            </p>
          </Panel>
          <Panel className="space-y-1.5 p-4">
            <p className="font-medium">Built-in HTTPS</p>
            <p className="text-muted-foreground">
              Set {code("CRAFTPANEL_TLS_CERT")} and {code("CRAFTPANEL_TLS_KEY")} to PEM files (for example from {code("tailscale cert")} or Let's Encrypt) and restart. Secure cookies are turned on automatically.
            </p>
          </Panel>
        </div>
        <p className="mt-3 text-[13px] text-muted-foreground">Give each person their own account with the lowest role that fits (Settings → Users). Never port-forward the dashboard over plain HTTP.</p>
      </Section>
    </div>
  );
}
