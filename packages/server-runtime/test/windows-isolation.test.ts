import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ManagedServer } from "../src/managed-server";
import { findCompiler } from "../src/windows-helper";
import { programRoot, serverSid, WindowsIsolation } from "../src/windows-isolation";

const run = promisify(execFile);

it("derives a stable resource-manager SID per server", () => {
  expect(serverSid("alpha")).toMatch(/^S-1-9-\d+-\d+-\d+-\d+-\d+$/);
  expect(serverSid("alpha")).toBe(serverSid("alpha"));
  expect(serverSid("alpha")).not.toBe(serverSid("beta"));
  const root = path.resolve("/");
  expect(programRoot(path.join(root, "jdk", "bin", "java.exe"))).toBe(path.join(root, "jdk"));
  expect(programRoot(path.join(root, "tools", "bedrock_server.exe"))).toBe(path.join(root, "tools"));
});

const until = async (check: () => boolean, timeout = 20_000) => {
  for (const end = Date.now() + timeout; !check(); await new Promise((r) => setTimeout(r, 50))) if (Date.now() > end) throw new Error("Timed out");
};
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// Runs under the server's token: what can it reach?
const PROBE = `const fs=require("fs"),p=require("path"),[data,other]=process.argv.slice(1);
const t=(n,f)=>{try{f();console.log(n,"allowed")}catch(e){console.log(n,e.code)}};
t("own",()=>fs.writeFileSync("own.txt","x"));
t("temp",()=>fs.writeFileSync(p.join(require("os").tmpdir(),"t.txt"),"x"));
t("database",()=>fs.readFileSync(p.join(data,"craftpanel.db")));
t("token",()=>fs.readFileSync(p.join(data,"runtime","token")));
t("neighbour",()=>fs.readFileSync(p.join(other,"server.properties")));
if(process.argv.includes("wait"))setInterval(()=>{},1000);`;

describe.skipIf(process.platform !== "win32")("Windows restricted token isolation", () => {
  let data: string;
  let isolation: WindowsIsolation;
  let server: string;
  let other: string;
  beforeAll(async () => {
    data = await fs.mkdtemp(path.join(os.tmpdir(), "cp-token-"));
    server = path.join(data, "servers", "alpha");
    other = path.join(data, "servers", "beta");
    for (const dir of [server, other, path.join(data, "runtime")]) await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(data, "craftpanel.db"), "secret");
    await fs.writeFile(path.join(data, "runtime", "token"), "secret");
    await fs.writeFile(path.join(other, "server.properties"), "secret");
    isolation = new WindowsIsolation(path.join(data, "runtime"), findCompiler()!, data);
  }, 120_000);
  afterAll(async () => { await fs.rm(data, { recursive: true, force: true, maxRetries: 10 }); });

  it("grants the server its folders and checks them under its token", async () => {
    const { problems, warnings } = await isolation.prepare("alpha", server, process.execPath);
    // Test folders sit in the user profile, which only the installer opens for listing; nothing else may be missing.
    for (const problem of problems) expect(problem).toMatch(/cannot list .*a folder above its directory/);
    expect(warnings).toEqual([]);
    const { stdout } = await run("icacls", [server], { windowsHide: true });
    expect(stdout).toContain(serverSid("alpha"));
  }, 120_000);

  it("warns about a server folder outside the data directory that every local account may read", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "cp-outside-"));
    try {
      // The user profile admits only its owner, so this folder starts closed.
      expect((await isolation.prepare("gamma", outside, process.execPath)).warnings).toEqual([]);
      await run("icacls", [outside, "/grant", "*S-1-5-32-545:(OI)(CI)R"], { windowsHide: true });
      const { warnings } = await isolation.prepare("gamma", outside, process.execPath);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/^Every local account on this computer can read .* icacls ".*" \/inheritance:d \/remove:g /);
    } finally { await fs.rm(outside, { recursive: true, force: true, maxRetries: 10 }); await isolation.forget("gamma"); }
  }, 120_000);

  it("runs a process that can write its own folders but not the panel's secrets or a neighbour", async () => {
    const wrap = await isolation.wrap("alpha");
    const launch = wrap(process.execPath, ["-e", PROBE, data, other]);
    const { stdout } = await run(launch.file, launch.args, { cwd: server, windowsHide: true, timeout: 30_000 });
    const lines = stdout.trim().split(/\r?\n/);
    expect(lines[0]).toMatch(/^craftpanel-pid \d+$/);
    expect(lines.slice(1)).toEqual(["own allowed", "temp allowed", "database EPERM", "token EPERM", "neighbour EPERM"]);
  }, 60_000);

  it("reports the game's PID to ManagedServer and kills the game with the helper", async () => {
    const wrap = await isolation.wrap("alpha");
    const managed = new ManagedServer("alpha");
    const spawned: number[] = [];
    managed.start({ javaPath: "unused", directory: server, jarFile: "unused", memoryMb: 512, jvmArgs: [], command: { file: process.execPath, args: ["-e", PROBE, data, other, "wait"] } },
      wrap, { spawned: (pid) => spawned.push(pid) });
    await until(() => spawned.length === 1);
    const pid = spawned[0];
    expect(managed.pid).toBe(pid);
    expect(alive(pid)).toBe(true);
    expect(managed.history().some((line) => line.text.includes("craftpanel-pid"))).toBe(false);
    managed.kill();
    await until(() => !managed.isAlive && !alive(pid));
  }, 60_000);
});
