/**
 * CraftPanel dashboard roles. These are completely separate from Minecraft
 * operator ("op") permissions, which only apply inside the game.
 */
export const ROLES = ["viewer", "operator", "admin", "owner"] as const;
export type Role = (typeof ROLES)[number];

const RANK: Record<Role, number> = { viewer: 0, operator: 1, admin: 2, owner: 3 };

export const PERMISSIONS = {
  "server.view": "viewer",
  "console.read": "viewer",
  "server.control": "operator", // start / stop / restart
  "console.command": "operator",
  "players.manage": "operator",
  "backup.create": "operator",
  "server.kill": "admin",
  "server.create": "admin",
  "server.delete": "admin",
  "server.configure": "admin",
  "files.read": "admin",
  "files.write": "admin",
  "plugins.manage": "admin",
  "worlds.manage": "admin",
  "backup.restore": "admin",
  "backup.delete": "admin",
  "schedule.manage": "admin",
  "network.manage": "admin",
  "audit.view": "admin",
  "users.manage": "owner",
  "app.configure": "owner",
} as const satisfies Record<string, Role>;

export type Permission = keyof typeof PERMISSIONS;

export function roleAtLeast(role: Role, required: Role): boolean {
  return RANK[role] >= RANK[required];
}

export function can(role: Role, permission: Permission): boolean {
  return roleAtLeast(role, PERMISSIONS[permission]);
}

export const ROLE_LABELS: Record<Role, string> = {
  owner: "Owner",
  admin: "Administrator",
  operator: "Operator",
  viewer: "Viewer",
};

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  owner: "Full control, including user management and application settings.",
  admin: "Create, configure and delete servers, manage files, plugins and backups.",
  operator: "Start and stop servers, run console commands and manage players.",
  viewer: "Read-only access to servers, consoles and metrics.",
};

// ---- per-server access ------------------------------------------------------

/** Roles that can be granted on a single server. */
export const SERVER_ROLES = ["viewer", "operator", "admin"] as const;
export type ServerRole = (typeof SERVER_ROLES)[number];
export type ServerScope = "all" | "selected";

/** Permissions that concern one server; everything else is application-wide. */
const APP_PERMISSIONS = new Set<Permission>(["server.create", "audit.view", "users.manage", "app.configure"]);

export function isServerPermission(permission: Permission): boolean {
  return !APP_PERMISSIONS.has(permission);
}

/** What a signed-in user may do: a global role plus per-server grants. */
export interface Access {
  role: Role;
  serverScope: ServerScope;
  serverRoles: Record<string, ServerRole>;
}

const higher = (a: Role, b: Role | undefined): Role => (b && RANK[b] > RANK[a] ? b : a);

/** The user's role on one server, or null when they cannot see it at all. */
export function serverRole(access: Access, serverId: string): Role | null {
  const granted = access.serverRoles[serverId];
  if (access.serverScope === "selected" && access.role !== "owner") return granted ?? null;
  return higher(access.role, granted);
}

/**
 * Permission check with per-server roles. Without a server id, a server
 * permission is granted if the user has it on at least one server (lists are
 * then filtered with `canSeeServer`).
 */
export function canAccess(access: Access, permission: Permission, serverId?: string | null): boolean {
  const limited = access.serverScope === "selected" && access.role !== "owner";
  if (!isServerPermission(permission)) return !limited && can(access.role, permission);
  if (serverId) {
    const r = serverRole(access, serverId);
    return r !== null && can(r, permission);
  }
  if (!limited && can(access.role, permission)) return true;
  return Object.values(access.serverRoles).some((r) => can(r, permission));
}

export function canSeeServer(access: Access, serverId: string): boolean {
  return serverRole(access, serverId) !== null;
}
