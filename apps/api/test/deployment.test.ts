import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance, InjectOptions } from "fastify";
import { loadConfig } from "../src/config";
import { createContext } from "../src/bootstrap";
import { buildApp } from "../src/app";
import type { AppContext } from "../src/context";
import { isSecureRequest } from "../src/deployment";
import type { FastifyRequest } from "fastify";

const fixtures: { root: string; ctx: AppContext; app: FastifyInstance }[] = [];
async function fixture(env: NodeJS.ProcessEnv = {}, isReady?: () => boolean) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cp-deployment-"));
  const ctx = await createContext(loadConfig({ CRAFTPANEL_DATA_DIR: root, ...env }));
  const app = await buildApp(ctx, { logger: false, isReady });
  fixtures.push({ root, ctx, app });
  return { ctx, app };
}
afterEach(async () => {
  for (const { root, ctx, app } of fixtures.splice(0)) {
    await app.close();
    try { ctx.database.close(); } catch { /* a readiness test closes it deliberately */ }
    await fs.rm(root, { recursive: true, force: true });
  }
});

const proxyEnv = {
  CRAFTPANEL_PROFILE: "proxy", CRAFTPANEL_PUBLIC_URL: "https://panel.example",
  CRAFTPANEL_TRUSTED_PROXIES: "10.20.0.2",
};
const proxyRequest = (extra: Partial<InjectOptions> = {}): InjectOptions => ({
  remoteAddress: "10.20.0.2", method: "GET", url: "/api/auth/state",
  ...extra,
  headers: { host: "backend:8080", "x-forwarded-for": "192.168.1.30", "x-forwarded-proto": "https", origin: "https://panel.example", ...extra.headers },
});
async function owner(app: FastifyInstance, ctx: AppContext, throughProxy = true) {
  const options: InjectOptions = { method: "POST", url: "/api/auth/setup", payload: { username: "owner", password: "owner-password-1", setupToken: ctx.setupToken } };
  const response = await app.inject(throughProxy ? proxyRequest(options) : options);
  expect(response.statusCode, response.body).toBe(200);
  return { cookie: String(response.headers["set-cookie"]).split(";")[0], "x-csrf-token": response.json().csrfToken };
}

