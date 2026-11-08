import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance, InjectOptions } from "fastify";
import { servers } from "@craftpanel/database";
import { dataLayout } from "@craftpanel/server-runtime";
import { canAccess, serverRole, type Access } from "@craftpanel/shared";
import { createContext } from "../src/bootstrap";
import { Hub } from "../src/hub";
import { buildApp } from "../src/app";
import type { AppContext } from "../src/context";
import { base32Decode, base32Encode, totpCode, totpStep, verifyTotp } from "../src/auth/totp";

describe("TOTP", () => {
  it("matches the RFC 6238 test vectors (SHA-1)", () => {
    const secret = base32Encode(Buffer.from("12345678901234567890"));
    // RFC 6238 appendix B, truncated to 6 digits.
    expect(totpCode(secret, Math.floor(59 / 30))).toBe("287082");
    expect(totpCode(secret, Math.floor(1111111109 / 30))).toBe("081804");
    expect(totpCode(secret, Math.floor(1234567890 / 30))).toBe("005924");
    expect(totpCode(secret, Math.floor(2000000000 / 30))).toBe("279037");
  });
  it("round-trips base32", () => {
    const buf = crypto.randomBytes(20);
    expect(base32Decode(base32Encode(buf)).equals(buf)).toBe(true);
    expect(base32Decode("jbsw y3dp-ehpk 3pxp")).toEqual(base32Decode("JBSWY3DPEHPK3PXP"));
  });
  it("accepts one step of clock drift and rejects replays", () => {
    const secret = base32Encode(crypto.randomBytes(20));
    const now = Date.now();
    const step = totpStep(now);
    expect(verifyTotp(secret, totpCode(secret, step), null, now)).toBe(step);
    expect(verifyTotp(secret, totpCode(secret, step - 1), null, now)).toBe(step - 1);
    expect(verifyTotp(secret, totpCode(secret, step + 2), null, now)).toBeNull();
    expect(verifyTotp(secret, totpCode(secret, step), step, now)).toBeNull();
    expect(verifyTotp(secret, "12345", null, now)).toBeNull();
  });
});

describe("access model", () => {
  const limited: Access = { role: "viewer", serverScope: "selected", serverRoles: { a: "operator" } };
  const viewerPlus: Access = { role: "viewer", serverScope: "all", serverRoles: { a: "admin" } };
  it("limits selected-scope users to their servers", () => {
    expect(serverRole(limited, "a")).toBe("operator");
    expect(serverRole(limited, "b")).toBeNull();
    expect(canAccess(limited, "server.control", "a")).toBe(true);
    expect(canAccess(limited, "server.configure", "a")).toBe(false);
    expect(canAccess(limited, "server.view", "b")).toBe(false);
    expect(canAccess(limited, "server.create")).toBe(false);
    expect(canAccess(limited, "server.view")).toBe(true);
  });
  it("adds per-server roles on top of the global role", () => {
    expect(serverRole(viewerPlus, "a")).toBe("admin");
    expect(serverRole(viewerPlus, "b")).toBe("viewer");
    expect(canAccess(viewerPlus, "server.configure", "a")).toBe(true);
    expect(canAccess(viewerPlus, "server.configure", "b")).toBe(false);
    expect(canAccess(viewerPlus, "audit.view")).toBe(false);
  });
});

// ---- API ------------------------------------------------------------------------------

let root: string;
let ctx: AppContext;
let app: FastifyInstance;
const ids: Record<string, string> = {};

interface Session {
  cookie: string;
  csrf: string;
}
// Requests come from rotating loopback addresses so the sign-in rate limit (10/min per IP) does not interfere.
let peer = 0;
const inj = (opts: InjectOptions) => app.inject({ remoteAddress: `127.0.0.${(peer++ % 250) + 1}`, ...opts });
const call = (s: Session | null, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: object, headers: Record<string, string> = {}) =>
  inj({ method, url, payload, headers: { ...(s ? { cookie: s.cookie, "x-csrf-token": s.csrf } : {}), ...headers } });
const sessionFrom = (r: { headers: Record<string, unknown>; json: () => { csrfToken: string } }): Session => ({ cookie: String(r.headers["set-cookie"]).split(";")[0], csrf: r.json().csrfToken });

async function login(username: string, password: string, ua = "test"): Promise<Session> {
  const r = await inj({ method: "POST", url: "/api/auth/login", payload: { username, password }, headers: { "user-agent": ua } });
  expect(r.statusCode).toBe(200);
  return sessionFrom(r);
}

