import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { servers } from "@craftpanel/database";
import { DEFAULT_MAP_SETTINGS, mapSettingsSchema } from "@craftpanel/shared";
import { dataLayout } from "@craftpanel/server-runtime";
import { createContext } from "../src/bootstrap";
import { buildApp } from "../src/app";
import type { AppContext } from "../src/context";
import { dimensionOf, mapConf, renderThreads, withManagedBlock, worldMapId } from "../src/services/map-config";
import { checkPassword, hashPassword } from "../src/services/map";

describe("map configuration", () => {
  it("replaces the managed block while retaining user configuration and comments", () => {
    const base = '# custom setting\nname: "My world"\n';
    const first = withManagedBlock(base, ["enable-hires: true"]);
    const next = withManagedBlock(first, ["enable-hires: false"]);
    expect(next).toContain(base);
    expect(next).not.toContain("enable-hires: true");
    expect(next.match(/>>> CraftPanel/g)).toHaveLength(1);
    expect(withManagedBlock(next, ["enable-hires: false"])).toBe(next);
  });
  it("keeps the Nether visible, including its underground terrain", () => {
    expect(dimensionOf('dimension: "minecraft:the_nether"\n')).toBe("nether");
    const lines = mapConf({ ...DEFAULT_MAP_SETTINGS, radius: 0 }, "nether");
    expect(lines).toContain("render-mask: [ { max-y: 90 } ]");
    expect(lines).toContain("remove-caves-below-y: -10000");
    expect(mapConf(DEFAULT_MAP_SETTINGS, "end", false)).toContain("world: null");
    expect(worldMapId("My world", "_nether")).toMatch(/^My_world-[a-f0-9]{8}_nether$/);
    expect(worldMapId("My world", "")).not.toBe(worldMapId("My.world", ""));
  });
  it("validates nonempty dimensions, radius, passwords and resource bounds", () => {
    expect(mapSettingsSchema.safeParse({ ...DEFAULT_MAP_SETTINGS, radius: 0 }).success).toBe(true);
    for (const patch of [{ radius: 20 }, { radius: -1 }, { overworld: false, nether: false, end: false }, { centerX: Infinity }, { maxDiskMb: -1 }]) {
      expect(mapSettingsSchema.safeParse({ ...DEFAULT_MAP_SETTINGS, ...patch }).success).toBe(false);
    }
    expect(renderThreads("gentle", 16)).toBe(1);
    expect(renderThreads("balanced", 8)).toBe(4);
    expect(renderThreads("fast", 8)).toBe(7);
    expect(renderThreads("fast", 1)).toBe(1);
    const hash = hashPassword("map-password");
    expect(hash).not.toContain("map-password");
    expect(checkPassword("map-password", hash)).toBe(true);
    expect(checkPassword("wrong", hash)).toBe(false);
  });
});

