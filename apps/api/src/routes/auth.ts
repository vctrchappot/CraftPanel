import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { AppError, changePasswordSchema, createUserSchema, loginSchema, setupSchema, updateUserSchema, ROLES, type UserInfo } from "@craftpanel/shared";
import { eq, users, sql } from "@craftpanel/database";
import { z } from "zod";
import { DUMMY_HASH, hashPassword, verifyPassword } from "../auth/password";
import { SESSION_COOKIE, safeEqual } from "../auth/sessions";
import { actorOf, noContent, requirePermission, requireUser, type AppContext } from "../context";
import { parse } from "../validate";

export async function authRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db } = ctx.database;
  const cookieOpts = { path: "/", httpOnly: true, sameSite: "strict" as const, secure: ctx.config.secureCookies, maxAge: Math.floor(ctx.config.sessionTtlMs / 1000) };

  const userCount = async () => (await db.select({ n: sql<number>`count(*)` }).from(users))[0].n;

  app.get("/api/auth/state", async (req) => {
    const setupRequired = (await userCount()) === 0;
    return {
      setupRequired,
      setupTokenRequired: setupRequired && !!ctx.setupToken,
      user: req.user ? { id: req.user.id, username: req.user.username, role: req.user.role } : null,
      csrfToken: req.user?.csrfToken ?? null,
    };
  });

  app.post("/api/auth/setup", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const body = parse(setupSchema.extend({ setupToken: z.string().max(200).optional() }), req.body);
    if (ctx.setupToken && !safeEqual(body.setupToken ?? "", ctx.setupToken))
      throw new AppError(403, "setup_token_invalid", "Invalid setup token", "The setup token is printed in the CraftPanel server log and stored in the data directory (setup-token.txt).");
    // Single transaction-free check is safe: SQLite serializes writes and username is unique.
    if ((await userCount()) > 0) throw new AppError(409, "already_setup", "CraftPanel is already set up");
    const id = crypto.randomUUID();
    await db.insert(users).values({ id, username: body.username, passwordHash: await hashPassword(body.password), role: "owner", createdAt: Date.now() });
    ctx.setupToken = null;
    await fsp.rm(path.join(ctx.config.layout.root, "setup-token.txt"), { force: true });
    await ctx.activity.audit({ id, username: body.username, ip: req.ip }, "auth.setup", id);
    const s = await ctx.sessions.create(id, { ip: req.ip, userAgent: req.headers["user-agent"] });
    reply.setCookie(SESSION_COOKIE, s.token, cookieOpts);
    return { user: { id, username: body.username, role: "owner" }, csrfToken: s.csrfToken };
  });

  app.post("/api/auth/login", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const body = parse(loginSchema, req.body);
    const [user] = await db.select().from(users).where(eq(users.username, body.username));
    const ok = await verifyPassword(body.password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !ok || user.disabled) {
      await ctx.activity.audit({ id: null, username: body.username, ip: req.ip }, "auth.login_failed", null);
      throw new AppError(401, "invalid_credentials", "Incorrect username or password");
    }
    const s = await ctx.sessions.create(user.id, { ip: req.ip, userAgent: req.headers["user-agent"] });
    reply.setCookie(SESSION_COOKIE, s.token, cookieOpts);
    await ctx.activity.audit({ id: user.id, username: user.username, ip: req.ip }, "auth.login", user.id);
    return { user: { id: user.id, username: user.username, role: user.role }, csrfToken: s.csrfToken };
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
    await ctx.activity.audit(actorOf(req), "auth.password_change", me.id);
    return noContent(reply);
  });

  // ---- user management (owner only) ------------------------------------------

  const toInfo = (u: typeof users.$inferSelect): UserInfo => ({ id: u.id, username: u.username, role: u.role, disabled: u.disabled, createdAt: u.createdAt });

  app.get("/api/users", async (req) => {
    requirePermission(req, "users.manage");
    return (await db.select().from(users).orderBy(users.createdAt)).map(toInfo);
  });

  app.post("/api/users", async (req) => {
    requirePermission(req, "users.manage");
    const body = parse(createUserSchema, req.body);
    const [existing] = await db.select().from(users).where(eq(users.username, body.username));
    if (existing) throw new AppError(409, "conflict", "That username is taken");
    const id = crypto.randomUUID();
    const [row] = await db.insert(users).values({ id, username: body.username, passwordHash: await hashPassword(body.password), role: body.role, createdAt: Date.now() }).returning();
    await ctx.activity.audit(actorOf(req), "user.create", id, { username: body.username, role: body.role });
    return toInfo(row);
  });

  app.patch<{ Params: { id: string } }>("/api/users/:id", async (req) => {
    const me = requirePermission(req, "users.manage");
    const body = parse(updateUserSchema, req.body);
    const [target] = await db.select().from(users).where(eq(users.id, req.params.id));
    if (!target) throw new AppError(404, "not_found", "User not found");
    if (target.id === me.id && (body.role && body.role !== "owner" || body.disabled)) throw new AppError(400, "bad_request", "You cannot demote or disable your own account");
    if (target.role === "owner" && body.role && body.role !== "owner") {
      const owners = (await db.select().from(users).where(eq(users.role, "owner"))).filter((u) => !u.disabled);
      if (owners.length <= 1) throw new AppError(400, "bad_request", "At least one owner must remain");
    }
    const patch: Partial<typeof users.$inferInsert> = {};
    if (body.role && ROLES.includes(body.role)) patch.role = body.role;
    if (body.disabled !== undefined) patch.disabled = body.disabled;
    if (body.password) patch.passwordHash = await hashPassword(body.password);
    const [row] = await db.update(users).set(patch).where(eq(users.id, target.id)).returning();
    if (body.disabled || body.password || body.role) {
      await ctx.sessions.destroyForUser(target.id);
      ctx.hub.disconnect((c) => c.userId === target.id);
    }
    await ctx.activity.audit(actorOf(req), "user.update", target.id, { role: body.role, disabled: body.disabled, passwordReset: !!body.password });
    return toInfo(row);
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
