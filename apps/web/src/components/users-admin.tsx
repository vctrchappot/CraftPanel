"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { MoreHorizontal, Plus, ShieldCheck } from "lucide-react";
import {
  Badge,
  Button,
  Callout,
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
import { ROLE_DESCRIPTIONS, ROLE_LABELS, ROLES, SERVER_ROLES, type Role, type ServerRole, type ServerScope, type SessionInfo, type UserInfo } from "@craftpanel/shared";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useServers } from "@/lib/queries";
import { formatDateTime, timeAgo } from "@/lib/format";
import { SessionList } from "./account-security";

interface AccessValue {
  role: Role;
  serverScope: ServerScope;
  serverRoles: Record<string, ServerRole>;
}

export function UsersAdmin() {
  const q = useQuery({
    queryKey: ["users"],
    queryFn: () => api.get<UserInfo[]>("/api/users"),
  });
  const servers = useServers();
  const { state } = useAuth();
  const [creating, setCreating] = React.useState(false);
  const [editing, setEditing] = React.useState<UserInfo | null>(null);
  const [deleting, setDeleting] = React.useState<UserInfo | null>(null);
  const [resetting, setResetting] = React.useState<UserInfo | null>(null);
  const [devices, setDevices] = React.useState<UserInfo | null>(null);
  const update = useAction((v: { id: string; role?: Role; disabled?: boolean; resetTwoFactor?: true }) => api.patch(`/api/users/${v.id}`, v), { success: "User updated", invalidate: [["users"]] });
  const signOut = useAction((id: string) => api.post(`/api/users/${id}/sign-out`), { success: "Signed out on all devices" });
  const del = useAction((id: string) => api.del(`/api/users/${id}`), {
    success: "User deleted",
    invalidate: [["users"]],
  });
  const serverName = (id: string) => servers.data?.find((s) => s.id === id)?.name ?? "deleted server";

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
          <Skeleton className="h-32 rounded-lg" />
        ) : (
          <Panel>
            <ul className="divide-y divide-border">
              {q.data?.map((u) => {
                const me = u.id === state?.user?.id;
                const grants = Object.entries(u.serverRoles);
                return (
                  <li key={u.id} className="flex flex-wrap items-center gap-4 px-4 py-3 text-[13px]">
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <div className="flex flex-wrap items-center gap-2 font-medium">
                        {u.username}
                        {me && <Badge>You</Badge>}
                        {u.disabled && <Badge variant="danger">Disabled</Badge>}
                        {u.twoFactorEnabled && (
                          <Badge variant="success">
                            <ShieldCheck className="size-3" /> 2FA
                          </Badge>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {u.role === "owner"
                          ? "All servers"
                          : u.serverScope === "selected"
                            ? grants.length
                              ? `Only ${grants.map(([id, r]) => `${serverName(id)} (${ROLE_LABELS[r]})`).join(", ")}`
                              : "No servers"
                            : grants.length
                              ? `All servers · more rights on ${grants.map(([id, r]) => `${serverName(id)} (${ROLE_LABELS[r]})`).join(", ")}`
                              : "All servers"}
                        {" · "}last sign-in {timeAgo(u.lastLoginAt)}
                      </div>
                    </div>
                    <span className="w-28 text-[13px]">{ROLE_LABELS[u.role]}</span>
                    <Button size="xs" variant="secondary" onClick={() => setEditing(u)}>
                      Access
                    </Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button size="icon-sm" variant="ghost" aria-label={`More actions for ${u.username}`}>
                          <MoreHorizontal />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => setDevices(u)}>Signed-in devices</DropdownMenuItem>
                        {!me && <DropdownMenuItem onSelect={() => signOut.mutate(u.id)}>Sign out everywhere</DropdownMenuItem>}
                        {u.twoFactorEnabled && <DropdownMenuItem onSelect={() => setResetting(u)}>Reset two-factor sign-in</DropdownMenuItem>}
                        {!me && (
                          <>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onSelect={() =>
                                update.mutate({
                                  id: u.id,
                                  disabled: !u.disabled,
                                })
                              }
                            >
                              {u.disabled ? "Enable account" : "Disable account"}
                            </DropdownMenuItem>
                            <DropdownMenuItem className="text-destructive" onSelect={() => setDeleting(u)}>
                              Delete user
                            </DropdownMenuItem>
                          </>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </li>
                );
              })}
            </ul>
          </Panel>
        )}
      </Section>
      <TwoFactorPolicy />
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
      {editing && <EditAccess user={editing} self={editing.id === state?.user?.id} onClose={() => setEditing(null)} />}
      {devices && <UserDevices user={devices} onClose={() => setDevices(null)} />}
      <ConfirmDialog
        open={!!resetting}
        onOpenChange={(o) => !o && setResetting(null)}
        title={`Reset two-factor sign-in for ${resetting?.username}?`}
        description="Use this when they lost their phone and recovery codes. They are signed out and can sign in with their password, then set it up again."
        confirmLabel="Reset"
        destructive
        onConfirm={() => update.mutateAsync({ id: resetting!.id, resetTwoFactor: true })}
      />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete ${deleting?.username}?`}
        description="Their sessions end immediately."
        destructive
        confirmLabel="Delete user"
        onConfirm={() => del.mutateAsync(deleting!.id)}
      />
    </div>
  );
}

/** Global role, server scope and per-server roles, shared by "Add user" and "Access". */
function AccessEditor({ value, onChange, self }: { value: AccessValue; onChange: (v: AccessValue) => void; self?: boolean }) {
  const servers = useServers();
  const owner = value.role === "owner";
  const limited = value.serverScope === "selected" && !owner;
  return (
    <div className="space-y-4">
      <Field label="Role" htmlFor="acc-role" help={ROLE_DESCRIPTIONS[value.role]}>
        <NativeSelect id="acc-role" value={value.role} disabled={self} onChange={(e) => onChange({ ...value, role: e.target.value as Role })}>
          {[...ROLES].reverse().map((r) => (
            <option key={r} value={r}>
              {ROLE_LABELS[r]}
            </option>
          ))}
        </NativeSelect>
      </Field>
      {owner ? (
        <Callout>Owners always have full access to every server.</Callout>
      ) : (
        <>
          <Field label="Servers" htmlFor="acc-scope">
            <NativeSelect
              id="acc-scope"
              value={value.serverScope}
              disabled={self}
              onChange={(e) =>
                onChange({
                  ...value,
                  serverScope: e.target.value as ServerScope,
                })
              }
            >
              <option value="all">All servers, with the role above</option>
              <option value="selected">Only the servers chosen below</option>
            </NativeSelect>
          </Field>
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              {limited
                ? "The user sees only these servers, with the role chosen for each. Application settings stay hidden."
                : "Optionally give more rights on single servers, e.g. a viewer who administers one server."}
            </p>
            {servers.isLoading ? (
              <Skeleton className="h-20" />
            ) : servers.data?.length ? (
              <Panel>
                <ul className="max-h-64 divide-y divide-border overflow-y-auto">
                  {servers.data.map((s) => (
                    <li key={s.id} className="flex items-center gap-3 px-3 py-2 text-[13px]">
                      <span className="min-w-0 flex-1 truncate">{s.name}</span>
                      <NativeSelect
                        value={value.serverRoles[s.id] ?? ""}
                        className="h-8 w-36 text-[13px]"
                        aria-label={`Role on ${s.name}`}
                        onChange={(e) => {
                          const next = { ...value.serverRoles };
                          if (e.target.value) next[s.id] = e.target.value as ServerRole;
                          else delete next[s.id];
                          onChange({ ...value, serverRoles: next });
                        }}
                      >
                        <option value="">{limited ? "No access" : "Same as role"}</option>
                        {[...SERVER_ROLES].reverse().map((r) => (
                          <option key={r} value={r}>
                            {ROLE_LABELS[r]}
                          </option>
                        ))}
                      </NativeSelect>
                    </li>
                  ))}
                </ul>
              </Panel>
            ) : (
              <p className="text-[13px] text-muted-foreground">No servers yet.</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function CreateUser({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const empty = {
    username: "",
    password: "",
    access: {
      role: "viewer" as Role,
      serverScope: "all" as ServerScope,
      serverRoles: {},
    },
  };
  const [f, setF] = React.useState(empty);
  const create = useAction(
    () =>
      api.post("/api/users", {
        username: f.username,
        password: f.password,
        ...f.access,
      }),
    {
      success: "User created",
      invalidate: [["users"]],
      onSuccess: () => (onOpenChange(false), setF(empty)),
    },
  );
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
        <AccessEditor value={f.access} onChange={(access) => setF({ ...f, access })} />
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

function EditAccess({ user, self, onClose }: { user: UserInfo; self: boolean; onClose: () => void }) {
  const [value, setValue] = React.useState<AccessValue>({
    role: user.role,
    serverScope: user.serverScope,
    serverRoles: user.serverRoles,
  });
  const save = useAction(
    () =>
      api.patch(
        `/api/users/${user.id}`,
        self
          ? { serverRoles: value.serverRoles }
          : {
              role: value.role,
              serverScope: value.serverScope,
              serverRoles: value.serverRoles,
            },
      ),
    { success: "Access updated", invalidate: [["users"]], onSuccess: onClose },
  );
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader title={`Access for ${user.username}`} description="Changes apply immediately; open dashboards of this user reload their access." />
        <AccessEditor value={value} onChange={setValue} self={self} />
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function UserDevices({ user, onClose }: { user: UserInfo; onClose: () => void }) {
  const q = useQuery({
    queryKey: ["user-sessions", user.id],
    queryFn: () => api.get<SessionInfo[]>(`/api/users/${user.id}/sessions`),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader title={`Signed-in devices of ${user.username}`} description={`Last sign-in ${formatDateTime(user.lastLoginAt)}.`} />
        {q.isLoading ? <Skeleton className="h-24" /> : <SessionList sessions={q.data ?? []} />}
      </DialogContent>
    </Dialog>
  );
}

function TwoFactorPolicy() {
  const q = useQuery({
    queryKey: ["app-settings"],
    queryFn: () => api.get<{ twoFactorRoles: Role[] }>("/api/settings"),
  });
  const save = useAction((roles: Role[]) => api.put("/api/settings", { twoFactorRoles: roles }), { success: "Saved", invalidate: [["app-settings"], ["auth"]] });
  const roles = q.data?.twoFactorRoles ?? [];
  return (
    <Section title="Require two-factor sign-in" description="Users with these roles must set up an authenticator app before they can use the dashboard. They are asked on their next page load.">
      {q.isLoading ? (
        <Skeleton className="h-24 rounded-lg" />
      ) : (
        <Panel>
          <ul className="divide-y divide-border">
            {[...ROLES].reverse().map((r) => (
              <li key={r} className="flex items-center justify-between gap-4 px-4 py-3 text-[13px]">
                <span>{ROLE_LABELS[r]}</span>
                <Switch
                  checked={roles.includes(r)}
                  aria-label={`Require two-factor sign-in for ${ROLE_LABELS[r]}`}
                  onCheckedChange={(on) => save.mutate(on ? [...roles, r] : roles.filter((x) => x !== r))}
                />
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </Section>
  );
}
