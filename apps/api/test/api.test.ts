import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createZip } from "@craftpanel/backup";
import { playerSessions, servers } from "@craftpanel/database";
import { dataLayout } from "@craftpanel/server-runtime";
import { createContext } from "../src/bootstrap";
import { buildApp, nextSegmentPath } from "../src/app";
import { offlineUuid } from "../src/services/game";
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
    tls: null,
    host,
    port: 0,
    layout: dataLayout(root),
    corsOrigins: [],
    secureCookies: false,
    trustProxy: false,
    publicUrl: null,
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
  it("stores resource limits and refuses a memory cap below the heap", async () => {
    const put = (body: object) => call(sessions.admin, "PATCH", `/api/servers/${serverId}`, body);
    const tooSmall = await put({ limitMemoryMb: 1100 });
    expect(tooSmall.statusCode).toBe(400);
    expect(tooSmall.json().error.message).toMatch(/at least 1280 MB/);
    expect((await put({ limitCpuPercent: 5 })).statusCode).toBe(400);
    expect((await put({ limitProcesses: 10 })).statusCode).toBe(400);
    const set = await put({ limitMemoryMb: 2048, limitCpuPercent: 150, limitProcesses: 0 });
    expect(set.statusCode).toBe(200);
    expect(set.json()).toMatchObject({ limitMemoryMb: 2048, limitCpuPercent: 150, limitProcesses: 0, resourceLimits: { effective: { memoryMb: 2048, cpuPercent: 150 }, available: false } });
    expect(set.json().resourceLimits.effective.tasks).toBeUndefined();
    // A fixed cap must keep fitting when the heap grows.
    expect((await put({ memoryMb: 2048 })).statusCode).toBe(400);
    const defaults = await put({ limitMemoryMb: null, limitCpuPercent: null, limitProcesses: null });
    expect(defaults.json().resourceLimits.effective).toEqual({ memoryMb: 2048, tasks: 4096 });
  });
  it("rejects newline injection in values and commands", async () => {
    expect((await call(sessions.admin, "PUT", `/api/servers/${serverId}/properties`, { values: { "level-seed": "a\nenable-rcon=true" } })).statusCode).toBe(400);
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

describe("remote access policy", () => {
  const from = (remoteAddress: string, method: "GET" | "PUT" = "GET", url = "/api/health", payload?: object) =>
    app.inject({ method, url, payload, remoteAddress, headers: { cookie: owner.cookie, "x-csrf-token": owner.csrf } });

  it("allows private networks and VPNs by default and blocks public addresses", async () => {
    expect((await from("192.168.1.20")).statusCode).toBe(200);
    expect((await from("100.101.1.2")).statusCode).toBe(200); // Tailscale
    const blocked = await from("203.0.113.7");
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe("https_required");
  });

  it("applies policy changes immediately and always lets the host in", async () => {
    expect((await call(owner, "PUT", "/api/settings", { dashboardAccess: "local" })).statusCode).toBe(200);
    expect((await from("192.168.1.20")).statusCode).toBe(403);
    expect((await from("127.0.0.1")).statusCode).toBe(200);
    expect((await call(owner, "PUT", "/api/settings", { dashboardAccess: "private", allowedNetworks: ["192.168.1.0/24"] })).statusCode).toBe(200);
    expect((await from("192.168.1.20")).statusCode).toBe(200);
    expect((await from("203.0.113.7")).statusCode).toBe(403);
    expect((await from("198.51.100.1")).statusCode).toBe(403);
    expect((await call(owner, "PUT", "/api/settings", { allowedNetworks: [] })).statusCode).toBe(200);
  });

  it("rejects invalid networks and changes that would lock out the requester", async () => {
    const bad = await call(owner, "PUT", "/api/settings", { allowedNetworks: ["example.com"] });
    expect(bad.statusCode).toBe(400);
    const lockout = await from("192.168.1.20", "PUT", "/api/settings", { dashboardAccess: "local" });
    expect(lockout.statusCode).toBe(400);
    expect(lockout.json().error.message).toContain("block your own connection");
  });

  it("reports reachable addresses for the dashboard", async () => {
    const sys = (await call(owner, "GET", "/api/system")).json();
    expect(sys.dashboard.urls[0]).toMatchObject({ kind: "local" });
    expect(sys.dashboard).toMatchObject({ profile: "local", https: false });
  });

  it("restricts deployment diagnostics to application administrators", async () => {
    expect((await call(sessions.operator!, "GET", "/api/system/diagnostics")).statusCode).toBe(403);
    const response = await call(owner, "GET", "/api/system/diagnostics");
    expect(response.statusCode).toBe(200);
    expect(response.json().checks).toContainEqual(expect.objectContaining({ id: "database", status: "ok" }));
  });
});

describe("updates and installer control", () => {
  it("lets only administrators see the update status and respects the opt-out", async () => {
    expect((await call(sessions.operator!, "GET", "/api/updates")).statusCode).toBe(403);
    expect((await call(owner, "PUT", "/api/settings", { updateCheck: false })).statusCode).toBe(200);
    const status = (await call(owner, "GET", "/api/updates")).json();
    expect(status).toMatchObject({ enabled: false, available: false, install: { method: "manual" } });
  });

  it("shuts down over the local control channel only with the token", async () => {
    let stopped = 0;
    const controlled = await buildApp(ctx, { logger: false, control: { token: "secret-token", shutdown: () => stopped++ } });
    try {
      expect((await controlled.inject({ method: "POST", url: "/api/control/shutdown" })).statusCode).toBe(403);
      expect((await controlled.inject({ method: "POST", url: "/api/control/shutdown", headers: { "x-craftpanel-control": "wrong-token!" } })).statusCode).toBe(403);
      // A forwarded header must not make a remote request look local.
      expect((await controlled.inject({ method: "POST", url: "/api/control/shutdown", remoteAddress: "192.168.1.20", headers: { "x-craftpanel-control": "secret-token", "x-forwarded-for": "127.0.0.1" } })).statusCode).toBe(403);
      expect(stopped).toBe(0);
      expect((await controlled.inject({ method: "POST", url: "/api/control/shutdown", headers: { "x-craftpanel-control": "secret-token" } })).statusCode).toBe(202);
      await new Promise((r) => setImmediate(r));
      expect(stopped).toBe(1);
      // Without a control token (tests, embedding) the endpoint is closed.
      expect((await app.inject({ method: "POST", url: "/api/control/shutdown", headers: { "x-craftpanel-control": "secret-token" } })).statusCode).toBe(403);
    } finally {
      await controlled.close();
    }
  });
});

describe("nextSegmentPath", () => {
  it("maps the router's prefetch URLs onto the files the static export writes", () => {
    expect(nextSegmentPath("/servers/new/__next.servers.new.__PAGE__.txt?_rsc=1")).toBe("/servers/new/__next.servers/new/__PAGE__.txt?_rsc=1");
    expect(nextSegmentPath("/server/__next.server.__PAGE__.txt?id=x")).toBe("/server/__next.server/__PAGE__.txt?id=x");
    for (const u of ["/__next.__PAGE__.txt", "/servers/__next._tree.txt", "/api/servers", "/x/__next.a.__PAGE__.txt/../../etc"]) expect(nextSegmentPath(u)).toBe(u);
  });
});

describe("duplicate plugin prevention", () => {
  let paperId: string;
  let paperDir: string;

  async function makeJar(name: string, pluginYml: string): Promise<string> {
    const src = path.join(root, "jar-src", name);
    const out = path.join(root, "jar-out", name);
    await fs.mkdir(src, { recursive: true });
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(path.join(src, "plugin.yml"), pluginYml);
    await createZip({ sourceDir: src, destination: out });
    return out;
  }

  beforeAll(async () => {
    paperId = crypto.randomUUID();
    paperDir = path.join(root, "servers", "paper-dup");
    await fs.mkdir(path.join(paperDir, "plugins"), { recursive: true });
    await fs.writeFile(path.join(paperDir, ".craftpanel"), "{}");
    const now = Date.now();
    await ctx.database.db.insert(servers).values({
      id: paperId, name: "PaperDup", software: "paper", mcVersion: "1.21.11", javaMajor: 21, memoryMb: 1024, directory: paperDir, port: 25600,
      installState: "installed", jarFile: "server.jar", createdAt: now, updatedAt: now,
    });
  });

  it("refuses duplicate uploads and marketplace installs even across different filenames or disabled state", async () => {
    const row = await ctx.servers.row(paperId);
    const actor = { id: "owner", username: "owner", ip: "127.0.0.1" };
    const jarV1 = await makeJar("WorldEdit-7.3.0.jar", "name: WorldEdit\nversion: 7.3.0\nmain: com.sk89q.worldedit.bukkit.WorldEditPlugin\n");
    const jarV2 = await makeJar("WorldEdit-7.3.1.jar", "name: WorldEdit\nversion: 7.3.1\nmain: com.sk89q.worldedit.bukkit.WorldEditPlugin\n");

    await ctx.game.installUploadedPlugin(row, jarV1, "WorldEdit-7.3.0.jar", actor);

    // Uploading another version of the same plugin with a different filename is rejected with 409 Conflict.
    await expect(ctx.game.installUploadedPlugin(row, jarV2, "WorldEdit-7.3.1.jar", actor)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("WorldEdit is already installed (WorldEdit-7.3.0.jar)"),
    });

    // Disabling the plugin still prevents installing a second copy via upload, Modrinth or Hangar.
    await ctx.game.togglePlugin(row, "WorldEdit-7.3.0.jar", false, actor);
    await expect(ctx.game.installUploadedPlugin(row, jarV1, "WorldEdit-7.3.0.jar", actor)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("WorldEdit is already installed (WorldEdit-7.3.0.jar.disabled)"),
    });

    const modrinthDup = await call(owner, "POST", `/api/servers/${paperId}/plugins/install`, { projectId: "WorldEdit" });
    expect(modrinthDup.statusCode).toBe(409);
    expect(modrinthDup.json().error.message).toContain("WorldEdit is already installed");

    const hangarDup = await call(owner, "POST", `/api/servers/${paperId}/plugins/hangar/install`, { project: "WorldEdit" });
    expect(hangarDup.statusCode).toBe(409);
    expect(hangarDup.json().error.message).toContain("WorldEdit is already installed");

    // If a second jar was placed manually on disk, enabling the disabled duplicate is blocked while the other is enabled.
    await fs.copyFile(jarV2, path.join(paperDir, "plugins", "WorldEdit-7.3.1.jar"));
    const enableDup = await call(owner, "PATCH", `/api/servers/${paperId}/plugins/${encodeURIComponent("WorldEdit-7.3.0.jar.disabled")}`, { enabled: true });
    expect(enableDup.statusCode).toBe(409);
    expect(enableDup.json().error.message).toContain("WorldEdit is already enabled (WorldEdit-7.3.1.jar)");
  });
});

