import { spawn } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Limiter } from "../src/limiter";
import type { ResourceLimits } from "../src/managed-server";
import { WindowsJobs } from "../src/windows-jobs";

/** A stand-in server, spawned like ManagedServer spawns Java. */
function server(script: string) {
  const child = spawn(process.execPath, ["-e", script], { stdio: "pipe", windowsHide: true });
  const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
  let output = "";
  child.stdout.on("data", (d: Buffer) => { output += String(d); });
  return { child, exited, output: () => output };
}
const until = async (check: () => boolean, timeout = 15_000) => {
  for (const end = Date.now() + timeout; !check(); await new Promise((r) => setTimeout(r, 50))) if (Date.now() > end) throw new Error("Timed out");
};
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe.skipIf(process.platform !== "win32")("Windows job object limits", () => {
  let dir: string;
  let jobs: Limiter;
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "cp-jobs-"));
    jobs = await WindowsJobs.detect(dir);
  });
  afterAll(async () => { await fs.rm(dir, { recursive: true, force: true, maxRetries: 10 }); });

  const run = (s: ReturnType<typeof server>, limits: ResourceLimits) => {
    const errors: Error[] = [];
    const notices: string[] = [];
    const hooks = jobs.hooks("alpha", () => limits, (e) => errors.push(e), (m) => notices.push(m));
    hooks.spawned!(s.child.pid!);
    s.exited.then(() => hooks.exited!());
    return { hooks, errors, notices };
  };

  it("stops a server at its memory cap and explains why", { timeout: 60_000 }, async () => {
    expect(jobs.support).toEqual({ available: true, controllers: ["memory", "cpu", "processes"] });
    const s = server(`process.stdin.once("data", () => { const keep = []; setInterval(() => { try { keep.push(Buffer.alloc(32 * 1024 * 1024, 1)); } catch { process.exit(3); } }, 20); }); console.log("up");`);
    const { hooks, errors, notices } = run(s, { memoryMb: 256 });
    // Allocate only once the job is in place (the helper is compiled on first use).
    await until(() => s.output().includes("up") && fsSync.readdirSync(dir).some((n) => /^job-helper-[0-9a-f]{12}\.exe$/.test(n)), 60_000);
    await new Promise((r) => setTimeout(r, 2000));
    s.child.stdin!.write("go\n");
    expect(await s.exited).not.toBe(0);
    await until(() => hooks.exitReason!() !== null, 5000);
    expect(hooks.exitReason!()).toMatch(/^Memory limit reached \(256 MB\)/);
    expect(notices).toEqual([expect.stringMatching(/^Memory limit reached \(256 MB\): Java could not get more memory, so the server may slow down or stop/)]);
    expect(errors).toEqual([]);
  });

  it("refuses processes above the limit and says so", { timeout: 30_000 }, async () => {
    // The server itself is one of the two processes.
    const s = server(`
      const { spawn } = require("node:child_process");
      process.stdin.once("data", () => {
        let ok = 0, failed = 0;
        for (let i = 0; i < 3; i++) {
          try { const c = spawn(process.execPath, ["-e", "setTimeout(() => {}, 3000)"], { stdio: "ignore" }); c.on("error", () => failed++); c.on("spawn", () => ok++); }
          catch { failed++; }
        }
        setTimeout(() => { console.log("ok " + ok + " failed " + failed); process.exit(0); }, 1000);
      });`);
    const { errors, notices } = run(s, { tasks: 2 });
    await new Promise((r) => setTimeout(r, 2000));
    s.child.stdin!.write("go\n");
    await s.exited;
    expect(s.output()).toContain("ok 1 failed 2");
    await until(() => notices.length > 0, 5000);
    expect(notices).toEqual(["Process limit reached (2): a new process could not start. Raise the limit in the Performance tab."]);
    expect(errors).toEqual([]);
  });

  it("changes the CPU cap of a running server and kills its leftovers on exit", { timeout: 60_000 }, async () => {
    // Starts a detached process like a plugin might, then is busy for 2 s per round and reports the share of one core it got.
    const s = server(`
      const { spawn } = require("node:child_process");
      process.stdin.on("data", (d) => {
        if (String(d).startsWith("1")) console.log("left " + spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore", detached: true }).pid);
        const c = process.cpuUsage(), t = Date.now(); while (Date.now() - t < 2000) {} const u = process.cpuUsage(c); console.log("share " + ((u.user + u.system) / 2000000).toFixed(2));
      });`);
    const limits: ResourceLimits = { cpuPercent: 25 };
    const { errors } = run(s, limits);
    await new Promise((r) => setTimeout(r, 2000));
    s.child.stdin!.write("1\n");
    await until(() => /share/.test(s.output()));
    const leftover = Number(/left (\d+)/.exec(s.output())![1]);
    expect(alive(leftover)).toBe(true);
    expect(jobs.update("alpha", { cpuPercent: undefined })).toBe(true);
    await new Promise((r) => setTimeout(r, 500));
    s.child.stdin!.write("2\n");
    await until(() => s.output().match(/share/g)!.length === 2);
    const [limited, free] = [...s.output().matchAll(/share ([\d.]+)/g)].map((m) => Number(m[1]));
    expect(limited).toBeLessThan(0.4);
    expect(free).toBeGreaterThan(0.7);
    s.child.kill();
    await s.exited;
    await until(() => !alive(leftover), 10_000);
    expect(jobs.update("alpha", { cpuPercent: 50 })).toBe(false);
    expect(errors).toEqual([]);
  });
});
