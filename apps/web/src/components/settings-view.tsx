"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Coffee, Download, Plus, ShieldAlert, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  Badge,
  Button,
  Callout,
  ConfirmDialog,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Field,
  Input,
  NativeSelect,
  PageHeader,
  Panel,
  Section,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@craftpanel/ui";
import { ROLE_DESCRIPTIONS, ROLE_LABELS, ROLES, type JavaRuntimeInfo, type Role, type UserInfo } from "@craftpanel/shared";
import { api, errorMessage } from "@/lib/api";
import { useAuth, useCan } from "@/lib/auth";
import { useAction } from "@/lib/queries";
import { formatDateTime } from "@/lib/format";
import { useSystem } from "./home";

export function SettingsView() {
  const params = useSearchParams();
  const canOwner = useCan("app.configure");
  const canAudit = useCan("audit.view");
  return (
    <div className="space-y-6">
      <PageHeader title="Settings" description="Application-wide configuration. Per-server settings live in each server's Settings tab." />
      <Tabs defaultValue={params.get("tab") ?? "account"} className="space-y-6">
        <TabsList className="max-w-full overflow-x-auto">
          <TabsTrigger value="account">Account</TabsTrigger>
          {canOwner && <TabsTrigger value="users">Users</TabsTrigger>}
          {canOwner && <TabsTrigger value="backups">Backups</TabsTrigger>}
          {canOwner && <TabsTrigger value="network">Dynamic DNS</TabsTrigger>}
          <TabsTrigger value="java">Java</TabsTrigger>
          {canAudit && <TabsTrigger value="audit">Audit log</TabsTrigger>}
          <TabsTrigger value="about">Security & about</TabsTrigger>
        </TabsList>
        <TabsContent value="account">
          <Account />
        </TabsContent>
        <TabsContent value="users">{canOwner && <Users />}</TabsContent>
        <TabsContent value="backups">{canOwner && <BackupSettings />}</TabsContent>
        <TabsContent value="network">{canOwner && <DdnsSettings />}</TabsContent>
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
    <div className="max-w-md space-y-6">
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
    </div>
  );
}