describe("player profiles", () => {
  const nbtStr = (s: string) => {
    const b = Buffer.from(s, "utf8");
    const len = Buffer.alloc(2);
    len.writeUInt16BE(b.length);
    return Buffer.concat([len, b]);
  };
  const i32 = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeInt32BE(n);
    return b;
  };
  const tag = (type: number, name: string, payload: Buffer) => Buffer.concat([Buffer.from([type]), nbtStr(name), payload]);
  const compound = (name: string, ...kids: Buffer[]) => tag(10, name, Buffer.concat([...kids, Buffer.from([0])]));
  const playerDat = zlib.gzipSync(
    compound(
      "",
      tag(5, "Health", Buffer.from([0x41, 0x90, 0x00, 0x00])), // 18
      tag(3, "XpLevel", i32(7)),
      tag(
        9,
        "Inventory",
        Buffer.concat([Buffer.from([10]), i32(1), tag(1, "Slot", Buffer.from([2])), tag(8, "id", nbtStr("minecraft:apple")), tag(3, "count", i32(5)), Buffer.from([0])]),
      ),
    ),
  );

  const alex = "Alex";
  const steve = "Steve";
  let viewer: Session;
  let alexUuid: string;
  const steveUuid = "11111111-2222-3333-8444-555555555555";

  beforeAll(async () => {
    // The shared viewer is disabled by an earlier test; this suite uses its own read-only account.
    expect((await call(owner, "POST", "/api/users", { username: "profile-viewer", password: "profile-viewer-1", role: "viewer" })).statusCode).toBe(200);
    viewer = await login("profile-viewer", "profile-viewer-1");
    const dir = path.join(root, "servers", "test");
    await fs.writeFile(path.join(dir, "server.properties"), "motd=Test\nmax-players=20\nonline-mode=false\n");
    alexUuid = offlineUuid(alex);
    const now = Date.now();
    await ctx.database.db.insert(playerSessions).values([
      { serverId, name: alex, uuid: alexUuid, ip: "10.0.0.2", joinedAt: now - 7_200_000, leftAt: now - 3_600_000 },
      { serverId, name: alex, uuid: alexUuid, ip: "10.0.0.2", joinedAt: now - 1_800_000, leftAt: now - 900_000 },
      { serverId, name: steve, uuid: steveUuid, ip: null, joinedAt: now - 60_000, leftAt: now - 30_000 },
    ]);
    // The classic layout for Alex, the layout of newer versions (players/…) for Steve.
    for (const sub of ["stats", "advancements", "playerdata"]) await fs.mkdir(path.join(dir, "world", sub), { recursive: true });
    await fs.writeFile(path.join(dir, "world", "stats", `${alexUuid}.json`), JSON.stringify({ stats: { "minecraft:custom": { "minecraft:deaths": 2, "minecraft:walk_one_cm": 250_000 }, "minecraft:mined": { "minecraft:stone": 10 } } }));
    await fs.writeFile(path.join(dir, "world", "advancements", `${alexUuid}.json`), JSON.stringify({ "minecraft:story/root": { done: true, criteria: { x: "2024-05-01 10:00:00 +0200" } } }));
    await fs.writeFile(path.join(dir, "world", "playerdata", `${alexUuid}.dat`), playerDat);
    for (const sub of ["stats", "data"]) await fs.mkdir(path.join(dir, "world", "players", sub), { recursive: true });
    await fs.writeFile(path.join(dir, "world", "players", "stats", `${steveUuid}.json`), JSON.stringify({ stats: { "minecraft:custom": { "minecraft:deaths": 9 } } }));
    await fs.writeFile(path.join(dir, "world", "players", "data", `${steveUuid}.dat`), playerDat);
  });

  const profile = (s: Session | null, name: string, qs = "") => call(s, "GET", `/api/servers/${serverId}/players/${name}/profile${qs}`);

  it("assembles sessions, statistics, advancements and the inventory", async () => {
    const r = await profile(viewer, alex);
    expect(r.statusCode).toBe(200);
    const p = r.json();
    expect(p).toMatchObject({ name: alex, uuid: alexUuid, online: false, world: "world" });
    expect(p.activity).toMatchObject({ sessions: 2 });
    expect(p.activity.playtimeMs).toBeGreaterThan(1_700_000);
    expect(p.stats).toMatchObject({ deaths: 2, mined: [{ id: "minecraft:stone", count: 10 }] });
    expect(p.stats.distances).toEqual([{ id: "walk", cm: 250_000 }]);
    expect(p.advancements.done).toBe(1);
    expect(p.state).toMatchObject({ health: 18, xpLevel: 7, inventory: [{ slot: 2, id: "minecraft:apple", count: 5 }] });
    expect(p.savedAt).toBeGreaterThan(0);
  });

  it("finds the files of newer Minecraft versions under players/", async () => {
    const p = (await profile(viewer, steve)).json();
    expect(p.stats.deaths).toBe(9);
    expect(p.state.inventory[0].id).toBe("minecraft:apple");
    expect(p.advancements).toBeNull();
  });

  it("buckets by the time zone the browser sends and ignores nonsense", async () => {
    const utc = (await profile(viewer, alex, "?tz=0")).json();
    const east = (await profile(viewer, alex, "?tz=-600")).json();
    expect(utc.activity.heat.flat().reduce((a: number, b: number) => a + b, 0)).toBe(east.activity.heat.flat().reduce((a: number, b: number) => a + b, 0));
    expect((await profile(viewer, alex, "?tz=banana")).statusCode).toBe(200);
  });

  it("lists everyone in the players overview, newest first", async () => {
    const r = (await call(viewer, "GET", `/api/servers/${serverId}/players`)).json();
    expect(r.roster.map((x: { name: string }) => x.name)).toEqual([steve, alex]);
    expect(r.roster[1]).toMatchObject({ sessions: 2, banned: false, online: false });
  });

  it("shows IP addresses only to users who can manage players", async () => {
    const seen = (await profile(owner, alex)).json();
    expect(seen.activity.addresses).toEqual([expect.objectContaining({ ip: "10.0.0.2", sessions: 2 })]);
    expect(seen.activity.recent[0].ip).toBe("10.0.0.2");
    const hidden = (await profile(viewer, alex)).json();
    expect(hidden.activity.addresses).toEqual([]);
    expect(hidden.activity.recent.every((r: { ip: string | null }) => r.ip === null)).toBe(true);
    expect(JSON.stringify((await call(viewer, "GET", `/api/servers/${serverId}/players`)).json())).not.toContain("10.0.0.2");
    expect(JSON.stringify((await call(owner, "GET", `/api/servers/${serverId}/players`)).json())).toContain("10.0.0.2");
  });

  it("answers 404 for unknown players, 400 for invalid names, 401 without a session", async () => {
    expect((await profile(viewer, "Nobody")).statusCode).toBe(404);
    expect((await profile(viewer, "bad%20name")).statusCode).toBe(400);
    expect((await profile(viewer, "..%2F..%2Fetc")).statusCode).toBeGreaterThanOrEqual(400);
    expect((await profile(null, alex)).statusCode).toBe(401);
  });

  it("never asks about a skin for an offline-mode or malformed UUID", async () => {
    expect((await call(viewer, "GET", `/api/skins/${alexUuid}`)).statusCode).toBe(404);
    expect((await call(viewer, "GET", "/api/skins/not-a-uuid")).statusCode).toBe(404);
    expect((await call(null, "GET", `/api/skins/${alexUuid}`)).statusCode).toBe(401);
  });
});

