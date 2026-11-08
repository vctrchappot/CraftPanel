import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  AppError,
  changePasswordSchema,
  createUserSchema,
  disableTotpSchema,
  loginSchema,
  loginTotpSchema,
  setupSchema,
  totpCodeSchema,
  updateUserSchema,
  ROLES,
  type CurrentUser,
  type ServerRole,
  type UserInfo,
} from "@craftpanel/shared";
import { eq, serverMembers, servers, users, sql, inArray, type Database } from "@craftpanel/database";
import { z } from "zod";
import { DUMMY_HASH, hashPassword, randomToken, verifyPassword } from "../auth/password";
import { SESSION_COOKIE, safeEqual, type SessionUser } from "../auth/sessions";
import { generateRecoveryCodes, generateTotpSecret, hashRecoveryCode, otpauthUri, verifyTotp } from "../auth/totp";
import { actorOf, noContent, requirePermission, requireUser, type AppContext } from "../context";
import { parse } from "../validate";

type UserRow = typeof users.$inferSelect;

/** Password checked, second factor pending. Held in memory only; a restart just asks to sign in again. */
interface Challenge {
  userId: string;
  expiresAt: number;
  attempts: number;
}
const CHALLENGE_TTL_MS = 5 * 60_000;
const MAX_CHALLENGE_ATTEMPTS = 5;