describe("deployment trust boundaries", () => {
  it("creates exactly one owner during concurrent first-run setup", async () => {
    const { app, ctx } = await fixture({ CRAFTPANEL_PROFILE: "lan" });
    const setupToken = ctx.setupToken;
    await app.ready();
    const responses = await Promise.all(["first_owner", "second_owner"].map((username) => app.inject({
      method: "POST", url: "/api/auth/setup", payload: { username, password: "owner-password-1", setupToken },
    })));
    expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(responses.find((r) => r.statusCode === 409)!.headers["set-cookie"]).toBeUndefined();
    const winner = responses.find((r) => r.statusCode === 200)!;
    expect(ctx.database.raw.prepare("SELECT username, role FROM users").all()).toEqual([{ username: winner.json().user.username, role: "owner" }]);
  });
  it("requires the setup token even when a reverse proxy uses a loopback backend", async () => {
    const { app, ctx } = await fixture({ CRAFTPANEL_PROFILE: "proxy" });
    const base = { method: "POST" as const, url: "/api/auth/setup", headers: { "x-forwarded-proto": "https", "x-forwarded-for": "192.168.1.20" }, payload: { username: "owner", password: "owner-password-1" } };
    expect(ctx.setupToken).toBeTruthy();
    expect((await app.inject(base)).statusCode).toBe(403);
    const good = await app.inject({ ...base, payload: { ...base.payload, setupToken: ctx.setupToken } });
    expect(good.statusCode).toBe(200);
    expect(good.headers["set-cookie"]).toContain("Secure");
  });

  it("ignores spoofed forwarding headers from an untrusted peer", async () => {
    const { app } = await fixture(proxyEnv);
    const bad = await app.inject(proxyRequest({ remoteAddress: "10.20.0.99", headers: { "x-forwarded-for": "127.0.0.1" } }));
    expect(bad.statusCode).toBe(403);
    expect(bad.json().error.code).toBe("https_required");
  });

  it("supports a rewritten Host, canonical origins and public clients behind the trusted proxy", async () => {
    const { app, ctx } = await fixture(proxyEnv);
    const headers = await owner(app, ctx);
    expect((await app.inject(proxyRequest({ method: "PUT", url: "/api/settings", headers, payload: { dashboardAccess: "any" } }))).statusCode).toBe(200);
    const system = await app.inject(proxyRequest({ url: "/api/system", headers: { ...headers, "x-forwarded-for": "203.0.113.20" } }));
    expect(system.statusCode).toBe(200);
    expect(system.json().dashboard).toMatchObject({ publicUrl: "https://panel.example", clientIp: "203.0.113.20", transportSecure: true });
    for (const origin of ["http://panel.example", "https://evil.example", "https://panel.example/path", "null"]) {
      const response = await app.inject(proxyRequest({ method: "POST", url: "/api/auth/login", headers: { origin }, payload: { username: "owner", password: "owner-password-1" } }));
      expect(response.statusCode, origin).toBe(403);
      expect(response.json().error.code).toBe("bad_origin");
    }
  });

  it("does not mistake ambiguous forwarding headers for verified encryption", async () => {
    const { app } = await fixture(proxyEnv);
    for (const proto of ["http", "http, https", "https, http"]) {
      const response = await app.inject(proxyRequest({ headers: { "x-forwarded-proto": proto } }));
      expect(response.statusCode).toBe(403);
    }
  });

  it("does not let backend TLS mask an unencrypted browser-to-proxy connection", () => {
    const socket = { encrypted: true, remoteAddress: "10.20.0.2" };
    const req = { raw: { socket }, socket, headers: { "x-forwarded-proto": "http" } } as unknown as FastifyRequest;
    expect(isSecureRequest(req, loadConfig(proxyEnv))).toBe(false);
    req.headers["x-forwarded-proto"] = "https";
    expect(isSecureRequest(req, loadConfig(proxyEnv))).toBe(true);
  });

  it("rejects proxy traffic without a usable original client address", async () => {
    const { app } = await fixture(proxyEnv);
    for (const address of ["", "unknown", "127.0.0.1,garbage"]) {
      const response = await app.inject(proxyRequest({ headers: { "x-forwarded-for": address } }));
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe("bad_forwarding_headers");
    }
    const missing = proxyRequest();
    delete (missing.headers as Record<string, string>)["x-forwarded-for"];
    expect((await app.inject(missing)).json().error.code).toBe("bad_forwarding_headers");
  });

  it("enforces the canonical origin before upgrading WebSockets", async () => {
    const { app, ctx } = await fixture(proxyEnv);
    const headers = await owner(app, ctx);
    await app.ready();
    const request = proxyRequest({ headers });
    const context = { socket: { remoteAddress: "10.20.0.2" } as Socket, headers: request.headers as Record<string, string> };
    const ws = await app.injectWS("/api/ws", context);
    try { expect(ws.readyState).toBe(1); } finally { ws.terminate(); }
    await expect(app.injectWS("/api/ws", { ...context, headers: { ...context.headers, origin: "https://evil.example" } })).rejects.toThrow(/403/);
  });

  it("rejects public policies and ranges over HTTP, including ranges starting at a private address", async () => {
    const { app, ctx } = await fixture({ CRAFTPANEL_PROFILE: "lan" });
    const headers = await owner(app, ctx, false);
    for (const payload of [{ dashboardAccess: "any" }, { allowedNetworks: ["203.0.113.0/24"] }, { allowedNetworks: ["192.168.1.1/0"] }]) {
      const response = await app.inject({ method: "PUT", url: "/api/settings", headers, payload });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.message).toContain("HTTPS");
    }
    // Old or externally edited settings cannot bypass the per-request transport check.
    await ctx.settings.set({ dashboardAccess: "any" });
    expect((await app.inject({ url: "/api/auth/state", remoteAddress: "203.0.113.20" })).statusCode).toBe(403);
    expect((await app.inject({ url: "/api/auth/state", remoteAddress: "192.168.1.20" })).statusCode).toBe(200);
  });

  it("rejects non-Secure sessions for public clients even with a legacy public policy", async () => {
    const { app, ctx } = await fixture({ CRAFTPANEL_PROFILE: "proxy", CRAFTPANEL_SECURE_COOKIES: "false", CRAFTPANEL_TRUSTED_PROXIES: "10.20.0.2" });
    await ctx.settings.set({ dashboardAccess: "any" });
    const response = await app.inject(proxyRequest({ headers: { "x-forwarded-for": "203.0.113.20" } }));
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("https_required");
  });

  it("keeps local installer probes working with HTTPS settings and distinguishes ready from alive", async () => {
    let ready = false;
    const { app, ctx } = await fixture(proxyEnv, () => ready);
    expect((await app.inject("/api/health")).statusCode).toBe(200);
    expect((await app.inject("/api/ready")).statusCode).toBe(503);
    ready = true;
    expect((await app.inject("/api/ready")).statusCode).toBe(200);
    ctx.database.close();
    expect((await app.inject("/api/ready")).statusCode).toBe(503);
  });
});
