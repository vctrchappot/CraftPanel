import { describe, expect, it } from "vitest";
import { Writable } from "node:stream";
import { loadConfig } from "../src/config";
import { prettyLogStream } from "../src/logging";

describe("start profiles", () => {
  it("defaults to local (loopback only, dashboard on)", () => {
    const c = loadConfig({}, []);
    expect(c).toMatchObject({ profile: "local", host: "127.0.0.1", serveWeb: true, isLoopbackOnly: true, secureCookies: false });
  });

  it("selects profiles from --profile, --profile= and CRAFTPANEL_PROFILE", () => {
    expect(loadConfig({}, ["--profile", "lan"])).toMatchObject({ profile: "lan", host: "0.0.0.0", isLoopbackOnly: false });
    expect(loadConfig({}, ["--profile=proxy"])).toMatchObject({ profile: "proxy", trustProxy: ["127.0.0.1", "::1"], secureCookies: true, isLoopbackOnly: false });
    expect(loadConfig({ CRAFTPANEL_PROFILE: "headless" }, [])).toMatchObject({ profile: "headless", serveWeb: false });
    // The command-line flag wins over the environment.
    expect(loadConfig({ CRAFTPANEL_PROFILE: "headless" }, ["--profile", "lan"]).profile).toBe("lan");
  });

  it("lets explicit variables override the preset", () => {
    const c = loadConfig({ CRAFTPANEL_HOST: "192.168.1.5", CRAFTPANEL_SECURE_COOKIES: "false" }, ["--profile", "proxy"]);
    expect(c).toMatchObject({ host: "192.168.1.5", secureCookies: false, trustProxy: ["127.0.0.1", "::1"], isLoopbackOnly: false });
  });

  it("rejects unknown profiles with the list of valid ones", () => {
    expect(() => loadConfig({}, ["--profile", "public"])).toThrow(/local, lan, proxy, headless/);
    expect(() => loadConfig({ CRAFTPANEL_PROFILE: "constructor" })).toThrow(/Unknown profile/);
  });

  it("normalizes the browser-facing origin and forces Secure cookies for HTTPS", () => {
    expect(loadConfig({ CRAFTPANEL_PUBLIC_URL: "https://Panel.Example:443/", CRAFTPANEL_PROFILE: "proxy" })).toMatchObject({ publicUrl: "https://panel.example", secureCookies: true, isLoopbackOnly: false });
    expect(() => loadConfig({ CRAFTPANEL_PUBLIC_URL: "https://panel.example" })).toThrow(/requires built-in TLS/);
    for (const url of ["ftp://example.org", "https://user:pass@example.org", "https://example.org/panel", "https://example.org?x=1", "https://example.org/#x"])
      expect(() => loadConfig({ CRAFTPANEL_PUBLIC_URL: url })).toThrow(/PUBLIC_URL/);
    expect(() => loadConfig({ CRAFTPANEL_PUBLIC_URL: "https://example.org", CRAFTPANEL_SECURE_COOKIES: "false" })).toThrow(/Secure cookies/);
  });

  it("accepts explicit proxy peers but never a wildcard trust policy", () => {
    expect(loadConfig({ CRAFTPANEL_TRUSTED_PROXIES: "10.0.0.2,fd00::/64" }).trustProxy).toEqual(["10.0.0.2", "fd00::/64"]);
    expect(loadConfig({ CRAFTPANEL_TRUST_PROXY: "true" }).trustProxy).toEqual(["127.0.0.1", "::1"]);
    for (const value of ["", "example.org", "0.0.0.0/0", "::/0", "0.0.0.0/00", "::/000", "10.0.0.1,"])
      expect(() => loadConfig({ CRAFTPANEL_TRUSTED_PROXIES: value })).toThrow(/TRUSTED_PROXIES/);
    expect(() => loadConfig({ CRAFTPANEL_TRUSTED_PROXIES: "10.0.0.2", CRAFTPANEL_TRUST_PROXY: "false" })).toThrow(/conflicts/);
    expect(() => loadConfig({ CRAFTPANEL_TRUST_PROXY: "yes" })).toThrow(/true or false/);
    expect(() => loadConfig({ CRAFTPANEL_SESSION_TTL_HOURS: "NaN" })).toThrow(/SESSION_TTL/);
  });
});

describe("pretty log output", () => {
  function run(level: string, records: object[]) {
    let out = "";
    const sink = new Writable({ write: (c, _e, cb) => ((out += c.toString()), cb()) });
    const s = prettyLogStream({ level, color: false, out: sink });
    s.write(records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    return out;
  }
  const t = Date.UTC(2026, 0, 1, 12, 0, 0);
  const req = (id: string, url: string) => ({ level: 30, time: t, reqId: id, req: { method: "GET", url }, msg: "incoming request" });
  const done = (id: string, statusCode: number) => ({ level: 30, time: t, reqId: id, res: { statusCode }, responseTime: 3.4, msg: "request completed" });

  it("hides routine requests and shows failures with their URL", () => {
    const out = run("info", [req("a", "/api/servers"), done("a", 200), req("b", "/api/boom?x=1"), done("b", 500), { level: 40, time: t, msg: "Disk almost full" }]);
    expect(out).not.toContain("/api/servers");
    expect(out).toContain("GET /api/boom → 500 (3 ms)");
    expect(out).toMatch(/WARN  Disk almost full/);
  });

  it("shows every request at debug level", () => {
    expect(run("debug", [req("a", "/api/servers"), done("a", 200)])).toContain("GET /api/servers → 200");
  });
});