let owner: Session;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "cp-teams-"));
  ctx = await createContext({
    profile: "local",
    serveWeb: false,
    logFormat: "json",
    tls: null,
    host: "127.0.0.1",
    port: 0,
    layout: dataLayout(root),
    corsOrigins: [],
    secureCookies: false,
    trustProxy: false,
    publicUrl: null,
    webDir: null,
    sessionTtlMs: 3600_000,
    logLevel: "silent",
    isLoopbackOnly: true,
  });
  app = await buildApp(ctx, { logger: false });
  owner = sessionFrom(await inj({ method: "POST", url: "/api/auth/setup", payload: { username: "owner", password: "owner-password-1" } }));
  const now = Date.now();
  for (const name of ["alpha", "beta"]) {
    ids[name] = crypto.randomUUID();
    const dir = path.join(root, "servers", name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "server.properties"), "motd=Test\n");
    await ctx.database.db.insert(servers).values({
      id: ids[name], name, software: "vanilla", mcVersion: "1.21.11", javaMajor: 21, memoryMb: 1024, directory: dir, port: name === "alpha" ? 25591 : 25592,
      installState: "installed", jarFile: "server.jar", createdAt: now, updatedAt: now,
    });
  }
});

afterAll(async () => {
  await app?.close();
  ctx?.database.close();
  await fs.rm(root, { recursive: true, force: true });
});

