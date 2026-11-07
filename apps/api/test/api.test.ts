import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { servers } from "@craftpanel/database";
import { dataLayout } from "@craftpanel/server-runtime";
import { createContext } from "../src/bootstrap";
import { buildApp } from "../src/app";
import type { AppContext } from "../src/context";
import type { AppConfig } from "../src/config";

let root: string;
let ctx: AppContext;
let app: FastifyInstance;
let serverId: string;

function config(host = "127.0.0.1"): AppConfig {
  return {
    profile: "local",
    serveWeb: false,
    logFormat: "json",
    host,
    port: 0,
    layout: dataLayout(root),
    corsOrigins: [],
    secureCookies: false,
    trustProxy: false,
    webDir: null,
    sessionTtlMs: 3600_000,
    logLevel: "silent",
    isLoopbackOnly: host === "127.0.0.1",
  };
}

interface Session {
  cookie: string;
  csrf: string;
}

async function login(username: string, password: string): Promise<Session> {
  const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password } });
  expect(r.statusCode).toBe(200);
  const cookie = String(r.headers["set-cookie"]).split(";")[0];
  return { cookie, csrf: r.json().csrfToken };
}

const call = (s: Session | null, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: object, csrf = true) =>
  app.inject({ method, url, payload, headers: { ...(s ? { cookie: s.cookie } : {}), ...(s && csrf ? { "x-csrf-token": s.csrf } : {}) } });

let owner: Session;
const sessions: Record<string, Session> = {};

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "cp-api-"));
  ctx = await createContext(config());
  app = await buildApp(ctx, { logger: false });

  const setup = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { username: "owner", password: "owner-password-1" } });
  expect(setup.statusCode).toBe(200);
  owner = { cookie: String(setup.headers["set-cookie"]).split(";")[0], csrf: setup.json().csrfToken };

  for (const role of ["admin", "operator", "viewer"]) {
    const r = await call(owner, "POST", "/api/users", { username: role, password: `${role}-password-1`, role });
    expect(r.statusCode).toBe(200);
    sessions[role] = await login(role, `${role}-password-1`);
  }

  // A server row with a real directory (no download needed for these tests).
  serverId = crypto.randomUUID();
  const dir = path.join(root, "servers", "test");
  await fs.mkdir(path.join(dir, "world"), { recursive: true });
  await fs.writeFile(path.join(dir, "server.properties"), "motd=Test\nmax-players=20\n");
  await fs.writeFile(path.join(dir, ".craftpanel"), "{}");
  const now = Date.now();
  await ctx.database.db.insert(servers).values({
    id: serverId, name: "Test", software: "vanilla", mcVersion: "1.21.11", javaMajor: 21, memoryMb: 1024, directory: dir, port: 25599,
    installState: "installed", jarFile: "server.jar", createdAt: now, updatedAt: now,
  });
});

afterAll(async () => {
  await app?.close();
  ctx?.database.close();
  await fs.rm(root, { recursive: true, force: true });
});

describe("authentication", () => {
  it("refuses a second setup", async () => {
    const r = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { username: "evil", password: "evil-password-1" } });
    expect(r.statusCode).toBe(409);
  });
  it("rejects wrong passwords with a generic message", async () => {
    const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "owner", password: "wrong-password" } });
    expect(r.statusCode).toBe(401);
    expect(r.json().error.message).toBe("Incorrect username or password");
  });
  it("requires a session for API routes", async () => {
    expect((await call(null, "GET", "/api/servers")).statusCode).toBe(401);
  });
  it("requires the CSRF token on state-changing requests", async () => {
    const r = await call(owner, "POST", `/api/servers/${serverId}/command`, { command: "list" }, false);
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe("csrf");
  });
  it("rejects cross-origin state-changing requests", async () => {
    const r = await app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie: owner.cookie, "x-csrf-token": owner.csrf, origin: "https://evil.example", host: "127.0.0.1:8080" } });
    expect(r.statusCode).toBe(403);
  });
  it("stores only password hashes", async () => {
    const rows = ctx.database.raw.prepare("SELECT password_hash FROM users").all() as { password_hash: string }[];
    expect(rows.every((r) => r.password_hash.startsWith("scrypt$") && !r.password_hash.includes("password"))).toBe(true);
  });
});