describe("map activation and serving", () => {
  let root: string;
  let dir: string;
  let ctx: AppContext;
  let app: FastifyInstance;
  let upstream: http.Server;
  let id: string;
  let running = false;
  let status = "stopped";
  let owner: { cookie: string; csrf: string };
  let viewer: { cookie: string; csrf: string };
  let limited: { cookie: string; csrf: string };
  let receivedCookie: string | undefined;
  const logged: string[] = [];
  let privateLink: string;
  const commands: string[] = [];
  const session = (r: { headers: Record<string, unknown>; json: () => { csrfToken: string } }) => ({ cookie: String(r.headers["set-cookie"]).split(";")[0]!, csrf: r.json().csrfToken });
  const call = (auth: typeof owner | null, method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: object) => app.inject({ method, url, payload,
    headers: auth ? { cookie: auth.cookie, "x-csrf-token": auth.csrf } : {} });
  const put = (patch: object) => call(owner, "PUT", `/api/servers/${id}/map`, { ...DEFAULT_MAP_SETTINGS, ...patch });

  beforeAll(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "cp-map-"));
    dir = path.join(root, "servers", "test");
    await fsp.mkdir(path.join(dir, "plugins"), { recursive: true });
    await fsp.writeFile(path.join(dir, "plugins", "bluemap-test.jar"), "test-only");
    await fsp.writeFile(path.join(dir, "server.properties"), "level-name=world\n");
    ctx = await createContext({ profile: "local", host: "127.0.0.1", port: 0, serveWeb: false, webDir: null, logFormat: "json", tls: null,
      layout: dataLayout(root), corsOrigins: [], secureCookies: false, trustProxy: false, publicUrl: null, sessionTtlMs: 3600_000, logLevel: "silent", isLoopbackOnly: true });
    vi.spyOn(ctx.agent, "isRunning").mockImplementation(() => running);
    vi.spyOn(ctx.agent, "status").mockImplementation(() => status as "running" | "stopped");
    vi.spyOn(ctx.servers, "start").mockImplementation(async () => { running = true; status = "running"; });
    vi.spyOn(ctx.servers, "stop").mockImplementation(async () => { running = false; status = "stopped"; });
    vi.spyOn(ctx.servers, "sendCommand").mockImplementation(async (_id, command) => { commands.push(command); });
    app = await buildApp(ctx, { logger: { level: "error", stream: { write: (line: string) => void logged.push(line) } } });
    owner = session(await call(null, "POST", "/api/auth/setup", { username: "owner", password: "owner-password-1" }));
    for (const [username, scope] of [["viewer", "all"], ["limited", "selected"]]) {
      await call(owner, "POST", "/api/users", { username, password: "viewer-password-1", role: "viewer", serverScope: scope, serverRoles: {} });
      const auth = session(await call(null, "POST", "/api/auth/login", { username, password: "viewer-password-1" }));
      if (username === "viewer") viewer = auth; else limited = auth;
    }
    id = crypto.randomUUID();
    await ctx.database.db.insert(servers).values({ id, name: "Map test", software: "paper", mcVersion: "1.21.11", javaMajor: 21, memoryMb: 3072,
      directory: dir, port: 25588, installState: "installed", eulaAccepted: true, jarFile: "server.jar", createdAt: Date.now(), updatedAt: Date.now() });
  });
  afterAll(async () => {
    ctx?.maps.stop();
    await app?.close();
    if (upstream) await new Promise<void>((resolve) => upstream.close(() => resolve()));
    ctx?.database.close();
    vi.restoreAllMocks();
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("keeps the page hidden before activation and checks EULA consent and RBAC", async () => {
    expect((await call(owner, "GET", `/api/servers/${id}/map`)).json().pageReady).toBe(false);
    expect((await call(owner, "POST", `/api/servers/${id}/map/install`, {})).statusCode).toBe(400);
    expect((await call(viewer, "POST", `/api/servers/${id}/map/install`, { acceptMojangEula: true })).statusCode).toBe(403);
    expect((await call(limited, "GET", `/api/servers/${id}/map`)).statusCode).toBe(404);
    expect((await call(null, "POST", `/api/servers/${id}/map/link`)).statusCode).toBe(401);
  });
  it("automatically configures and starts the server but reveals the page only once the viewer works", async () => {
    running = true; status = "running";
    expect((await call(owner, "POST", `/api/servers/${id}/map/install`, { acceptMojangEula: true })).statusCode).toBe(202);
    await vi.waitFor(() => expect(ctx.servers.start).toHaveBeenCalledOnce());
    expect(ctx.servers.stop).toHaveBeenCalledOnce();
    const before = (await call(owner, "GET", `/api/servers/${id}/map`)).json();
    expect(before.installed).toBe(true);
    expect(before.pageReady).toBe(false);
    expect(before.setupStage).toBe("preparing");
    expect(await fsp.readFile(path.join(dir, "plugins/BlueMap/maps/world.conf"), "utf8")).toContain("min-x: -3000");
    const row = await ctx.servers.row(id);
    const state = (await ctx.maps.state(row))!;
    upstream = http.createServer((req, res) => {
      receivedCookie = req.headers.cookie;
      if (req.url === "/assets/cut-off.png") { res.writeHead(200, { "content-type": "image/png", "content-length": "100" }); res.flushHeaders(); setTimeout(() => res.socket?.destroy(), 20); return; }
      else if (req.url === "/settings.json") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ version: "5.16", maps: ["world", "world_nether", "world_the_end"] })); }
      else { res.setHeader("content-type", req.url?.endsWith(".js") ? "application/javascript" : "text/html"); res.setHeader("set-cookie", "bad=1"); res.end("<!doctype html><head></head><script>test</script>"); }
    });
    await new Promise<void>((resolve) => upstream.listen(state.port, "127.0.0.1", resolve));
    const ready = (await call(owner, "GET", `/api/servers/${id}/map`)).json();
    expect(ready.pageReady).toBe(true);
    expect(ready.setupStage).toBe(null);
    running = false; status = "stopped";
    expect((await call(owner, "GET", `/api/servers/${id}/map`)).json().pageReady).toBe(true);
    running = true; status = "running";
  });
  it("isolates map code, never forwards session cookies, and revokes private links on logout", async () => {
    expect((await call(null, "GET", `/map/${id}/`)).statusCode).toBe(401);
    privateLink = (await call(viewer, "POST", `/api/servers/${id}/map/link`)).json().url;
    const wrapper = await call(null, "GET", privateLink);
    expect(wrapper.body).toContain('sandbox="allow-scripts allow-pointer-lock"');
    expect(wrapper.body).not.toContain("allow-same-origin");
    const raw = await call(owner, "GET", privateLink + "v/assets/test.js");
    expect(raw.statusCode).toBe(200);
    expect(raw.headers["content-security-policy"]).toContain("sandbox allow-scripts");
    expect(raw.headers["access-control-allow-origin"]).toBe("*");
    expect(raw.headers["set-cookie"]).toBeUndefined();
    expect(receivedCookie).toBeUndefined();
    expect((await call(null, "GET", privateLink + "v/")).body).toContain('Object.defineProperty(window,name');
    expect((await call(null, "GET", privateLink + "v/lang/settings.conf")).statusCode).toBe(200);
    expect((await call(null, "GET", privateLink + "v/lang/de.conf")).statusCode).toBe(200);
    await call(viewer, "POST", "/api/auth/logout");
    expect((await call(null, "GET", privateLink + "v/settings.json")).statusCode).toBe(401);
  });
  it("serves public maps, filters disabled dimensions and blocks their old data URLs", async () => {
    expect((await put({ access: "public", nether: false, players: false })).statusCode).toBe(200);
    const publicBase = `/map/${id}/t/public/v/`;
    expect((await call(null, "GET", `/map/${id}/`)).statusCode).toBe(200);
    const settings = await call(null, "GET", publicBase + "settings.json");
    expect(settings.statusCode).toBe(200);
    expect(settings.json().maps).toEqual(["world", "world_the_end"]);
    expect((await call(null, "GET", publicBase + "maps/world_nether/settings.json")).statusCode).toBe(404);
    const players = await call(null, "GET", publicBase + "maps/world/live/players.json");
    expect(players.json()).toEqual({ players: [] });
    expect(players.headers["access-control-allow-origin"]).toBe("*");
    expect(await fsp.readFile(path.join(dir, "plugins/BlueMap/maps/world_nether.conf"), "utf8")).toContain("world: null");
    for (const asset of ["assets/%252e%252e/secrets", "assets/..%5csecret", "api/servers", "maps/unknown/settings.json"]) {
      expect((await call(null, "GET", publicBase + asset)).statusCode).toBe(404);
    }
  });
  it("drops a viewer file that breaks off before its first byte without an error of its own", async () => {
    // The reply already carries the image's content type; what must not happen is a second failure while reporting the first.
    const r = await call(null, "GET", `/map/${id}/t/public/v/assets/cut-off.png`);
    expect(r.statusCode).toBe(502);
    expect(r.headers["content-type"]).toMatch(/^application\/json/);
    expect(logged.filter((line) => /invalid type|aborted/.test(line))).toEqual([]);
    expect((await call(null, "GET", `/map/${id}/t/public/v/assets/test.js`)).statusCode).toBe(200);
  });
  it("protects password maps and invalidates old public and password grants immediately", async () => {
    await put({ access: "public" });
    commands.length = 0;
    expect((await put({ access: "public", password: "map-password" })).statusCode).toBe(200);
    expect(commands).not.toContain("bluemap reload light");
    expect((await call(null, "GET", `/map/${id}/`)).body).toContain('type="password"');
    expect((await call(null, "GET", `/map/${id}/t/public/v/settings.json`)).statusCode).toBe(401);
    const unlock = (password: string) => app.inject({ method: "POST", url: `/map/${id}/unlock`, headers: { "content-type": "application/x-www-form-urlencoded" }, payload: new URLSearchParams({ password }).toString() });
    expect((await unlock("wrong")).statusCode).toBe(401);
    const good = await unlock("map-password");
    expect(good.statusCode).toBe(303);
    const link = String(good.headers.location);
    expect((await call(null, "GET", link + "v/settings.json")).statusCode).toBe(200);
    expect((await put({ access: "login" })).statusCode).toBe(200);
    expect((await call(null, "GET", link + "v/settings.json")).statusCode).toBe(401);
  });
  it("pauses at the disk limit, refuses to bypass it, and resumes after raising it", async () => {
    await fsp.mkdir(path.join(dir, "bluemap"), { recursive: true });
    await fsp.writeFile(path.join(dir, "bluemap/data"), Buffer.alloc(1024 ** 2));
    await put({ maxDiskMb: 1 });
    await ctx.maps.enforceLimits();
    expect((await call(owner, "GET", `/api/servers/${id}/map`)).json().diskLimitHit).toBe(true);
    expect(commands).toContain("bluemap stop");
    // The periodic check must not print "bluemap stop" into the console again and again.
    await ctx.maps.enforceLimits();
    await ctx.maps.enforceLimits();
    expect(commands.filter((c) => c === "bluemap stop")).toHaveLength(1);
    expect((await call(owner, "POST", `/api/servers/${id}/map/action`, { action: "resume" })).statusCode).toBe(409);
    await put({ maxDiskMb: 2 });
    expect((await call(owner, "GET", `/api/servers/${id}/map`)).json().diskLimitHit).toBe(false);
    expect(commands).toContain("bluemap start");
  });
});
