import type { FastifyReply, FastifyRequest } from "fastify";
import type { DatabaseHandle } from "@craftpanel/database";
import type { LocalAgent } from "@craftpanel/server-runtime";
import type { JavaManager } from "@craftpanel/minecraft-providers";
import { AppError, can, forbidden, type Permission } from "@craftpanel/shared";
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
  settings: SettingsService;
  updates: UpdateService;
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

/** Server-side RBAC check used by every route. */
export function requirePermission(req: FastifyRequest, permission: Permission): SessionUser {
  const user = requireUser(req);
  if (!can(user.role, permission)) throw forbidden();
  return user;
}

export function actorOf(req: FastifyRequest): Actor {
  return { id: req.user?.id ?? null, username: req.user?.username ?? null, ip: req.ip };
}

export function noContent(reply: FastifyReply) {
  return reply.code(204).send();
}