export async function authRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db } = ctx.database;
  const cookieOpts = { path: "/", httpOnly: true, sameSite: "strict" as const, secure: ctx.config.secureCookies, maxAge: Math.floor(ctx.config.sessionTtlMs / 1000) };
  const challenges = new Map<string, Challenge>();

  const userCount = async () => (await db.select({ n: sql<number>`count(*)` }).from(users))[0].n;

  const current = (u: SessionUser): CurrentUser => ({
    id: u.id,
    username: u.username,
    role: u.role,
    serverScope: u.serverScope,
    serverRoles: u.serverRoles,
    twoFactorEnabled: u.twoFactorEnabled,
    twoFactorSetupRequired: u.twoFactorSetupRequired,
  });

  /** Create the session cookie and answer like /api/auth/state. */
  async function signIn(req: FastifyRequest, reply: FastifyReply, user: UserRow) {
    const s = await ctx.sessions.create(user.id, { ip: req.ip, userAgent: req.headers["user-agent"] });
    reply.setCookie(SESSION_COOKIE, s.token, cookieOpts);
    await ctx.activity.audit({ id: user.id, username: user.username, ip: req.ip }, "auth.login", user.id);
    const resolved = await ctx.sessions.resolve(s.token, { ip: req.ip });
    return { user: resolved ? current(resolved) : null, csrfToken: s.csrfToken };
  }

  app.get("/api/auth/state", async (req) => {
    const setupRequired = (await userCount()) === 0;
    return {
      setupRequired,
      setupTokenRequired: setupRequired && !!ctx.setupToken,
      user: req.user ? current(req.user) : null,
      csrfToken: req.user?.csrfToken ?? null,
    };
  });

  app.post("/api/auth/setup", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const body = parse(setupSchema.extend({ setupToken: z.string().max(200).optional() }), req.body);
    if (ctx.setupToken && !safeEqual(body.setupToken ?? "", ctx.setupToken))
      throw new AppError(403, "setup_token_invalid", "Invalid setup token", "The setup token is printed in the CraftPanel server log and stored in the data directory (setup-token.txt).");
    if ((await userCount()) > 0) throw new AppError(409, "already_setup", "CraftPanel is already set up");
    const id = crypto.randomUUID();
    const passwordHash = await hashPassword(body.password);
    // Hashing yields to concurrent setup requests. Check emptiness and insert in one SQLite statement.
    const inserted = ctx.database.raw.prepare("INSERT INTO users (id, username, password_hash, role, created_at) SELECT ?, ?, ?, 'owner', ? WHERE NOT EXISTS (SELECT 1 FROM users) RETURNING id")
      .get(id, body.username, passwordHash, Date.now());
    if (!inserted) throw new AppError(409, "already_setup", "CraftPanel is already set up");
    const [row] = await db.select().from(users).where(eq(users.id, id));
    ctx.setupToken = null;
    await fsp.rm(path.join(ctx.config.layout.root, "setup-token.txt"), { force: true });
    await ctx.activity.audit({ id, username: body.username, ip: req.ip }, "auth.setup", id);
    return signIn(req, reply, row);
  });

  app.post("/api/auth/login", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const body = parse(loginSchema, req.body);
    const [user] = await db.select().from(users).where(eq(users.username, body.username));
    const ok = await verifyPassword(body.password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !ok || user.disabled) {
      await ctx.activity.audit({ id: null, username: body.username, ip: req.ip }, "auth.login_failed", null);
      throw new AppError(401, "invalid_credentials", "Incorrect username or password");
    }
    if (user.totpEnabledAt) {
      const now = Date.now();
      for (const [k, c] of challenges) if (c.expiresAt < now) challenges.delete(k);
      const challenge = randomToken(32);
      challenges.set(challenge, { userId: user.id, expiresAt: now + CHALLENGE_TTL_MS, attempts: 0 });
      return { twoFactorRequired: true, challenge };
    }
    return signIn(req, reply, user);
  });

  app.post("/api/auth/login/2fa", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const body = parse(loginTotpSchema, req.body);
    const c = challenges.get(body.challenge);
    if (!c || c.expiresAt < Date.now()) {
      challenges.delete(body.challenge);
      throw new AppError(401, "challenge_expired", "The sign-in attempt expired", "Enter your username and password again.");
    }
    const [user] = await db.select().from(users).where(eq(users.id, c.userId));
    if (!user || user.disabled || !user.totpEnabledAt) {
      challenges.delete(body.challenge);
      throw new AppError(401, "invalid_credentials", "Incorrect username or password");
    }
    if (!(await checkSecondFactor(db, user, body.code))) {
      c.attempts++;
      if (c.attempts >= MAX_CHALLENGE_ATTEMPTS) challenges.delete(body.challenge);
      await ctx.activity.audit({ id: user.id, username: user.username, ip: req.ip }, "auth.2fa_failed", user.id);
      throw new AppError(401, "invalid_code", "Incorrect code", c.attempts >= MAX_CHALLENGE_ATTEMPTS ? "Too many attempts. Sign in again." : "Use the current 6-digit code from your authenticator app, or a recovery code.");
    }
    challenges.delete(body.challenge);
    return signIn(req, reply, user);
  });

  app.post("/api/auth/logout", async (req, reply) => {
    if (req.user) {
      await ctx.sessions.destroy(req.user.sessionId);
      ctx.hub.disconnect((c) => c.sessionId === req.user!.sessionId);
    }
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return noContent(reply);
  });

  app.post("/api/auth/password", async (req, reply) => {
    const me = requireUser(req);
    const body = parse(changePasswordSchema, req.body);
    const [user] = await db.select().from(users).where(eq(users.id, me.id));
    if (!(await verifyPassword(body.currentPassword, user.passwordHash))) throw new AppError(400, "invalid_password", "Current password is incorrect");
    await db.update(users).set({ passwordHash: await hashPassword(body.newPassword) }).where(eq(users.id, me.id));
    await ctx.sessions.destroyForUser(me.id, me.sessionId);
    ctx.hub.disconnect((c) => c.userId === me.id && c.sessionId !== me.sessionId);
    await ctx.activity.audit(actorOf(req), "auth.password_change", me.id);
    return noContent(reply);
  });

  // ---- two-factor sign-in (TOTP) ------------------------------------------------

  /** Start enrolling: a new secret is stored but not active until a code confirms it. */
  app.post("/api/auth/2fa/setup", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req) => {
    const me = requireUser(req);
    const [user] = await db.select().from(users).where(eq(users.id, me.id));
    if (user.totpEnabledAt) throw new AppError(409, "conflict", "Two-factor sign-in is already enabled", "Turn it off first to set up a new authenticator.");
    const secret = generateTotpSecret();
    await db.update(users).set({ totpSecret: secret, totpLastStep: null }).where(eq(users.id, me.id));
    return { secret, uri: otpauthUri(secret, user.username) };
  });

  app.post("/api/auth/2fa/enable", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => {
    const me = requireUser(req);
    const body = parse(totpCodeSchema, req.body);
    const [user] = await db.select().from(users).where(eq(users.id, me.id));
    if (user.totpEnabledAt) throw new AppError(409, "conflict", "Two-factor sign-in is already enabled");
    if (!user.totpSecret) throw new AppError(400, "bad_request", "Start the setup first");
    const step = verifyTotp(user.totpSecret, body.code, null);
    if (step === null) throw new AppError(400, "invalid_code", "Incorrect code", "Check that your phone's clock is correct and enter the current code.");
    const codes = generateRecoveryCodes();
    await db
      .update(users)
      .set({ totpEnabledAt: Date.now(), totpLastStep: step, recoveryCodes: JSON.stringify(codes.map(hashRecoveryCode)) })
      .where(eq(users.id, me.id));
    // Other devices signed in with only a password; they have to sign in again.
    await ctx.sessions.destroyForUser(me.id, me.sessionId);
    ctx.hub.disconnect((c) => c.userId === me.id && c.sessionId !== me.sessionId);
    await ctx.activity.audit(actorOf(req), "auth.2fa_enable", me.id);
    return { recoveryCodes: codes };
  });

  app.post("/api/auth/2fa/disable", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const me = requireUser(req);
    const body = parse(disableTotpSchema, req.body);
    const [user] = await db.select().from(users).where(eq(users.id, me.id));
    if (!user.totpEnabledAt) return noContent(reply);
    if ((await ctx.settings.get()).twoFactorRoles.includes(user.role))
      throw new AppError(400, "two_factor_required", "Your role requires two-factor sign-in", "An owner can change this under Settings → Users.");
    if (!(await verifyPassword(body.password, user.passwordHash))) throw new AppError(400, "invalid_password", "Password is incorrect");
    if (!(await checkSecondFactor(db, user, body.code))) throw new AppError(400, "invalid_code", "Incorrect code");
    await db.update(users).set({ totpSecret: null, totpEnabledAt: null, totpLastStep: null, recoveryCodes: null }).where(eq(users.id, me.id));
    await ctx.activity.audit(actorOf(req), "auth.2fa_disable", me.id);
    return noContent(reply);
  });

  app.post("/api/auth/2fa/recovery-codes", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => {
    const me = requireUser(req);
    const body = parse(totpCodeSchema, req.body);
    const [user] = await db.select().from(users).where(eq(users.id, me.id));
    if (!user.totpEnabledAt) throw new AppError(400, "bad_request", "Two-factor sign-in is not enabled");
    if (!(await checkSecondFactor(db, user, body.code, { totpOnly: true }))) throw new AppError(400, "invalid_code", "Incorrect code");
    const codes = generateRecoveryCodes();
    await db.update(users).set({ recoveryCodes: JSON.stringify(codes.map(hashRecoveryCode)) }).where(eq(users.id, me.id));
    await ctx.activity.audit(actorOf(req), "auth.2fa_recovery_codes", me.id);
    return { recoveryCodes: codes };
  });

  // ---- signed-in devices ----------------------------------------------------------

  app.get("/api/auth/sessions", async (req) => {
    const me = requireUser(req);
    return ctx.sessions.list(me.id, me.sessionId);
  });

  app.delete<{ Params: { id: string } }>("/api/auth/sessions/:id", async (req, reply) => {
    const me = requireUser(req);
    const ended = await ctx.sessions.destroyByPublicId(me.id, req.params.id);
    if (!ended) throw new AppError(404, "not_found", "Session not found");
    ctx.hub.disconnect((c) => c.sessionId === ended);
    await ctx.activity.audit(actorOf(req), "auth.session_revoke", me.id);
    return noContent(reply);
  });

  app.post("/api/auth/sessions/sign-out-others", async (req, reply) => {
    const me = requireUser(req);
    await ctx.sessions.destroyForUser(me.id, me.sessionId);
    ctx.hub.disconnect((c) => c.userId === me.id && c.sessionId !== me.sessionId);
    await ctx.activity.audit(actorOf(req), "auth.sessions_revoke_others", me.id);
    return noContent(reply);
  });

  // ---- user management (owner only) ------------------------------------------

  async function grantsOf(userIds: string[]) {
    const out = new Map<string, Record<string, ServerRole>>();
    if (!userIds.length) return out;
    for (const g of await db.select().from(serverMembers).where(inArray(serverMembers.userId, userIds))) {
      const m = out.get(g.userId) ?? {};
      m[g.serverId] = g.role;
      out.set(g.userId, m);
    }
    return out;
  }

  const toInfo = (u: UserRow, grants: Record<string, ServerRole> = {}): UserInfo => ({
    id: u.id,
    username: u.username,
    role: u.role,
    disabled: u.disabled,
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt,
    serverScope: u.role === "owner" ? "all" : u.serverScope,
    serverRoles: grants,
    twoFactorEnabled: u.totpEnabledAt !== null,
  });

  /** Replace a user's per-server roles; unknown server ids are rejected. */
  async function setGrants(userId: string, grants: Record<string, ServerRole>) {
    const ids = Object.keys(grants);
    if (ids.length) {
      const known = new Set((await db.select({ id: servers.id }).from(servers).where(inArray(servers.id, ids))).map((s) => s.id));
      const unknown = ids.find((id) => !known.has(id));
      if (unknown) throw new AppError(400, "bad_request", "Unknown server in the access list");
    }
    await db.delete(serverMembers).where(eq(serverMembers.userId, userId));
    const now = Date.now();
    if (ids.length) await db.insert(serverMembers).values(ids.map((serverId) => ({ userId, serverId, role: grants[serverId], createdAt: now })));
  }

  app.get("/api/users", async (req) => {
    requirePermission(req, "users.manage");
    const rows = await db.select().from(users).orderBy(users.createdAt);
    const grants = await grantsOf(rows.map((r) => r.id));
    return rows.map((u) => toInfo(u, grants.get(u.id)));
  });

  app.post("/api/users", async (req) => {
    requirePermission(req, "users.manage");
    const body = parse(createUserSchema, req.body);
    const [existing] = await db.select().from(users).where(eq(users.username, body.username));
    if (existing) throw new AppError(409, "conflict", "That username is taken");
    const id = crypto.randomUUID();
    const serverScope = body.role === "owner" ? "all" : body.serverScope;
    const [row] = await db
      .insert(users)
      .values({ id, username: body.username, passwordHash: await hashPassword(body.password), role: body.role, serverScope, createdAt: Date.now() })
      .returning();
    await setGrants(id, body.serverRoles);
    await ctx.activity.audit(actorOf(req), "user.create", id, { username: body.username, role: body.role, serverScope, servers: Object.keys(body.serverRoles).length });
    return toInfo(row, body.serverRoles);
  });

  app.patch<{ Params: { id: string } }>("/api/users/:id", async (req) => {
    const me = requirePermission(req, "users.manage");
    const body = parse(updateUserSchema, req.body);
    const [target] = await db.select().from(users).where(eq(users.id, req.params.id));
    if (!target) throw new AppError(404, "not_found", "User not found");
    if (target.id === me.id && ((body.role && body.role !== "owner") || body.disabled || body.serverScope === "selected"))
      throw new AppError(400, "bad_request", "You cannot demote, limit or disable your own account");
    if (target.role === "owner" && ((body.role && body.role !== "owner") || body.disabled)) {
      const owners = (await db.select().from(users).where(eq(users.role, "owner"))).filter((u) => !u.disabled);
      if (owners.length <= 1) throw new AppError(400, "bad_request", "At least one owner must remain");
    }
    const patch: Partial<typeof users.$inferInsert> = {};
    if (body.role && ROLES.includes(body.role)) patch.role = body.role;
    if (body.disabled !== undefined) patch.disabled = body.disabled;
    if (body.password) patch.passwordHash = await hashPassword(body.password);
    if (body.serverScope) patch.serverScope = body.serverScope;
    if ((body.role ?? target.role) === "owner") patch.serverScope = "all";
    if (body.resetTwoFactor) Object.assign(patch, { totpSecret: null, totpEnabledAt: null, totpLastStep: null, recoveryCodes: null });
    const [row] = Object.keys(patch).length ? await db.update(users).set(patch).where(eq(users.id, target.id)).returning() : [target];
    if (body.serverRoles) await setGrants(target.id, body.serverRoles);
    // Sign the user out where their access shrank or their credentials changed.
    if (body.disabled || body.password || body.resetTwoFactor) {
      await ctx.sessions.destroyForUser(target.id, target.id === me.id ? me.sessionId : undefined);
      ctx.hub.disconnect((c) => c.userId === target.id && c.sessionId !== me.sessionId);
    } else if (body.role || body.serverScope || body.serverRoles) {
      // Open sockets carry the old access; reconnecting picks up the new one.
      ctx.hub.disconnect((c) => c.userId === target.id, 4002);
    }
    await ctx.activity.audit(actorOf(req), "user.update", target.id, {
      role: body.role,
      disabled: body.disabled,
      passwordReset: !!body.password,
      serverScope: body.serverScope,
      servers: body.serverRoles ? Object.keys(body.serverRoles).length : undefined,
      twoFactorReset: body.resetTwoFactor,
    });
    return toInfo(row, (await grantsOf([target.id])).get(target.id));
  });

  app.get<{ Params: { id: string } }>("/api/users/:id/sessions", async (req) => {
    requirePermission(req, "users.manage");
    return ctx.sessions.list(req.params.id);
  });

  app.post<{ Params: { id: string } }>("/api/users/:id/sign-out", async (req, reply) => {
    const me = requirePermission(req, "users.manage");
    await ctx.sessions.destroyForUser(req.params.id, req.params.id === me.id ? me.sessionId : undefined);
    ctx.hub.disconnect((c) => c.userId === req.params.id && c.sessionId !== me.sessionId);
    await ctx.activity.audit(actorOf(req), "user.sign_out", req.params.id);
    return noContent(reply);
  });

  app.delete<{ Params: { id: string } }>("/api/users/:id", async (req, reply) => {
    const me = requirePermission(req, "users.manage");
    if (req.params.id === me.id) throw new AppError(400, "bad_request", "You cannot delete your own account");
    const [target] = await db.select().from(users).where(eq(users.id, req.params.id));
    if (!target) throw new AppError(404, "not_found", "User not found");
    if (target.role === "owner") {
      const owners = await db.select().from(users).where(eq(users.role, "owner"));
      if (owners.length <= 1) throw new AppError(400, "bad_request", "At least one owner must remain");
    }
    ctx.hub.disconnect((c) => c.userId === target.id);
    await db.delete(users).where(eq(users.id, target.id));
    await ctx.activity.audit(actorOf(req), "user.delete", target.id, { username: target.username });
    return noContent(reply);
  });
}

/**
 * Accept a current TOTP code (each step only once) or, unless `totpOnly`, an
 * unused recovery code, which is then removed.
 */
async function checkSecondFactor(db: Database, user: UserRow, code: string, opts: { totpOnly?: boolean } = {}): Promise<boolean> {
  if (!user.totpSecret) return false;
  const step = verifyTotp(user.totpSecret, code, user.totpLastStep);
  if (step !== null) {
    await db.update(users).set({ totpLastStep: step }).where(eq(users.id, user.id));
    return true;
  }
  if (opts.totpOnly || !user.recoveryCodes) return false;
  const hashes: string[] = JSON.parse(user.recoveryCodes);
  const hash = hashRecoveryCode(code);
  const idx = hashes.findIndex((h) => safeEqual(h, hash));
  if (idx < 0) return false;
  hashes.splice(idx, 1);
  await db.update(users).set({ recoveryCodes: JSON.stringify(hashes) }).where(eq(users.id, user.id));
  return true;
}