describe("per-server permissions", () => {
  let mod: Session;
  it("limits a moderator to the servers they were given", async () => {
    const r = await call(owner, "POST", "/api/users", { username: "mod", password: "mod-password-1", role: "viewer", serverScope: "selected", serverRoles: { [ids.alpha]: "operator" } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ serverScope: "selected", serverRoles: { [ids.alpha]: "operator" } });
    mod = await login("mod", "mod-password-1");

    const list = (await call(mod, "GET", "/api/servers")).json();
    expect(list.map((s: { name: string }) => s.name)).toEqual(["alpha"]);
    expect((await call(mod, "GET", `/api/servers/${ids.alpha}`)).statusCode).toBe(200);
    // Other servers look like they don't exist.
    expect((await call(mod, "GET", `/api/servers/${ids.beta}`)).statusCode).toBe(404);
    expect((await call(mod, "GET", `/api/servers/${ids.beta}/properties`)).statusCode).toBe(404);
    // Operator on alpha: player management yes, configuration no.
    expect((await call(mod, "POST", `/api/servers/${ids.alpha}/players/whitelist`, { name: "Steve" })).statusCode).not.toBe(403);
    expect((await call(mod, "PUT", `/api/servers/${ids.alpha}/properties`, { values: { motd: "x" } })).statusCode).toBe(403);
    // No application-wide rights.
    expect((await call(mod, "POST", "/api/servers", { name: "x", software: "vanilla", mcVersion: "1.21.11" })).statusCode).toBe(403);
    expect((await call(mod, "GET", "/api/audit")).statusCode).toBe(403);
    expect((await call(mod, "GET", "/api/system")).json().servers?.total ?? 1).toBe(1);
  });

  it("hides activity, schedules and backups of other servers", async () => {
    await ctx.activity.event(ids.alpha, "test", "alpha event");
    await ctx.activity.event(ids.beta, "test", "beta event");
    await ctx.activity.event(null, "test", "global event");
    const events = (await call(mod, "GET", "/api/activity")).json() as { message: string }[];
    expect(events.map((e) => e.message)).toContain("alpha event");
    expect(events.map((e) => e.message)).not.toContain("beta event");
    expect(events.map((e) => e.message)).not.toContain("global event");
    expect((await call(mod, "GET", `/api/activity?serverId=${ids.beta}`)).statusCode).toBe(404);

    const s = await call(owner, "POST", "/api/schedules", { name: "beta restart", cron: "0 4 * * *", action: "restart", serverId: ids.beta, payload: {}, enabled: false });
    expect(s.statusCode).toBe(200);
    expect((await call(mod, "GET", "/api/schedules")).json()).toEqual([]);
    expect((await call(mod, "DELETE", `/api/schedules/${s.json().id}`)).statusCode).toBe(404);
    // Operators cannot manage schedules even on their own server.
    expect((await call(mod, "POST", "/api/schedules", { name: "a", cron: "0 4 * * *", action: "restart", serverId: ids.alpha, payload: {}, enabled: false })).statusCode).toBe(403);
  });

  it("raises a global viewer to admin on one server", async () => {
    await call(owner, "POST", "/api/users", { username: "helper", password: "helper-password-1", role: "viewer", serverRoles: { [ids.beta]: "admin" } });
    const helper = await login("helper", "helper-password-1");
    expect((await call(helper, "GET", "/api/servers")).json()).toHaveLength(2);
    expect((await call(helper, "PUT", `/api/servers/${ids.beta}/properties`, { values: { motd: "Hi" } })).statusCode).toBe(204);
    expect((await call(helper, "PUT", `/api/servers/${ids.alpha}/properties`, { values: { motd: "Hi" } })).statusCode).toBe(403);
  });

  it("applies changed access on the next request", async () => {
    const users = (await call(owner, "GET", "/api/users")).json() as { id: string; username: string }[];
    const modId = users.find((u) => u.username === "mod")!.id;
    expect((await call(owner, "PATCH", `/api/users/${modId}`, { serverRoles: { [ids.beta]: "viewer" } })).statusCode).toBe(200);
    expect((await call(mod, "GET", "/api/servers")).json().map((s: { name: string }) => s.name)).toEqual(["beta"]);
    expect((await call(mod, "GET", `/api/servers/${ids.alpha}`)).statusCode).toBe(404);
  });

  it("needs configure rights on every backend to change a proxy, not only on the proxy", async () => {
    const id = crypto.randomUUID();
    const dir = path.join(root, "servers", "proxy");
    await fs.mkdir(dir, { recursive: true });
    const now = Date.now();
    await ctx.database.db.insert(servers).values({ id, name: "proxy", software: "velocity", mcVersion: "3.4.0", javaMajor: 21, memoryMb: 512, directory: dir, port: 25593, installState: "installed", jarFile: "velocity.jar", createdAt: now, updatedAt: now });
    await call(owner, "POST", "/api/users", { username: "proxyadmin", password: "proxyadmin-password-1", role: "viewer", serverScope: "selected", serverRoles: { [id]: "admin", [ids.alpha]: "operator" } });
    const pa = await login("proxyadmin", "proxyadmin-password-1");
    const body = (serverId: string) => ({ backends: [{ serverId, name: "survival" }], onlineMode: true, localOnly: true });
    // beta is invisible to this user, alpha visible but without configure rights: neither may be rewired through the proxy.
    expect((await call(pa, "PUT", `/api/servers/${id}/proxy`, body(ids.beta))).statusCode).toBe(404);
    expect((await call(pa, "PUT", `/api/servers/${id}/proxy`, body(ids.alpha))).statusCode).toBe(403);
    // The owner passes the permission check and reaches validation (alpha runs Vanilla, which can't be a backend).
    expect((await call(owner, "PUT", `/api/servers/${id}/proxy`, body(ids.alpha))).statusCode).toBe(400);
  });

  it("removes grants when a server is deleted", async () => {
    const r = await call(owner, "DELETE", `/api/servers/${ids.beta}?deleteFiles=false&backup=false`);
    expect(r.statusCode).toBe(204);
    const users = (await call(owner, "GET", "/api/users")).json() as { username: string; serverRoles: Record<string, string> }[];
    expect(users.find((u) => u.username === "mod")!.serverRoles).toEqual({});
  });
});

