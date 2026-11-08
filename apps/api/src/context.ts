import type { FastifyReply, FastifyRequest } from "fastify";
import type { DatabaseHandle } from "@craftpanel/database";
import type { LocalAgent } from "@craftpanel/server-runtime";
import type { JavaManager } from "@craftpanel/minecraft-providers";
import { AppError, canAccess, canSeeServer, forbidden, isServerPermission, notFound, type Permission } from "@craftpanel/shared";
import type { AppConfig } from "./config";
import type { Hub } from "./hub";
import type { SessionStore, SessionUser } from "./auth/sessions";
import type { ActivityService, Actor } from "./services/activity";
import type { ServerService } from "./services/servers";
import type { BackupService } from "./services/backups";
import type { ScheduleService } from "./services/schedules";
import type { GameService } from "./services/game";
import type { SettingsService } from "./services/settings";
import type { UpdateService } from "./services/updates";
import type { PregenService } from "./services/pregen";
import type { NotificationService } from "./services/notifications";

export interface AppContext {
  config: AppConfig;
  database: DatabaseHandle;
  agent: LocalAgent;
  hub: Hub;
  sessions: SessionStore;
  activity: ActivityService;
  servers: ServerService;
  backups: BackupService;
  schedules: ScheduleService;
  game: GameService;
  pregen: PregenService;
  settings: SettingsService;
  updates: UpdateService;
  notifications: NotificationService;
  java: JavaManager;
  /** One-time token required to create the first account on non-loopback installs. */
  setupToken: string | null;
}

declare module "fastify" {
  interface FastifyRequest {
    user: SessionUser | null;
  }
}

export function requireUser(req: FastifyRequest): SessionUser {
  if (!req.user) throw new AppError(401, "unauthenticated", "Please sign in");
  return req.user;
}

/** Routes whose `:id` parameter is a server id; their permission checks use the user's role on that server. */
const SERVER_ROUTE = /^\/api\/servers\/:id(\/|$)/;

/**
 * Server-side RBAC check used by every route. On `/api/servers/:id/…` routes
 * the user's role on that server counts (per-server roles); a server the user
 * cannot see answers 404, as if it didn't exist. Pass `serverId` for routes
 * that address a server some other way (backups, schedules).
 */
export function requirePermission(req: FastifyRequest, permission: Permission, serverId?: string | null): SessionUser {
  const user = requireUser(req);
  if (user.twoFactorSetupRequired)
    throw new AppError(403, "two_factor_required", "Set up two-factor sign-in to continue", "Your role requires a second factor. Open the dashboard to set it up.");
  // null: an object that belongs to no server (a global schedule, a deleted server's backup); only users who see every server.
  if (serverId === null && !seesAllServers(user)) throw forbidden();
  const sid = serverId ?? (SERVER_ROUTE.test(req.routeOptions.url ?? "") ? (req.params as { id?: string }).id : undefined);
  if (sid && isServerPermission(permission) && !canSeeServer(user, sid)) throw notFound("Server");
  if (!canAccess(user, permission, sid)) throw forbidden();
  return user;
}

export function seesAllServers(user: SessionUser): boolean {
  return user.serverScope === "all" || user.role === "owner";
}

/** For lists: whether the user may see items of this server (null: items without a server). */
export function canSee(user: SessionUser, serverId: string | null | undefined): boolean {
  return serverId ? canSeeServer(user, serverId) : seesAllServers(user);
}

/** Server ids a limited user may see, or null when they see all servers. */
export function visibleServerIds(user: SessionUser): string[] | null {
  return seesAllServers(user) ? null : Object.keys(user.serverRoles);
}

export function actorOf(req: FastifyRequest): Actor {
  return { id: req.user?.id ?? null, username: req.user?.username ?? null, ip: req.ip };
}

export function noContent(reply: FastifyReply) {
  return reply.code(204).send();
}
