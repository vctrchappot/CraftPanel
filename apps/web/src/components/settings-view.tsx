"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Coffee, Download, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import {
  Badge,
  Button,
  Callout,
  Field,
  Input,
  NativeSelect,
  PageHeader,
  Panel,
  Section,
  Skeleton,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@craftpanel/ui";
import { CRAFTPANEL_AUTHOR, CRAFTPANEL_REPO_URL, CRAFTPANEL_SITE_URL, ROLE_LABELS, type JavaRuntimeInfo } from "@craftpanel/shared";
import { api, errorMessage } from "@/lib/api";
import { useAuth, useCan } from "@/lib/auth";
import { useAction } from "@/lib/queries";
import { formatDateTime } from "@/lib/format";
import { useSystem } from "./home";
import { RemoteAccess } from "./remote-access";
import { UpdateSection } from "./updates";
import { SessionsSection, TwoFactorSection } from "./account-security";
import { UsersAdmin } from "./users-admin";
import { NotificationSettings } from "./notifications-settings";
import { AssistantSettingsSection } from "./assistant-settings";

export function SettingsView() {
  const params = useSearchParams();
  const canOwner = useCan("app.configure");
  const canAudit = useCan("audit.view");
  const sections: [string, string][] = [
    ["account", "Account"],
    ...(canOwner ? ([["users", "Users"], ["backups", "Backups"], ["access", "Remote access"], ["network", "Dynamic DNS"], ["notifications", "Notifications"], ["assistant", "AI assistant"]] as [string, string][]) : []),
    ["java", "Java"],
    ...(canAudit ? ([["audit", "Audit log"]] as [string, string][]) : []),
    ["about", "Security & about"],
  ];
  return (
    <div className="space-y-6">
      <PageHeader title="Settings" description="Application-wide configuration. Per-server settings live in each server's Settings tab." />
      {/* Nine sections do not fit one row: a side list on wide screens (like a server's Settings tab),
          a swipeable row without a scrollbar on narrow ones. Only the active section is mounted. */}
      <Tabs key={params.get("tab") ?? "account"} defaultValue={params.get("tab") ?? "account"} className="grid gap-6 lg:grid-cols-[180px_minmax(0,1fr)] lg:gap-8">
        <TabsList
          indicatorClassName="bg-muted shadow-none"
          className="flex h-auto min-w-0 justify-start gap-1 overflow-x-auto overflow-y-hidden rounded-none bg-transparent p-0 [scrollbar-width:none] lg:sticky lg:top-6 lg:flex-col lg:items-stretch lg:self-start lg:overflow-visible [&::-webkit-scrollbar]:hidden"
        >
          {sections.map(([value, label]) => (
            <TabsTrigger
              key={value}
              value={value}
              className="h-auto shrink-0 justify-start px-2.5 py-1.5 text-muted-foreground hover:bg-muted/60 hover:text-foreground data-[state=active]:font-medium data-[state=active]:hover:bg-transparent"
            >
              {label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="account">
          <Account />
        </TabsContent>
        <TabsContent value="users">{canOwner && <UsersAdmin />}</TabsContent>
        <TabsContent value="backups">{canOwner && <BackupSettings />}</TabsContent>
        <TabsContent value="access">{canOwner && <RemoteAccess />}</TabsContent>
        <TabsContent value="network">{canOwner && <DdnsSettings />}</TabsContent>
        <TabsContent value="notifications">{canOwner && <NotificationSettings />}</TabsContent>
        <TabsContent value="assistant">{canOwner && <AssistantSettingsSection />}</TabsContent>
        <TabsContent value="java">
          <JavaRuntimes />
        </TabsContent>
        <TabsContent value="audit">{canAudit && <AuditLog />}</TabsContent>
        <TabsContent value="about">
          <About />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Account() {
  const { state } = useAuth();
  const [cur, setCur] = React.useState("");
  const [next, setNext] = React.useState("");
  const change = useAction(() => api.post("/api/auth/password", { currentPassword: cur, newPassword: next }), {
    success: "Password changed. Other sessions were signed out.",
    onSuccess: () => (setCur(""), setNext("")),
  });
  return (
    <div className="max-w-2xl space-y-6">
      <Section title="Your account">
        <p className="text-[13px]">
          Signed in as <span className="font-medium">{state?.user?.username}</span> · {state?.user && ROLE_LABELS[state.user.role]}
        </p>
      </Section>
      <Section title="Change password">
        <Field label="Current password" htmlFor="cur">
          <Input id="cur" type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} />
        </Field>
        <Field label="New password" htmlFor="new" help="At least 10 characters.">
          <Input id="new" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
        </Field>
        <Button onClick={() => change.mutate()} loading={change.isPending} disabled={!cur || next.length < 10}>
          Change password
        </Button>
      </Section>
      <TwoFactorSection />
      <SessionsSection />
    </div>
  );
}

interface AppSettingsView {
  backupDirectory: string | null;
  backupRetention: number;
  ddnsProvider: "none" | "duckdns";
  ddnsDomain: string;
  ddnsToken: string;
  infoCommand: boolean;
}

function useAppSettings() {
  return useQuery({ queryKey: ["app-settings"], queryFn: () => api.get<AppSettingsView>("/api/settings") });
}

function BackupSettings() {
  const q = useAppSettings();
  const system = useSystem();
  const [f, setF] = React.useState<{ dir: string; retention: number } | null>(null);
  React.useEffect(() => {
    if (q.data && !f) setF({ dir: q.data.backupDirectory ?? "", retention: q.data.backupRetention });
  }, [q.data, f]);
  const save = useAction(() => api.put("/api/settings", { backupDirectory: f!.dir, backupRetention: f!.retention }), { success: "Backup settings saved", invalidate: [["app-settings"]] });
  if (!f) return <Skeleton className="h-40 rounded-lg" />;
  return (
    <div className="max-w-lg space-y-5">
      <Field label="Backup destination" htmlFor="bdir" help={`Absolute path, e.g. an external drive. Empty uses ${system.data ? `${system.data.dataDir}/backups` : "the data directory"}. Existing backups are not moved.`}>
        <Input id="bdir" value={f.dir} onChange={(e) => setF({ ...f, dir: e.target.value })} placeholder="Default" className="font-mono text-xs" />
      </Field>
      <Field label="Keep the newest" htmlFor="bret" help="Manual and scheduled backups per server. Older ones are deleted automatically after each backup. Safety backups (before restore/migration) are kept 7 days.">
        <Input id="bret" type="number" min={1} max={1000} value={f.retention} onChange={(e) => setF({ ...f, retention: Number(e.target.value) })} className="w-32" />
      </Field>
      <Callout>Remote destinations (S3-compatible storage) are planned. Until then, point the destination at a synced or network folder if you need off-site copies.</Callout>
      <Button onClick={() => save.mutate()} loading={save.isPending}>
        Save
      </Button>
    </div>
  );
}

function DdnsSettings() {
  const q = useAppSettings();
  const [f, setF] = React.useState<{ provider: "none" | "duckdns"; domain: string; token: string } | null>(null);
  React.useEffect(() => {
    if (q.data && !f) setF({ provider: q.data.ddnsProvider, domain: q.data.ddnsDomain, token: q.data.ddnsToken });
  }, [q.data, f]);
  const save = useAction(() => api.put("/api/settings", { ddnsProvider: f!.provider, ddnsDomain: f!.domain, ddnsToken: f!.token }), { success: "Saved. The address is refreshed every 10 minutes.", invalidate: [["app-settings"]] });
  const test = useAction(() => api.post<{ ok: boolean; message: string }>("/api/settings/ddns/test"), {
    onSuccess: (r) => (r.ok ? toast.success(r.message) : toast.error(r.message)),
  });
  if (!f) return <Skeleton className="h-40 rounded-lg" />;
  return (
    <div className="max-w-lg space-y-5">
      <p className="text-[13px] text-muted-foreground">Dynamic DNS gives players a stable name (e.g. myserver.duckdns.org) even when your home IP changes. This is optional and contacts the provider every 10 minutes.</p>
      <Field label="Provider" htmlFor="dprov">
        <NativeSelect id="dprov" value={f.provider} onChange={(e) => setF({ ...f, provider: e.target.value as "none" | "duckdns" })}>
          <option value="none">Disabled</option>
          <option value="duckdns">DuckDNS</option>
        </NativeSelect>
      </Field>
      {f.provider === "duckdns" && (
        <>
          <Field label="Domain" htmlFor="ddom">
            <Input id="ddom" value={f.domain} onChange={(e) => setF({ ...f, domain: e.target.value })} placeholder="myserver.duckdns.org" />
          </Field>
          <Field label="Token" htmlFor="dtok" help="Stored on this machine and never shown again in full.">
            <Input id="dtok" type="password" value={f.token} onChange={(e) => setF({ ...f, token: e.target.value })} autoComplete="off" />
          </Field>
        </>
      )}
      <div className="flex gap-2">
        <Button onClick={() => save.mutate()} loading={save.isPending}>
          Save
        </Button>
        {f.provider !== "none" && (
          <Button variant="secondary" onClick={() => test.mutate()} loading={test.isPending}>
            Update now
          </Button>
        )}
      </div>
    </div>
  );
}

function JavaRuntimes() {
  const q = useQuery({ queryKey: ["java"], queryFn: () => api.get<JavaRuntimeInfo[]>("/api/java") });
  const canInstall = useCan("app.configure");
  const [major, setMajor] = React.useState("21");
  const install = useAction(() => api.post<JavaRuntimeInfo>("/api/java/install", { major: Number(major) }), { success: (r) => `Installed Java ${r.version}`, invalidate: [["java"]] });
  return (
    <div className="max-w-3xl space-y-6">
      <Section title="Detected Java runtimes" description="Servers pick a compatible runtime automatically. Minecraft 1.17–1.20.4 needs Java 17, 1.20.5–1.21.x needs Java 21, 26.x needs Java 25, older versions need Java 8.">
        {q.isLoading ? (
          <Skeleton className="h-24 rounded-lg" />
        ) : q.data?.length ? (
          <Panel>
            <ul className="divide-y divide-border">
              {q.data.map((j) => (
                <li key={j.path} className="flex items-center gap-3 px-4 py-3 text-[13px]">
                  <Coffee className="size-4 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">
                      Java {j.major} <span className="font-normal text-muted-foreground">· {j.version} · {j.vendor ?? "unknown vendor"}</span>
                    </p>
                    <p className="truncate font-mono text-xs text-muted-foreground">{j.path}</p>
                  </div>
                  {j.managed ? <Badge variant="info">Managed</Badge> : <Badge>System</Badge>}
                </li>
              ))}
            </ul>
          </Panel>
        ) : (
          <p className="text-[13px] text-muted-foreground">No Java runtime found. One is downloaded automatically when you create a server.</p>
        )}
      </Section>
      {canInstall && (
        <Section title="Install a runtime" description="Downloads Eclipse Temurin from Adoptium for this platform and verifies its SHA-256 checksum.">
          <div className="flex gap-2">
            <NativeSelect value={major} onChange={(e) => setMajor(e.target.value)} className="w-32">
              {["8", "17", "21", "25"].map((m) => (
                <option key={m} value={m}>
                  Java {m}
                </option>
              ))}
            </NativeSelect>
            <Button onClick={() => install.mutate()} loading={install.isPending}>
              <Download /> Install
            </Button>
          </div>
        </Section>
      )}
    </div>
  );
}

function AuditLog() {
  const q = useQuery({ queryKey: ["audit"], queryFn: () => api.get<{ id: number; username: string | null; action: string; target: string | null; details: string | null; ip: string | null; createdAt: number }[]>("/api/audit") });
  if (q.isLoading) return <Skeleton className="h-64 rounded-lg" />;
  if (q.error) return <Callout variant="danger">{errorMessage(q.error)}</Callout>;
  return (
    <Panel className="overflow-x-auto">
      <table className="w-full min-w-[720px] text-[13px]">
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            <th className="px-4 py-2 font-medium">Time</th>
            <th className="px-4 py-2 font-medium">User</th>
            <th className="px-4 py-2 font-medium">Action</th>
            <th className="px-4 py-2 font-medium">Details</th>
            <th className="px-4 py-2 font-medium">IP</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {q.data?.map((a) => (
            <tr key={a.id}>
              <td className="whitespace-nowrap px-4 py-2 text-muted-foreground">{formatDateTime(a.createdAt)}</td>
              <td className="px-4 py-2">{a.username ?? "—"}</td>
              <td className="px-4 py-2 font-mono text-xs">{a.action}</td>
              <td className="max-w-sm truncate px-4 py-2 font-mono text-xs text-muted-foreground" title={a.details ?? undefined}>
                {a.details ?? ""}
              </td>
              <td className="px-4 py-2 font-mono text-xs text-muted-foreground">{a.ip ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

function InfoCommandSetting() {
  const q = useAppSettings();
  const toggle = useAction((enabled: boolean) => api.put("/api/settings", { infoCommand: enabled }), {
    success: "Saved. Applies to each server on its next start.",
    invalidate: [["app-settings"]],
  });
  if (!q.data) return <Skeleton className="h-16 rounded-lg" />;
  return (
    <div className="flex items-start justify-between gap-6">
      <p className="text-[13px] text-muted-foreground">
        Players can type <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">/craftpanel</code> (Paper) or{" "}
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">/trigger craftpanel</code> (Vanilla and Paper) to see a short card about CraftPanel. CraftPanel adds a small datapack and, on Paper, a 2 KB
        plugin on each start; no operator rights needed. Turn it off here for all servers, or per server in its Settings tab. Removing or disabling the plugin in a server's Plugins tab also keeps it off.
      </p>
      <Switch checked={q.data.infoCommand} disabled={toggle.isPending} onCheckedChange={(v) => toggle.mutate(v)} aria-label="In-game info command" />
    </div>
  );
}

function About() {
  const s = useSystem();
  const canOwner = useCan("app.configure");
  return (
    <div className="max-w-2xl space-y-6">
      <Callout variant="warning" icon={<ShieldAlert />} title="Native execution">
        Minecraft servers and their plugins run as regular processes under the same operating-system user as CraftPanel, without container isolation. A malicious plugin can access anything that user can. Run CraftPanel under a dedicated, unprivileged user account and only install plugins you trust.
      </Callout>
      <Section title="Dashboard exposure">
        <p className="text-[13px] text-muted-foreground">
          {s.data?.dashboard.loopbackOnly
            ? "The dashboard only listens on this computer (127.0.0.1). Start CraftPanel with the lan profile to manage it from other devices."
            : `The dashboard listens on ${s.data?.dashboard.host}:${s.data?.dashboard.port}. Keep it on a private network or VPN, and use HTTPS for access over the internet. Never port-forward it over plain HTTP.`}{" "}
          Addresses and allowed networks are under Remote access.
        </p>
      </Section>
      {canOwner && (
        <Section title="Updates">
          <UpdateSection />
        </Section>
      )}
      {canOwner && (
        <Section title="In-game info command">
          <InfoCommandSetting />
        </Section>
      )}
      {s.data && (
        <Section title="About">
          <dl className="grid grid-cols-[160px_1fr] gap-y-2 text-[13px]">
            <dt className="text-muted-foreground">Version</dt>
            <dd>CraftPanel {s.data.version}</dd>
            <dt className="text-muted-foreground">Platform</dt>
            <dd>
              {s.data.platform}/{s.data.arch}
            </dd>
            <dt className="text-muted-foreground">Data directory</dt>
            <dd className="break-all font-mono text-xs">{s.data.dataDir}</dd>
            <dt className="text-muted-foreground">Created by</dt>
            <dd>
              {CRAFTPANEL_AUTHOR.name} (
              <a href={CRAFTPANEL_AUTHOR.github} target="_blank" rel="noreferrer" className="underline decoration-border underline-offset-2 hover:decoration-foreground">
                @{CRAFTPANEL_AUTHOR.handle}
              </a>
              ) ·{" "}
              <a href={CRAFTPANEL_AUTHOR.website} target="_blank" rel="noreferrer" className="underline decoration-border underline-offset-2 hover:decoration-foreground">
                {CRAFTPANEL_AUTHOR.website.replace(/^https:\/\//, "")}
              </a>
            </dd>
            <dt className="text-muted-foreground">Website</dt>
            <dd>
              <a href={CRAFTPANEL_SITE_URL} target="_blank" rel="noreferrer" className="underline decoration-border underline-offset-2 hover:decoration-foreground">
                {CRAFTPANEL_SITE_URL.replace(/^https:\/\/|\/$/g, "")}
              </a>{" "}
              · guides and documentation
            </dd>
            <dt className="text-muted-foreground">Project</dt>
            <dd>
              <a href={CRAFTPANEL_REPO_URL} target="_blank" rel="noreferrer" className="underline decoration-border underline-offset-2 hover:decoration-foreground">
                {CRAFTPANEL_REPO_URL.replace(/^https:\/\//, "")}
              </a>{" "}
              · issues and ideas welcome
            </dd>
            <dt className="text-muted-foreground">License</dt>
            <dd>FSL-1.1-ALv2: free to use, change and share, except to offer a competing commercial product; each version becomes Apache-2.0 after two years. Minecraft is a trademark of Mojang AB; CraftPanel is not affiliated with Mojang or Microsoft.</dd>
          </dl>
        </Section>
      )}
    </div>
  );
}
