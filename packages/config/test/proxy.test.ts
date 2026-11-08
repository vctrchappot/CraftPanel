import { describe, expect, it } from "vitest";
import { fabricProxyLiteConfig, paperVelocityConfig, readPaperVelocity, setTomlKey, setTomlTable, velocityToml } from "../src/proxy";

// Shaped like the file Velocity 4.3 rewrites after its first start (tab-indented tables).
const VELOCITY = `# Managed by CraftPanel
bind = "0.0.0.0:25565"
online-mode = true
player-info-forwarding-mode = "NONE"
forced-hosts = {}
config-version = "2.9"
motd = "<#09add3>A Velocity Server"

[servers]
\tlobby = "127.0.0.1:30066"
\ttry = ["lobby"]

[advanced]
\tcompression-threshold = 256
\tlogin-ratelimit = 3000
`;

describe("velocityToml", () => {
  const servers = [
    { name: "survival", address: "127.0.0.1:25871", host: "play.example.com" },
    { name: "creative", address: "127.0.0.1:25872" },
  ];
  it("sets the managed keys and servers, keeping the rest", () => {
    const t = velocityToml(VELOCITY, { bind: "0.0.0.0:25870", onlineMode: false, servers });
    expect(t).toContain('bind = "0.0.0.0:25870"\n');
    expect(t).toContain("online-mode = false\n");
    expect(t).toContain('player-info-forwarding-mode = "modern"\n');
    expect(t).toContain('forwarding-secret-file = "forwarding.secret"\n');
    expect(t).toContain('[servers]\n"survival" = "127.0.0.1:25871"\n"creative" = "127.0.0.1:25872"\ntry = ["survival", "creative"]\n');
    expect(t).not.toContain("lobby");
    expect(t).toContain('[forced-hosts]\n"play.example.com" = ["survival"]');
    expect(t).not.toMatch(/^forced-hosts = \{\}/m);
    expect(t).toContain("\tcompression-threshold = 256");
    expect(t).toContain('motd = "<#09add3>A Velocity Server"');
    // Top-level keys stay above the first table.
    expect(t.indexOf("forwarding-secret-file")).toBeLessThan(t.indexOf("[servers]"));
  });
  it("is stable when applied twice and handles no forced hosts", () => {
    const once = velocityToml(VELOCITY, { bind: "0.0.0.0:25870", onlineMode: true, servers: [servers[1]] });
    expect(velocityToml(once, { bind: "0.0.0.0:25870", onlineMode: true, servers: [servers[1]] })).toBe(once);
    expect(once).toMatch(/^forced-hosts = \{\}$/m);
    expect(once).not.toContain("[forced-hosts]");
  });
  it("writes a starting file with the MOTD", () => {
    const t = velocityToml(null, { bind: "0.0.0.0:25870", onlineMode: true, servers: [], motd: "Hi" });
    expect(t).toContain('motd = "Hi"');
    expect(t).toContain("[servers]\ntry = []\n");
  });
});

describe("toml helpers", () => {
  it("replaces quoted keys and tables at the end of the file", () => {
    expect(setTomlKey('"a" = 1\n', "a", "2")).toBe("a = 2\n");
    expect(setTomlTable("x = 1\n[t]\na = 1\n", "t", ["b = 2"])).toBe("x = 1\n[t]\nb = 2\n");
    expect(setTomlTable("x = 1\n[t]\na = 1\n[u]\nc = 3\n", "t", null)).toBe("x = 1\n[u]\nc = 3\n");
  });
});

const PAPER = `# This is the global configuration file for Paper.
_version: 31
block-updates:
  disable-chorus-plant-updates: false
proxies:
  bungee-cord:
    online-mode: true
  proxy-protocol: false
  velocity:
    enabled: false
    online-mode: false
    secret: ''
scoreboards:
  save-empty-scoreboard-teams: true
`;

describe("paperVelocityConfig", () => {
  it("edits the existing section and keeps everything else", () => {
    const t = paperVelocityConfig(PAPER, { secret: "s3cr'et", onlineMode: true });
    expect(t).toContain("  velocity:\n    enabled: true\n    online-mode: true\n    secret: 's3cr''et'\nscoreboards:");
    expect(t).toContain("_version: 31\n");
    expect(t).toContain("  bungee-cord:\n    online-mode: true\n");
    expect(readPaperVelocity(t)).toEqual({ enabled: true, secret: "s3cr'et" });
  });
  it("adds the velocity section or the whole proxies block", () => {
    const noVelocity = PAPER.replace(/  velocity:\n(    .*\n)+/, "");
    expect(paperVelocityConfig(noVelocity, { secret: "x", onlineMode: false })).toContain("  proxy-protocol: false\n  velocity:\n    enabled: true\n    online-mode: false\n    secret: 'x'\nscoreboards:");
    expect(paperVelocityConfig(null, { secret: "x", onlineMode: true })).toBe("proxies:\n  velocity:\n    enabled: true\n    online-mode: true\n    secret: 'x'\n");
    expect(readPaperVelocity(PAPER)).toEqual({ enabled: false, secret: "" });
  });
});

describe("fabricProxyLiteConfig", () => {
  it("writes a new file and updates only secret and online mode later", () => {
    const t = fabricProxyLiteConfig(null, { secret: "abc", onlineMode: true });
    expect(t).toContain("hackOnlineMode = true\n");
    expect(t).toContain('secret = "abc"\n');
    const custom = t.replace("hackMessageChain = true", "hackMessageChain = false");
    const again = fabricProxyLiteConfig(custom, { secret: "def", onlineMode: false });
    expect(again).toContain("hackMessageChain = false");
    expect(again).toContain('secret = "def"');
    expect(again).toContain("hackOnlineMode = false");
  });
});