describe("server appearance", () => {
  const crc = (b: Buffer) => {
    const out = Buffer.alloc(4);
    out.writeUInt32BE(zlib.crc32(b));
    return out;
  };
  const chunk = (type: string, body: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    const t = Buffer.concat([Buffer.from(type, "latin1"), body]);
    return Buffer.concat([len, t, crc(t)]);
  };
  const png = (w = 64, h = 64) => {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr.set([8, 6, 0, 0, 0], 8);
    const rows = Buffer.alloc(h * (1 + w * 4), 0x7f);
    for (let y = 0; y < h; y++) rows[y * (1 + w * 4)] = 0;
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
  };
  const put = (s: Session | null, data: Buffer | string) => call(s, "PUT", `/api/servers/${serverId}/icon`, { png: typeof data === "string" ? data : data.toString("base64") });
  const listed = async () => (await call(sessions.admin, "GET", "/api/servers")).json().find((x: { id: string }) => x.id === serverId);
  let viewer: Session;

  beforeAll(async () => {
    expect((await call(owner, "POST", "/api/users", { username: "look-viewer", password: "look-viewer-1", role: "viewer" })).statusCode).toBe(200);
    viewer = await login("look-viewer", "look-viewer-1");
  });

  it("has no icon at first", async () => {
    expect((await call(viewer, "GET", `/api/servers/${serverId}/icon`)).statusCode).toBe(404);
    expect((await listed()).iconVersion).toBeNull();
  });

  it("stores a 64×64 PNG as server-icon.png and serves it back to everyone who can see the server", async () => {
    const file = png();
    expect((await put(viewer, file)).statusCode).toBe(403);
    expect((await put(sessions.admin, file)).statusCode).toBe(204);
    expect(await fs.readFile(path.join(root, "servers", "test", "server-icon.png"))).toEqual(file);
    const r = await call(viewer, "GET", `/api/servers/${serverId}/icon`);
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toBe("image/png");
    expect(r.rawPayload).toEqual(file);
    expect((await listed()).iconVersion).toBeGreaterThan(0);
    expect((await call(null, "GET", `/api/servers/${serverId}/icon`)).statusCode).toBe(401);
  });

  it("refuses anything that is not a sound 64×64 PNG", async () => {
    const good = png();
    const damaged = Buffer.from(good);
    damaged[40] ^= 0xff;
    const cases: [string, Buffer | string][] = [
      ["wrong size", png(32, 32)],
      ["not a png", Buffer.from("GIF89a-not-a-png-at-all-just-text-padded-out-to-be-long-enough")],
      ["damaged data", damaged],
      ["cut off", good.subarray(0, good.length - 20)],
      ["not base64", "***"],
    ];
    for (const [label, data] of cases) expect((await put(sessions.admin, data)).statusCode, label).toBe(400);
    expect(await fs.readFile(path.join(root, "servers", "test", "server-icon.png"))).toEqual(good);
  });

  it("removes the icon", async () => {
    expect((await call(viewer, "DELETE", `/api/servers/${serverId}/icon`)).statusCode).toBe(403);
    expect((await call(sessions.admin, "DELETE", `/api/servers/${serverId}/icon`)).statusCode).toBe(204);
    expect((await call(sessions.admin, "DELETE", `/api/servers/${serverId}/icon`)).statusCode).toBe(204);
    expect((await call(viewer, "GET", `/api/servers/${serverId}/icon`)).statusCode).toBe(404);
    expect((await listed()).iconVersion).toBeNull();
  });

  it("keeps a two-line message of the day as one escaped property and refuses a third line", async () => {
    const motd = "§6§lWelcome\n§7to the server";
    expect((await call(sessions.admin, "PUT", `/api/servers/${serverId}/properties`, { values: { motd } })).statusCode).toBe(204);
    const text = await fs.readFile(path.join(root, "servers", "test", "server.properties"), "utf8");
    expect(text.split("\n").filter((l) => l.startsWith("motd="))).toHaveLength(1);
    expect((await call(sessions.admin, "GET", `/api/servers/${serverId}/properties`)).json().values.motd).toBe(motd);
    expect((await call(sessions.admin, "PUT", `/api/servers/${serverId}/properties`, { values: { motd: "a\nb\nc" } })).statusCode).toBe(400);
    const injected = await call(sessions.admin, "PUT", `/api/servers/${serverId}/properties`, { values: { motd: "a\nenable-rcon=true" } });
    expect(injected.statusCode).toBe(204);
    expect((await call(sessions.admin, "GET", `/api/servers/${serverId}/properties`)).json().values["enable-rcon"]).toBeUndefined();
  });
});

