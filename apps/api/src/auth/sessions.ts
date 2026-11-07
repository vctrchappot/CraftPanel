import crypto from "node:crypto";
import { eq, lt, sessions, users, type Database } from "@craftpanel/database";
import type { Role } from "@craftpanel/shared";
import { randomToken, sha256 } from "./password";

export interface SessionUser {
  id: string;
  username: string;
  role: Role;
  sessionId: string;
  csrfToken: string;
}

export const SESSION_COOKIE = "cp_session";

export class SessionStore {
  private lastTouch = new Map<string, number>();
  constructor(private db: Database, private ttlMs: number) {}

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
    return { token, csrfToken };
  }

  async resolve(token: string | undefined): Promise<SessionUser | null> {
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
      await this.db.update(sessions).set({ lastSeenAt: now, expiresAt: now + this.ttlMs }).where(eq(sessions.id, id));
    }
    return { id: row.u.id, username: row.u.username, role: row.u.role, sessionId: id, csrfToken: row.s.csrfToken };
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
