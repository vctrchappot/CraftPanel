import crypto from "node:crypto";
import { desc, eq, lt, serverMembers, sessions, users, type Database } from "@craftpanel/database";
import type { Access, Role, ServerRole, SessionInfo } from "@craftpanel/shared";
import { randomToken, sha256 } from "./password";

export interface SessionUser extends Access {
  id: string;
  username: string;
  sessionId: string;
  csrfToken: string;
  twoFactorEnabled: boolean;
  /** The user's role requires two-factor sign-in but it isn't set up yet: only enrollment is allowed. */
  twoFactorSetupRequired: boolean;
}

export const SESSION_COOKIE = "cp_session";

/** Most devices one user can be signed in on; signing in beyond that ends the longest-idle sessions. */
export const MAX_SESSIONS_PER_USER = 20;

/** Sessions are keyed by the token's SHA-256; the dashboard sees only this prefix. */
export const publicSessionId = (sessionId: string) => sessionId.slice(0, 16);

export class SessionStore {
  private lastTouch = new Map<string, number>();
  constructor(
    private db: Database,
    private ttlMs: number,
    /** Roles that must use two-factor sign-in (from the app settings). */
    private twoFactorRoles: () => Promise<Role[]> = async () => [],
  ) {}

  async create(userId: string, meta: { ip?: string; userAgent?: string }): Promise<{ token: string; csrfToken: string }> {
    const token = randomToken(32);
    const csrfToken = randomToken(24);
    const now = Date.now();
    await this.db.insert(sessions).values({
      id: sha256(token),
      userId,
      csrfToken,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + this.ttlMs,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent?.slice(0, 256) ?? null,
    });
    await this.db.update(users).set({ lastLoginAt: now }).where(eq(users.id, userId));
    await this.trim(userId);
    return { token, csrfToken };
  }

  async resolve(token: string | undefined, meta: { ip?: string } = {}): Promise<SessionUser | null> {
    if (!token || token.length > 128) return null;
    const id = sha256(token);
    const [row] = await this.db
      .select({ s: sessions, u: users })
      .from(sessions)
      .innerJoin(users, eq(sessions.userId, users.id))
      .where(eq(sessions.id, id));
    if (!row) return null;
    const now = Date.now();
    if (row.s.expiresAt < now || row.u.disabled) {
      await this.db.delete(sessions).where(eq(sessions.id, id));
      return null;
    }
    // Sliding expiry, written at most once a minute.
    if (now - (this.lastTouch.get(id) ?? 0) > 60_000) {
      this.lastTouch.set(id, now);
      await this.db
        .update(sessions)
        .set({ lastSeenAt: now, expiresAt: now + this.ttlMs, ...(meta.ip ? { ip: meta.ip } : {}) })
        .where(eq(sessions.id, id));
    }
    return this.userFor(row.u, id, row.s.csrfToken);
  }

  private async userFor(u: typeof users.$inferSelect, sessionId: string, csrfToken: string): Promise<SessionUser> {
    const grants = await this.db.select({ serverId: serverMembers.serverId, role: serverMembers.role }).from(serverMembers).where(eq(serverMembers.userId, u.id));
    const twoFactorEnabled = u.totpEnabledAt !== null;
    return {
      id: u.id,
      username: u.username,
      role: u.role,
      serverScope: u.serverScope,
      serverRoles: Object.fromEntries(grants.map((g) => [g.serverId, g.role as ServerRole])),
      sessionId,
      csrfToken,
      twoFactorEnabled,
      twoFactorSetupRequired: !twoFactorEnabled && (await this.twoFactorRoles()).includes(u.role),
    };
  }

  /** Signed-in devices of a user, newest activity first. */
  async list(userId: string, currentSessionId?: string): Promise<SessionInfo[]> {
    const rows = await this.db.select().from(sessions).where(eq(sessions.userId, userId)).orderBy(desc(sessions.lastSeenAt));
    const now = Date.now();
    return rows
      .filter((r) => r.expiresAt >= now)
      .map((r) => ({
        id: publicSessionId(r.id),
        current: r.id === currentSessionId,
        createdAt: r.createdAt,
        lastSeenAt: r.lastSeenAt,
        ip: r.ip,
        userAgent: r.userAgent,
      }));
  }

  /** Keep a user's newest sessions by activity; scripts and repeated sign-ins would otherwise pile up for the whole session lifetime. */
  private async trim(userId: string) {
    const rows = await this.db.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, userId)).orderBy(desc(sessions.lastSeenAt));
    for (const r of rows.slice(MAX_SESSIONS_PER_USER)) await this.destroy(r.id);
  }

  /** End one of a user's sessions by its public id. Returns the full session id, or null. */
  async destroyByPublicId(userId: string, publicId: string): Promise<string | null> {
    if (!/^[0-9a-f]{16}$/.test(publicId)) return null;
    const rows = await this.db.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, userId));
    const match = rows.find((r) => publicSessionId(r.id) === publicId);
    if (!match) return null;
    await this.destroy(match.id);
    return match.id;
  }

  async destroy(sessionId: string) {
    await this.db.delete(sessions).where(eq(sessions.id, sessionId));
    this.lastTouch.delete(sessionId);
  }

  async destroyForUser(userId: string, exceptSessionId?: string) {
    const rows = await this.db.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, userId));
    for (const r of rows) if (r.id !== exceptSessionId) await this.destroy(r.id);
  }

  async purgeExpired() {
    await this.db.delete(sessions).where(lt(sessions.expiresAt, Date.now()));
  }

}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