describe("two-factor sign-in", () => {
  let user: Session;
  let secret: string;
  let recovery: string[];
  const code = (offset = 0) => totpCode(secret, totpStep() + offset);

  it("enrolls with a code from the authenticator", async () => {
    await call(owner, "POST", "/api/users", { username: "tfa", password: "tfa-password-1", role: "admin" });
    user = await login("tfa", "tfa-password-1");
    const other = await login("tfa", "tfa-password-1", "other-device");
    const setup = await call(user, "POST", "/api/auth/2fa/setup");
    expect(setup.statusCode).toBe(200);
    secret = setup.json().secret;
    expect(setup.json().uri).toMatch(/^otpauth:\/\/totp\/CraftPanel%3Atfa\?secret=/);
    expect((await call(user, "POST", "/api/auth/2fa/enable", { code: "000000" === code() ? "111111" : "000000" })).statusCode).toBe(400);
    const en = await call(user, "POST", "/api/auth/2fa/enable", { code: code() });
    expect(en.statusCode).toBe(200);
    recovery = en.json().recoveryCodes;
    expect(recovery).toHaveLength(10);
    // Other devices signed in with only a password are signed out.
    expect((await call(other, "GET", "/api/servers")).statusCode).toBe(401);
    expect((await call(user, "GET", "/api/auth/state")).json().user.twoFactorEnabled).toBe(true);
  });

  it("asks for a code after the password and rejects a reused one", async () => {
    const first = await inj({ method: "POST", url: "/api/auth/login", payload: { username: "tfa", password: "tfa-password-1" } });
    expect(first.statusCode).toBe(200);
    expect(first.headers["set-cookie"]).toBeUndefined();
    const { challenge, twoFactorRequired } = first.json();
    expect(twoFactorRequired).toBe(true);
    expect((await inj({ method: "POST", url: "/api/auth/login/2fa", payload: { challenge, code: "123456" } })).statusCode).toBe(401);
    // The code from enrollment was already used (same 30-second step); the next step's code works.
    const ok = await inj({ method: "POST", url: "/api/auth/login/2fa", payload: { challenge, code: code(1) } });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["set-cookie"]).toBeDefined();
    // A challenge can't be used twice.
    expect((await inj({ method: "POST", url: "/api/auth/login/2fa", payload: { challenge, code: code(1) } })).statusCode).toBe(401);
  });

  it("accepts each recovery code once", async () => {
    const start = async () => (await inj({ method: "POST", url: "/api/auth/login", payload: { username: "tfa", password: "tfa-password-1" } })).json().challenge;
    const r1 = await inj({ method: "POST", url: "/api/auth/login/2fa", payload: { challenge: await start(), code: recovery[0].toUpperCase() } });
    expect(r1.statusCode).toBe(200);
    const r2 = await inj({ method: "POST", url: "/api/auth/login/2fa", payload: { challenge: await start(), code: recovery[0] } });
    expect(r2.statusCode).toBe(401);
  });

  it("locks a challenge after five wrong codes", async () => {
    const challenge = (await inj({ method: "POST", url: "/api/auth/login", payload: { username: "tfa", password: "tfa-password-1" } })).json().challenge;
    for (let i = 0; i < 5; i++) await inj({ method: "POST", url: "/api/auth/login/2fa", payload: { challenge, code: "000001" } });
    const r = await inj({ method: "POST", url: "/api/auth/login/2fa", payload: { challenge, code: recovery[1] } });
    expect(r.statusCode).toBe(401);
    expect(r.json().error.code).toBe("challenge_expired");
  });

  it("forces enrollment for roles that require it", async () => {
    await call(owner, "POST", "/api/users", { username: "op2", password: "op2-password-1", role: "operator" });
    expect((await call(owner, "PUT", "/api/settings", { twoFactorRoles: ["operator"] })).statusCode).toBe(200);
    const op = await login("op2", "op2-password-1");
    const state = (await call(op, "GET", "/api/auth/state")).json();
    expect(state.user.twoFactorSetupRequired).toBe(true);
    const blocked = await call(op, "GET", "/api/servers");
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe("two_factor_required");
    const setup = (await call(op, "POST", "/api/auth/2fa/setup")).json();
    expect((await call(op, "POST", "/api/auth/2fa/enable", { code: totpCode(setup.secret, totpStep()) })).statusCode).toBe(200);
    expect((await call(op, "GET", "/api/servers")).statusCode).toBe(200);
    // Can't turn it off while the role requires it.
    expect((await call(op, "POST", "/api/auth/2fa/disable", { password: "op2-password-1", code: totpCode(setup.secret, totpStep() + 1) })).statusCode).toBe(400);
    await call(owner, "PUT", "/api/settings", { twoFactorRoles: [] });
  });

  it("lets an owner reset a lost second factor", async () => {
    const users = (await call(owner, "GET", "/api/users")).json() as { id: string; username: string; twoFactorEnabled: boolean }[];
    const tfa = users.find((u) => u.username === "tfa")!;
    expect(tfa.twoFactorEnabled).toBe(true);
    const r = await call(owner, "PATCH", `/api/users/${tfa.id}`, { resetTwoFactor: true });
    expect(r.json().twoFactorEnabled).toBe(false);
    expect((await call(user, "GET", "/api/servers")).statusCode).toBe(401);
    const again = await inj({ method: "POST", url: "/api/auth/login", payload: { username: "tfa", password: "tfa-password-1" } });
    expect(again.json().csrfToken).toBeTruthy();
  });
});

