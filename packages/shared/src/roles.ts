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
