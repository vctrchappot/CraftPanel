import type { ActivityEvent } from "@craftpanel/shared";
import { and, auditLog, desc, eq, events, lt, servers, type Database } from "@craftpanel/database";
import type { Hub } from "../hub";

export interface Actor {
  id: string | null;
  username: string | null;
  ip?: string | null;
}

export const SYSTEM_ACTOR: Actor = { id: null, username: "system" };

/** Persistent activity feed (server events) and security audit log. */
export class ActivityService {
  constructor(private db: Database, private hub: Hub) {}

  async event(serverId: string | null, kind: string, message: string, opts: { level?: ActivityEvent["level"]; actor?: Actor } = {}) {
    const createdAt = Date.now();
    const level = opts.level ?? "info";
    const actor = opts.actor?.username ?? null;
    const [row] = await this.db.insert(events).values({ serverId, kind, level, message, actor, createdAt }).returning({ id: events.id });
    this.hub.broadcast({ type: "event", event: { id: row.id, serverId, kind, level, message, actor, createdAt } });
  }

  async audit(actor: Actor, action: string, target: string | null, details?: Record<string, unknown>) {
    await this.db.insert(auditLog).values({
      userId: actor.id,
      username: actor.username,
      action,
      target,
      details: details ? JSON.stringify(details) : null,
      ip: actor.ip ?? null,
      createdAt: Date.now(),
    });
  }

  async list(opts: { serverId?: string; limit?: number; before?: number }): Promise<ActivityEvent[]> {
    const limit = Math.min(opts.limit ?? 100, 500);
    const conds = [];
    if (opts.serverId) conds.push(eq(events.serverId, opts.serverId));
    if (opts.before) conds.push(lt(events.id, opts.before));
    const rows = await this.db
      .select({ e: events, serverName: servers.name })
      .from(events)
      .leftJoin(servers, eq(events.serverId, servers.id))
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(events.id))
      .limit(limit);
    return rows.map((r) => ({ ...r.e, level: r.e.level as ActivityEvent["level"], serverName: r.serverName }));
  }

  async listAudit(limit = 200) {
    return this.db.select().from(auditLog).orderBy(desc(auditLog.id)).limit(Math.min(limit, 1000));
  }

  /** Keep the database bounded. */
  async prune(maxAgeDays = 90) {
    const cutoff = Date.now() - maxAgeDays * 86400_000;
    await this.db.delete(events).where(lt(events.createdAt, cutoff));
  }
}
