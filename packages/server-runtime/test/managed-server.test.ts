import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { ServerStatus } from "@craftpanel/shared";
import { launchTarget, ManagedServer, type LaunchSpec } from "../src/managed-server";

const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-minecraft.mjs");
const spec = (mode: string): LaunchSpec => ({
  javaPath: "unused",
  directory: os.tmpdir(),
  jarFile: "unused.jar",
  memoryMb: 512,
  jvmArgs: [],
  command: { file: process.execPath, args: [fake, mode] },
});

function waitForStatus(s: ManagedServer, status: ServerStatus, timeout = 10_000) {
  return new Promise<void>((resolve, reject) => {
    if (s.status === status) return resolve();
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${status}, still ${s.status}`)), timeout);
    s.on("status", (st) => {
      if (st === status) {
        clearTimeout(t);
        resolve();
      }
    });
  });
}

const servers: ManagedServer[] = [];
const make = () => {
  const s = new ManagedServer("t");
  servers.push(s);
  return s;
};
afterEach(() => {
  for (const s of servers.splice(0)) if (s.isAlive) s.kill();
});

describe("ManagedServer lifecycle", () => {
  it("goes stopped → starting → running → stopping → stopped on graceful stop", async () => {
    const s = make();
    const seen: ServerStatus[] = [];
    s.on("status", (st) => seen.push(st));
    s.start(spec("normal"));
    await waitForStatus(s, "running");
    expect(s.pid).toBeGreaterThan(0);
    expect(await s.stop(5000)).toBe(true);
    expect(s.status).toBe("stopped");
    expect(seen).toEqual(["starting", "running", "stopping", "stopped"]);
  });

  it("detects a crash (unexpected exit) and records a reason", async () => {
    const s = make();
    s.start(spec("crash"));
    await waitForStatus(s, "crashed");
    expect(s.lastExitCode).toBe(1);
    expect(s.lastError).toMatch(/exit code 1/);
    expect(s.lastError).toMatch(/unexpected exception/);
  });

  it("names the mod NeoForge failed to load instead of the generic error", async () => {
    const s = make();
    s.start(spec("modfail"));
    await waitForStatus(s, "crashed");
    expect(s.lastError).toBe(
      "Mod loading failed: statuseffectbars-1.21.1-NeoForge-1.0.2.jar. It uses client-only code (a client mod that can't run on a server). Disable it on the Mods tab and start again.",
    );
  });

  it("reports an error when the executable does not exist", async () => {
    const s = make();
    s.start({ ...spec("normal"), command: { file: path.join(os.tmpdir(), "definitely-not-java-xyz"), args: [] } });
    await waitForStatus(s, "error");
    expect(s.lastError).toMatch(/not found/);
  });

  it("does not force-kill when a graceful stop times out", async () => {
    const s = make();
    s.start(spec("hang"));
    await waitForStatus(s, "running");
    expect(await s.stop(300)).toBe(false);
    expect(s.isAlive).toBe(true);
    s.kill();
    await waitForStatus(s, "stopped");
  });

  it("tracks players from join/leave lines and captures UUIDs", async () => {
    const s = make();
    s.start(spec("normal"));
    await waitForStatus(s, "running");
    const joined = new Promise((r) => s.once("players", r));
    s.send("join Steve");
    await joined;
    expect(s.players).toEqual([expect.objectContaining({ name: "Steve", uuid: "069a79f4-44e9-4726-a5be-fca90e38aaf5" })]);
    const left = new Promise((r) => s.once("players", r));
    s.send("leave Steve");
    await left;
    expect(s.players).toHaveLength(0);
  });

  it("answers internal queries without echoing them to the console", async () => {
    const s = make();
    s.start(spec("normal"));
    await waitForStatus(s, "running");
    const m = await s.query("save-all flush", /^Saved the (game|world)/);
    expect(m).not.toBeNull();
    await new Promise((r) => setTimeout(r, 100));
    expect(s.history().some((l) => l.text.includes("Saved the game"))).toBe(false);
    expect(s.history().some((l) => l.text.includes("save-all"))).toBe(false);
  });

  it("rejects multi-line commands (no command injection via newlines)", async () => {
    const s = make();
    s.start(spec("normal"));
    await waitForStatus(s, "running");
    expect(() => s.send("say hi\nstop")).toThrow(/single line/);
  });
});

describe("launchTarget", () => {
  it("starts jars with -jar and NeoForge's argument file with @, per OS", () => {
    expect(launchTarget("server.jar")).toEqual(["-jar", "server.jar"]);
    expect(launchTarget("libraries/net/neoforged/neoforge/21.1.172/unix_args.txt", "linux")).toEqual(["@libraries/net/neoforged/neoforge/21.1.172/unix_args.txt"]);
    expect(launchTarget("libraries/net/neoforged/neoforge/21.1.172/unix_args.txt", "win32")).toEqual(["@libraries/net/neoforged/neoforge/21.1.172/win_args.txt"]);
  });
});