describe("rotating server list messages", () => {
  let paperId: string;
  let paperDir: string;
  let viewer: Session;
  const url = () => `/api/servers/${paperId}/motd-rotation`;
  const frames = ["§6§lMoonlight\n§7Survival", "§bCome and play\n§7New friends welcome"];
  const exists = (p: string) => fs.access(p).then(() => true, () => false);

  beforeAll(async () => {
    expect((await call(owner, "POST", "/api/users", { username: "rotation-viewer", password: "rotation-viewer-1", role: "viewer" })).statusCode).toBe(200);
    viewer = await login("rotation-viewer", "rotation-viewer-1");
    paperId = crypto.randomUUID();
    paperDir = path.join(root, "servers", "paper-rotation");
    await fs.mkdir(path.join(paperDir, "world"), { recursive: true });
    await fs.writeFile(path.join(paperDir, "server.properties"), "motd=Test\n");
    await fs.writeFile(path.join(paperDir, ".craftpanel"), "{}");
    const now = Date.now();
    await ctx.database.db.insert(servers).values({
      id: paperId, name: "Paper", software: "paper", mcVersion: "1.21.4", javaMajor: 21, memoryMb: 1024, directory: paperDir, port: 25598,
      installState: "installed", jarFile: "server.jar", createdAt: now, updatedAt: now,
    });
  });

  it("starts empty and supported on Paper, and says it is not supported on Vanilla", async () => {
    const r = await call(viewer, "GET", url());
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ supported: true, interval: 5, frames: [] });
    expect((await call(sessions.admin, "GET", `/api/servers/${serverId}/motd-rotation`)).json().supported).toBe(false);
  });

  it("writes the messages where the plugin reads them and installs the plugin", async () => {
    expect((await call(viewer, "PUT", url(), { interval: 5, frames })).statusCode).toBe(403);
    expect((await call(sessions.admin, "PUT", url(), { interval: 3, frames })).statusCode).toBe(204);
    const file = await fs.readFile(path.join(paperDir, "plugins", "CraftPanelInfo", "motd.txt"), "utf8");
    expect(file).toContain("interval=3");
    expect(file.split("\n").filter((l) => l.startsWith("frame="))).toHaveLength(2);
    expect((await call(viewer, "GET", url())).json()).toEqual({ supported: true, interval: 3, frames });
    expect(await exists(path.join(paperDir, "plugins", "CraftPanelInfo.jar"))).toBe(true);
    // The info command is on by default, so /craftpanel stays available.
    expect(await exists(path.join(paperDir, "plugins", "CraftPanelInfo", "info-off"))).toBe(false);
  });

  it("refuses what the server list could not show, and Vanilla", async () => {
    const bad: [string, object][] = [
      ["three lines", { interval: 5, frames: ["a\nb\nc"] }],
      ["an empty message", { interval: 5, frames: ["§6§l  "] }],
      ["nine messages", { interval: 5, frames: Array.from({ length: 9 }, (_, i) => `m${i}`) }],
      ["a carriage return", { interval: 5, frames: ["a\rb"] }],
      ["no time", { interval: 0, frames: ["a"] }],
    ];
    for (const [label, body] of bad) expect((await call(sessions.admin, "PUT", url(), body)).statusCode, label).toBe(400);
    expect((await call(sessions.admin, "PUT", `/api/servers/${serverId}/motd-rotation`, { interval: 5, frames: ["a"] })).statusCode).toBe(400);
    expect((await call(viewer, "GET", url())).json().frames).toEqual(frames);
  });

  it("keeps the plugin for the messages when the info command is off, and hides /craftpanel", async () => {
    expect((await call(sessions.admin, "PATCH", `/api/servers/${paperId}`, { infoCommand: false })).statusCode).toBe(200);
    expect((await call(sessions.admin, "PUT", url(), { interval: 3, frames })).statusCode).toBe(204);
    expect(await exists(path.join(paperDir, "plugins", "CraftPanelInfo.jar"))).toBe(true);
    expect(await exists(path.join(paperDir, "plugins", "CraftPanelInfo", "info-off"))).toBe(true);
  });

  it("removes the messages, and the plugin with them when the info command is off too", async () => {
    expect((await call(sessions.admin, "PUT", url(), { interval: 5, frames: [] })).statusCode).toBe(204);
    expect(await exists(path.join(paperDir, "plugins", "CraftPanelInfo", "motd.txt"))).toBe(false);
    expect(await exists(path.join(paperDir, "plugins", "CraftPanelInfo.jar"))).toBe(false);
    expect((await call(viewer, "GET", url())).json().frames).toEqual([]);
  });
});