describe("signed-in devices", () => {
  it("lists sessions and signs out a single device", async () => {
    await call(owner, "POST", "/api/users", { username: "dev", password: "dev-password-1", role: "viewer" });
    const laptop = await login("dev", "dev-password-1", "Laptop Firefox");
    const phone = await login("dev", "dev-password-1", "Phone Safari");
    const list = (await call(laptop, "GET", "/api/auth/sessions")).json() as { id: string; current: boolean; userAgent: string }[];
    expect(list).toHaveLength(2);
    expect(list.find((s) => s.current)?.userAgent).toBe("Laptop Firefox");
    expect(list.every((s) => /^[0-9a-f]{16}$/.test(s.id))).toBe(true);
    const phoneId = list.find((s) => !s.current)!.id;
    expect((await call(laptop, "DELETE", `/api/auth/sessions/${phoneId}`)).statusCode).toBe(204);
    expect((await call(phone, "GET", "/api/servers")).statusCode).toBe(401);
    expect((await call(laptop, "GET", "/api/servers")).statusCode).toBe(200);
    // Someone else's session id is not found.
    const ownerSessions = (await call(owner, "GET", "/api/auth/sessions")).json() as { id: string }[];
    expect((await call(laptop, "DELETE", `/api/auth/sessions/${ownerSessions[0].id}`)).statusCode).toBe(404);
  });

  it("lets an owner sign a user out everywhere", async () => {
    const s = await login("dev", "dev-password-1");
    const users = (await call(owner, "GET", "/api/users")).json() as { id: string; username: string }[];
    const dev = users.find((u) => u.username === "dev")!;
    expect((await call(owner, "GET", `/api/users/${dev.id}/sessions`)).json().length).toBeGreaterThan(0);
    expect((await call(owner, "POST", `/api/users/${dev.id}/sign-out`)).statusCode).toBe(204);
    expect((await call(s, "GET", "/api/servers")).statusCode).toBe(401);
  });
});

describe("real-time broadcasts", () => {
  it("only reach users who may see the server", () => {
    const hub = new Hub();
    const received: Record<string, string[]> = {};
    const client = (name: string, access: Access) => {
      received[name] = [];
      const socket = { readyState: 1, bufferedAmount: 0, send: (d: string) => received[name].push(JSON.parse(d).serverId ?? JSON.parse(d).event?.serverId ?? "app") };
      hub.add({ socket: socket as never, userId: name, username: name, access, sessionId: name, subscriptions: new Map() });
    };
    client("admin", { role: "admin", serverScope: "all", serverRoles: {} });
    client("mod", { role: "viewer", serverScope: "selected", serverRoles: { a: "operator" } });
    hub.broadcast({ type: "status", serverId: "a", status: "running" });
    hub.broadcast({ type: "status", serverId: "b", status: "running" });
    hub.broadcast({ type: "event", event: { id: 1, serverId: null, kind: "x", level: "info", message: "global", actor: null, createdAt: 0 } });
    expect(received.admin).toEqual(["a", "b", "app"]);
    expect(received.mod).toEqual(["a"]);
  });
});

describe("notification settings", () => {
  it("validates, redacts and keeps secrets", async () => {
    expect((await call(owner, "POST", "/api/settings/notifications/test")).statusCode).toBe(400);
    const bad = await call(owner, "PUT", "/api/settings", { notifyDiscordWebhook: "https://example.com/hook" });
    expect(bad.statusCode).toBe(400);
    const hook = "https://discord.com/api/webhooks/1/secret-token";
    const email = { enabled: true, host: "smtp.example.test", port: 587, security: "starttls", username: "u", password: "smtp-secret", from: "", to: "a@example.test" };
    expect((await call(owner, "PUT", "/api/settings", { notifyDiscordWebhook: hook, notifyEmail: email })).statusCode).toBe(200);
    const view = (await call(owner, "GET", "/api/settings")).json();
    expect(view.notifyDiscordWebhook).toBe("••••••••");
    expect(view.notifyEmail.password).toBe("••••••••");
    expect(JSON.stringify(view)).not.toContain("secret");
    // Saving the form unchanged sends the placeholders back; the stored values stay.
    expect((await call(owner, "PUT", "/api/settings", { notifyDiscordWebhook: view.notifyDiscordWebhook, notifyEmail: { ...view.notifyEmail, port: 2525 } })).statusCode).toBe(200);
    const stored = await ctx.settings.get();
    expect(stored.notifyDiscordWebhook).toBe(hook);
    expect(stored.notifyEmail).toMatchObject({ password: "smtp-secret", port: 2525 });
    await call(owner, "PUT", "/api/settings", { notifyDiscordWebhook: "", notifyEmail: { ...email, enabled: false } });
  });
});