describe("RBAC is enforced server-side", () => {
  const cases: [string, "GET" | "POST" | "PUT" | "DELETE", () => string, object | undefined, Record<string, number>][] = [
    ["view servers", "GET", () => "/api/servers", undefined, { viewer: 200, operator: 200, admin: 200 }],
    ["stop server", "POST", () => `/api/servers/${serverId}/stop`, {}, { viewer: 403, operator: 409, admin: 409 }],
    ["kill server", "POST", () => `/api/servers/${serverId}/kill`, {}, { viewer: 403, operator: 403, admin: 409 }],
    ["read files", "GET", () => `/api/servers/${serverId}/files`, undefined, { viewer: 403, operator: 403, admin: 200 }],
    ["edit properties", "PUT", () => `/api/servers/${serverId}/properties`, { values: { motd: "x" } }, { viewer: 403, operator: 403, admin: 204 }],
    ["manage users", "GET", () => "/api/users", undefined, { viewer: 403, operator: 403, admin: 403 }],
    ["audit log", "GET", () => "/api/audit", undefined, { viewer: 403, operator: 403, admin: 200 }],
    ["delete server", "DELETE", () => `/api/servers/${crypto.randomUUID()}`, undefined, { viewer: 403, operator: 403, admin: 404 }],
  ];
  for (const [name, method, url, payload, expected] of cases) {
    for (const [role, status] of Object.entries(expected)) {
      it(`${role} → ${name} = ${status}`, async () => {
        expect((await call(sessions[role], method, url(), payload)).statusCode).toBe(status);
      });
    }
  }
  it("operators cannot grant Minecraft operator status", async () => {
    expect((await call(sessions.operator, "POST", `/api/servers/${serverId}/players/op`, { name: "Steve" })).statusCode).toBe(403);
  });
  it("disabling a user ends their sessions", async () => {
    const users = (await call(owner, "GET", "/api/users")).json() as { id: string; username: string }[];
    const viewer = users.find((u) => u.username === "viewer")!;
    expect((await call(owner, "PATCH", `/api/users/${viewer.id}`, { disabled: true })).statusCode).toBe(200);
    expect((await call(sessions.viewer, "GET", "/api/servers")).statusCode).toBe(401);
  });
});

describe("server configuration and files", () => {
  it("validates server.properties values", async () => {
    const bad = await call(sessions.admin, "PUT", `/api/servers/${serverId}/properties`, { values: { "max-players": "-5", pvp: "maybe" } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.details).toHaveProperty("max-players");
    const managed = await call(sessions.admin, "PUT", `/api/servers/${serverId}/properties`, { values: { "server-port": "1" } });
    expect(managed.statusCode).toBe(400);
  });
  it("rejects newline injection in values and commands", async () => {
    expect((await call(sessions.admin, "PUT", `/api/servers/${serverId}/properties`, { values: { motd: "a\nenable-rcon=true" } })).statusCode).toBe(400);
    expect((await call(sessions.operator, "POST", `/api/servers/${serverId}/command`, { command: "say a\nstop" })).statusCode).toBe(400);
  });
  it("blocks path traversal in the file manager", async () => {
    for (const p of ["../../etc/passwd", "..\\..\\x", "/etc/passwd", "C:\\Windows\\win.ini"]) {
      const r = await call(sessions.admin, "GET", `/api/servers/${serverId}/files/content?path=${encodeURIComponent(p)}`);
      expect([400, 404]).toContain(r.statusCode);
    }
    expect((await call(sessions.admin, "GET", `/api/servers/${serverId}/files/content?path=.craftpanel`)).statusCode).toBe(403);
  });
  it("edits files atomically inside the sandbox", async () => {
    expect((await call(sessions.admin, "PUT", `/api/servers/${serverId}/files/content`, { path: "notes/readme.txt", content: "hello" })).statusCode).toBe(204);
    const r = await call(sessions.admin, "GET", `/api/servers/${serverId}/files/content?path=notes/readme.txt`);
    expect(r.json().content).toBe("hello");
  });
  it("refuses to start without EULA acceptance", async () => {
    const r = await call(sessions.operator, "POST", `/api/servers/${serverId}/start`, {});
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("eula_required");
  });
  it("records an audit trail", async () => {
    const audit = (await call(owner, "GET", "/api/audit")).json() as { action: string }[];
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(["auth.setup", "user.create", "server.properties_update", "file.write"]));
  });
});

describe("first-run protection on network-exposed installs", () => {
  it("requires the setup token when bound to a non-loopback address", async () => {
    const otherRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cp-api-lan-"));
    const cfg = { ...config("0.0.0.0"), layout: dataLayout(otherRoot) };
    const c = await createContext(cfg);
    const a = await buildApp(c, { logger: false });
    try {
      expect(c.setupToken).toBeTruthy();
      const state = (await a.inject({ method: "GET", url: "/api/auth/state" })).json();
      expect(state.setupTokenRequired).toBe(true);
      const noToken = await a.inject({ method: "POST", url: "/api/auth/setup", payload: { username: "owner", password: "owner-password-1" } });
      expect(noToken.statusCode).toBe(403);
      const ok = await a.inject({ method: "POST", url: "/api/auth/setup", payload: { username: "owner", password: "owner-password-1", setupToken: c.setupToken } });
      expect(ok.statusCode).toBe(200);
    } finally {
      await a.close();
      c.database.close();
      await fs.rm(otherRoot, { recursive: true, force: true });
    }
  });
});