function Users() {
  const q = useQuery({ queryKey: ["users"], queryFn: () => api.get<UserInfo[]>("/api/users") });
  const { state } = useAuth();
  const [creating, setCreating] = React.useState(false);
  const [deleting, setDeleting] = React.useState<UserInfo | null>(null);
  const update = useAction((v: { id: string; role?: Role; disabled?: boolean }) => api.patch(`/api/users/${v.id}`, { role: v.role, disabled: v.disabled }), { success: "User updated", invalidate: [["users"]] });
  const del = useAction((id: string) => api.del(`/api/users/${id}`), { success: "User deleted", invalidate: [["users"]] });
  return (
    <div className="space-y-6">
      <Section
        title="Dashboard users"
        description="Roles control access to CraftPanel. They are unrelated to Minecraft operator status."
        actions={
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus /> Add user
          </Button>
        }
      >
        {q.isLoading ? (
          <Skeleton className="h-32 rounded-xl" />
        ) : (
          <Panel>
            <ul className="divide-y divide-border">
              {q.data?.map((u) => (
                <li key={u.id} className="flex flex-wrap items-center gap-4 px-4 py-3 text-[13px]">
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 font-medium">
                      {u.username}
                      {u.id === state?.user?.id && <Badge>You</Badge>}
                      {u.disabled && <Badge variant="danger">Disabled</Badge>}
                    </p>
                    <p className="text-xs text-muted-foreground">Created {formatDateTime(u.createdAt)}</p>
                  </div>
                  <NativeSelect value={u.role} onChange={(e) => update.mutate({ id: u.id, role: e.target.value as Role })} disabled={u.id === state?.user?.id} className="h-8 w-40 text-[13px]" aria-label={`Role of ${u.username}`}>
                    {[...ROLES].reverse().map((r) => (
                      <option key={r} value={r}>
                        {ROLE_LABELS[r]}
                      </option>
                    ))}
                  </NativeSelect>
                  {u.id !== state?.user?.id && (
                    <>
                      <Button size="xs" variant="ghost" onClick={() => update.mutate({ id: u.id, disabled: !u.disabled })}>
                        {u.disabled ? "Enable" : "Disable"}
                      </Button>
                      <Button size="icon-sm" variant="destructive-ghost" onClick={() => setDeleting(u)} aria-label={`Delete ${u.username}`}>
                        <Trash2 />
                      </Button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </Panel>
        )}
      </Section>
      <Section title="Roles">
        <dl className="grid gap-3 text-[13px] sm:grid-cols-2">
          {[...ROLES].reverse().map((r) => (
            <div key={r} className="rounded-lg border border-border p-3">
              <dt className="font-medium">{ROLE_LABELS[r]}</dt>
              <dd className="text-muted-foreground">{ROLE_DESCRIPTIONS[r]}</dd>
            </div>
          ))}
        </dl>
      </Section>
      <CreateUser open={creating} onOpenChange={setCreating} />
      <ConfirmDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)} title={`Delete ${deleting?.username}?`} description="Their sessions end immediately." destructive confirmLabel="Delete user" onConfirm={() => del.mutateAsync(deleting!.id)} />
    </div>
  );
}

function CreateUser({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [f, setF] = React.useState({ username: "", password: "", role: "viewer" as Role });
  const create = useAction(() => api.post("/api/users", f), {
    success: "User created",
    invalidate: [["users"]],
    onSuccess: () => (onOpenChange(false), setF({ username: "", password: "", role: "viewer" })),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader title="Add user" description="Share the credentials with the person securely. They can change their password after signing in." />
        <Field label="Username" htmlFor="nu">
          <Input id="nu" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} autoComplete="off" />
        </Field>
        <Field label="Initial password" htmlFor="np" help="At least 10 characters.">
          <Input id="np" type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="new-password" />
        </Field>
        <Field label="Role" htmlFor="nr" help={ROLE_DESCRIPTIONS[f.role]}>
          <NativeSelect id="nr" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as Role })}>
            {[...ROLES].reverse().map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => create.mutate()} loading={create.isPending} disabled={f.username.length < 3 || f.password.length < 10}>
            Create user
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface AppSettingsView {
  backupDirectory: string | null;
  backupRetention: number;
  ddnsProvider: "none" | "duckdns";
  ddnsDomain: string;
  ddnsToken: string;
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
  if (!f) return <Skeleton className="h-40 rounded-xl" />;
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
  if (!f) return <Skeleton className="h-40 rounded-xl" />;
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
          <Skeleton className="h-24 rounded-xl" />
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
  if (q.isLoading) return <Skeleton className="h-64 rounded-xl" />;
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

function About() {
  const s = useSystem();
  return (
    <div className="max-w-2xl space-y-6">
      <Callout variant="warning" icon={<ShieldAlert />} title="Native execution">
        Minecraft servers and their plugins run as regular processes under the same operating-system user as CraftPanel, without container isolation. A malicious plugin can access anything that user can. Run CraftPanel under a dedicated, unprivileged user account and only install plugins you trust.
      </Callout>
      <Section title="Dashboard exposure">
        <p className="text-[13px] text-muted-foreground">
          {s.data?.dashboard.loopbackOnly
            ? "The dashboard only listens on this computer (127.0.0.1). To manage it from another device, set CRAFTPANEL_HOST to a LAN address and restart."
            : `The dashboard listens on ${s.data?.dashboard.host}:${s.data?.dashboard.port}. Keep it on a private network or VPN, and put an HTTPS reverse proxy in front for remote access. Never port-forward it.`}
        </p>
      </Section>
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
            <dt className="text-muted-foreground">License</dt>
            <dd>AGPL-3.0-or-later. Minecraft is a trademark of Mojang AB; CraftPanel is not affiliated with Mojang or Microsoft.</dd>
          </dl>
        </Section>
      )}
    </div>
  );
}
