import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { servers } from "@craftpanel/database";
import { dataLayout } from "@craftpanel/server-runtime";
import { createContext } from "../src/bootstrap";
import { buildApp } from "../src/app";
import type { AppContext } from "../src/context";
import { writeVarInt } from "../src/services/sleep-listener";

const MIN = 60_000;

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

const str = (s: string) => Buffer.concat([writeVarInt(Buffer.byteLength(s)), Buffer.from(s)]);
const frame = (id: number, data = Buffer.alloc(0)) => {
  const body = Buffer.concat([writeVarInt(id), data]);
  return Buffer.concat([writeVarInt(body.length), body]);
};
const handshake = (next: number) => frame(0, Buffer.concat([writeVarInt(767), str("localhost"), Buffer.from([0x63, 0xdd]), writeVarInt(next)]));
const tryJoin = (port: number) =>
  new Promise<void>((resolve) => {
    const sock = net.connect({ port, host: "127.0.0.1" }, () => sock.write(Buffer.concat([handshake(2), frame(0, str("Steve"))])));
    sock.on("data", () => undefined);
    sock.on("close", () => resolve());
    sock.on("error", () => resolve());
  });

describe("rules", () => {
  let root: string;
  let ctx: AppContext;
  let app: FastifyInstance;
  let id: string;
  let port: number;
  let owner: { cookie: string; csrf: string };
  let viewer: { cookie: string; csrf: string };
  let running = true;
  let players = 0;
  let tps: number | null = 20;
  let started = 0;
  const commands: string[] = [];
  const stops: string[] = [];
  const session = (r: { headers: Record<string, unknown>; json: () => { csrfToken: string } }) => ({ cookie: String(r.headers["set-cookie"]).split(";")[0]!, csrf: r.json().csrfToken });
  const call = (auth: typeof owner, method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: object) => app.inject({ method, url, payload, headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf } });
  const create = (rule: object) => call(owner, "POST", `/api/servers/${id}/rules`, rule);
  const list = async () => (await call(owner, "GET", `/api/servers/${id}/rules`)).json() as { id: string; name: string; active: boolean; sleeping: boolean; lastResult: string | null; holdingSince: number | null }[];
  const reset = async () => {
    for (const r of await list()) await call(owner, "DELETE", `/api/servers/${id}/rules/${r.id}`);
    commands.length = 0;
    stops.length = 0;
    running = true;
    players = 0;
    tps = 20;
  };
  /** Evaluate at a point in time and let started actions finish. */
  const tick = async (at: number) => {
    await ctx.rules.tick(at);
    await new Promise((r) => setTimeout(r, 30));
  };

  beforeAll(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "cp-rules-"));
    const dir = path.join(root, "servers", "test");
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, "server.properties"), "level-name=world\n");
    port = await freePort();
    ctx = await createContext({ profile: "local", host: "127.0.0.1", port: 0, serveWeb: false, webDir: null, logFormat: "json", tls: null,
      layout: dataLayout(root), corsOrigins: [], secureCookies: false, trustProxy: false, publicUrl: null, sessionTtlMs: 3600_000, logLevel: "silent", isLoopbackOnly: true });
    vi.spyOn(ctx.agent, "isRunning").mockImplementation(() => running);
    vi.spyOn(ctx.agent, "status").mockImplementation(() => (running ? "running" : "stopped"));
    vi.spyOn(ctx.agent, "info").mockImplementation(() => ({
      pid: 1, startedAt: 0, readyAt: Date.now() - 5 * 3600_000, lastError: null, lastExitCode: null, maxPlayers: 20,
      players: Array.from({ length: players }, (_, i) => ({ name: `P${i}`, uuid: null, joinedAt: 0 })),
    }));
    vi.spyOn(ctx.agent, "latestMetrics").mockImplementation(() => (tps === null ? null : { ts: Date.now(), cpuPercent: 1, memoryBytes: 1, tps, mspt: 1, uptimeMs: 1, playersOnline: players }));
    vi.spyOn(ctx.agent, "watch").mockImplementation(() => () => undefined);
    vi.spyOn(ctx.servers, "start").mockImplementation(async (sid) => {
      for (const hook of ctx.servers.hooks.prepareStart) await hook(sid);
      running = true;
      started++;
    });
    vi.spyOn(ctx.servers, "stop").mockImplementation(async () => { running = false; stops.push("stop"); });
    vi.spyOn(ctx.servers, "restart").mockImplementation(async () => { stops.push("restart"); });
    vi.spyOn(ctx.servers, "sendCommand").mockImplementation(async (_id, command) => { commands.push(command); });
    app = await buildApp(ctx, { logger: { level: "error" } });
    owner = session(await app.inject({ method: "POST", url: "/api/auth/setup", payload: { username: "owner", password: "owner-password-1" } }));
    await call(owner, "POST", "/api/users", { username: "viewer", password: "viewer-password-1", role: "viewer", serverScope: "all", serverRoles: {} });
    viewer = session(await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "viewer", password: "viewer-password-1" } }));
    id = crypto.randomUUID();
    await ctx.database.db.insert(servers).values({ id, name: "Rules test", software: "paper", mcVersion: "1.21.4", javaMajor: 21, memoryMb: 1024,
      directory: dir, port, bindAddress: "127.0.0.1", maxPlayers: 8, installState: "installed", eulaAccepted: true, jarFile: "server.jar", createdAt: Date.now(), updatedAt: Date.now() });
  });
  afterAll(async () => {
    await ctx?.rules.stop();
    await app?.close();
    ctx?.database.close();
    vi.restoreAllMocks();
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("is managed with the schedule permission and checked on the way in", async () => {
    const ok = { name: "Sleep", when: { kind: "empty" }, forMinutes: 10, then: { kind: "stop", warnSeconds: 0, wake: false } };
    expect((await call(viewer, "GET", `/api/servers/${id}/rules`)).statusCode).toBe(200);
    expect((await call(viewer, "POST", `/api/servers/${id}/rules`, ok)).statusCode).toBe(403);
    expect((await create({ ...ok, forMinutes: 0 })).statusCode).toBe(400);
    expect((await create({ ...ok, then: { kind: "stop", warnSeconds: 0, wake: true }, when: { kind: "low-tps", below: 10 } })).statusCode).toBe(400);
    const made = await create(ok);
    expect(made.statusCode).toBe(200);
    expect((await list()).map((r) => r.name)).toEqual(["Sleep"]);
    const ruleId = made.json().id;
    expect((await call(owner, "PUT", `/api/servers/${id}/rules/${ruleId}`, { ...ok, name: "Renamed", enabled: false })).json()).toMatchObject({ name: "Renamed", enabled: false });
    expect((await call(owner, "PUT", `/api/servers/${crypto.randomUUID()}/rules/${ruleId}`, ok)).statusCode).toBe(404);
    expect((await call(viewer, "DELETE", `/api/servers/${id}/rules/${ruleId}`)).statusCode).toBe(403);
    expect((await call(owner, "DELETE", `/api/servers/${id}/rules/${ruleId}`)).statusCode).toBe(204);
    expect(await list()).toEqual([]);
  });

  it("stops an empty server after the wait, and not before", async () => {
    await reset();
    await create({ name: "Stop idle", when: { kind: "empty" }, forMinutes: 10, then: { kind: "stop", warnSeconds: 0, wake: false } });
    const t0 = Date.now();
    await tick(t0);
    expect((await list())[0]!.holdingSince).toBe(t0);
    await tick(t0 + 9 * MIN);
    expect(stops).toEqual([]);
    players = 1;
    await tick(t0 + 9.5 * MIN);
    expect((await list())[0]!.holdingSince).toBeNull();
    players = 0;
    await tick(t0 + 10 * MIN);
    await tick(t0 + 19 * MIN);
    expect(stops).toEqual([]);
    await tick(t0 + 20 * MIN);
    expect(stops).toEqual(["stop"]);
    const [rule] = await list();
    expect(rule!.lastResult).toBe("Stopped");
    // It does not repeat while the server stays empty.
    running = true;
    await tick(t0 + 21 * MIN);
    expect(stops).toEqual(["stop"]);
  });

  it("puts the server to sleep, answers the server list and wakes it when a player joins", async () => {
    await reset();
    await create({ name: "Sleep", when: { kind: "empty" }, forMinutes: 1, then: { kind: "stop", warnSeconds: 0, wake: true } });
    const t0 = Date.now();
    await tick(t0);
    await tick(t0 + MIN);
    await vi.waitFor(async () => expect((await list())[0]!.sleeping).toBe(true));
    expect((await list())[0]!.lastResult).toBe("Stopped, waits for a player");
    // The port is held by the listener, so nothing else can take it until the server wakes.
    expect(await new Promise((r) => { const s = net.createServer(); s.once("error", () => r(false)); s.listen({ port, host: "127.0.0.1", exclusive: true }, () => s.close(() => r(true))); })).toBe(false);
    const before = started;
    await tryJoin(port);
    await vi.waitFor(() => expect(started).toBe(before + 1));
    expect((await list())[0]!.sleeping).toBe(false);
    // The wake-up released the port again, and a second attempt right away does not start it twice.
    expect(await new Promise((r) => { const s = net.createServer(); s.once("error", () => r(false)); s.listen({ port, host: "127.0.0.1", exclusive: true }, () => s.close(() => r(true))); })).toBe(true);
  });

  it("lets a manual start take the port from the sleeping server", async () => {
    await reset();
    await create({ name: "Sleep", when: { kind: "empty" }, forMinutes: 1, then: { kind: "stop", warnSeconds: 0, wake: true } });
    const t0 = Date.now() + 100 * MIN;
    await tick(t0);
    await tick(t0 + MIN);
    await vi.waitFor(async () => expect((await list())[0]!.sleeping).toBe(true));
    await ctx.servers.start(id, { id: null, username: "owner" });
    expect((await list())[0]!.sleeping).toBe(false);
  });

  it("undoes a reversible action when the condition ends, even after CraftPanel restarted", async () => {
    await reset();
    await create({ name: "Freeze", when: { kind: "empty" }, forMinutes: 1, then: { kind: "command", command: "tick freeze", undoCommand: "tick unfreeze" } });
    const t0 = Date.now() + 200 * MIN;
    await tick(t0);
    await tick(t0 + MIN);
    expect(commands).toEqual(["tick freeze"]);
    expect((await list())[0]!.active).toBe(true);
    // A fresh evaluator knows from the database that the rule is in effect.
    (ctx.rules as unknown as { runs: Map<string, unknown> }).runs.clear();
    players = 2;
    await tick(t0 + 2 * MIN);
    expect(commands).toEqual(["tick freeze", "tick unfreeze"]);
    expect((await list())[0]!.active).toBe(false);
  });

  it("treats an unknown TPS as fine and acts on a low one, only while nobody is online when asked", async () => {
    await reset();
    await create({ name: "Lag restart", when: { kind: "low-tps", below: 12 }, forMinutes: 2, onlyIfEmpty: true, then: { kind: "restart", warnSeconds: 0 } });
    const t0 = Date.now() + 300 * MIN;
    tps = null;
    await tick(t0);
    await tick(t0 + 3 * MIN);
    expect(stops).toEqual([]);
    tps = 5;
    players = 3;
    await tick(t0 + 4 * MIN);
    await tick(t0 + 8 * MIN);
    expect(stops).toEqual([]);
    players = 0;
    await tick(t0 + 9 * MIN);
    await tick(t0 + 11 * MIN);
    expect(stops).toEqual(["restart"]);
  });

  it("reports an action that fails and keeps the rule armed", async () => {
    await reset();
    await create({ name: "Mail", when: { kind: "empty" }, forMinutes: 1, then: { kind: "notify", message: "Quiet" } });
    const t0 = Date.now() + 400 * MIN;
    await tick(t0);
    await tick(t0 + MIN);
    const [rule] = await list();
    expect(rule!.lastResult).toMatch(/^Failed: No notification channel/);
    expect((await ctx.activity.list({ serverId: id, limit: 10 })).map((e) => e.kind)).toContain("rule.failed");
  });

  it("forgets a server's rules and its sleep when the server is deleted", async () => {
    await reset();
    await create({ name: "Sleep", when: { kind: "empty" }, forMinutes: 1, then: { kind: "stop", warnSeconds: 0, wake: true } });
    for (const hook of ctx.servers.hooks.deleted) await hook(id);
    expect(await list()).toEqual([]);
  });
});
