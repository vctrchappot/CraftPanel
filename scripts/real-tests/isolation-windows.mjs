// Per-server isolation on Windows (restricted token per server) with a real Paper server.
// Needs no administrator rights, so it may run on the host with its own port and data dir:
//   CRAFTPANEL_ISOLATION=on KEEP_DATA=1 scripts/real-tests/run.sh <port> <data-dir> isolation-windows.mjs <data-dir>   (Git Bash, after pnpm build)
// Create <data-dir> first and give it the installer's permissions (only you, SYSTEM and Administrators):
//   icacls <data-dir> /inheritance:r /grant:r "%USERNAME%:(OI)(CI)F" *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F
// Every folder above it must be listable by Users (C:\something is; your profile is not).
// The installed service (virtual account) is covered by runtime-continuity-windows.mjs in CI.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { client } from "./client.mjs";

if (process.platform !== "win32") throw new Error("Use Windows: run.sh <port> <data-dir> isolation-windows.mjs");
const run = promisify(execFile);
const [base, dataArg] = process.argv.slice(2);
const c = client(base);
const evidence = { checks: [], startedAt: new Date().toISOString() };
const record = (check, extra = {}) => { evidence.checks.push({ check, ...extra }); console.log(`PASS ${check} ${JSON.stringify(extra)}`); };
const freePort = async () => {
  const listener = net.createServer();
  await new Promise((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
  const { port } = listener.address();
  await new Promise((resolve) => listener.close(resolve));
  return port;
};
const ps = async (script, pid) => (await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
  { env: { ...process.env, CP_PID: String(pid) }, timeout: 60_000 })).stdout.trim();
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
// Same derivation as packages/server-runtime/src/windows-isolation.ts.
const serverSid = (id) => { const h = crypto.createHash("sha256").update(`craftpanel-server:${id}`).digest(); return `S-1-9-${[0, 4, 8, 12, 16].map((o) => h.readUInt32LE(o)).join("-")}`; };
/** Minecraft status ping: proves the game is reachable over loopback. */
const ping = (port) => new Promise((resolve, reject) => {
  const varint = (n) => { const b = []; do { let x = n & 0x7f; n >>>= 7; if (n) x |= 0x80; b.push(x); } while (n); return Buffer.from(b); };
  const host = Buffer.from("127.0.0.1");
  const body = Buffer.concat([varint(0), varint(769), varint(host.length), host, Buffer.from([port >> 8, port & 255]), varint(1)]);
  const socket = net.connect(port, "127.0.0.1", () => socket.write(Buffer.concat([varint(body.length), body, Buffer.from([1, 0])])));
  let received = "";
  socket.on("data", (d) => { received += d.toString("utf8"); if (received.includes("}")) { socket.destroy(); resolve(received.slice(received.indexOf("{"))); } });
  socket.on("error", reject);
  setTimeout(() => { socket.destroy(); reject(new Error("Status ping timed out")); }, 10_000);
});

let id;
try {
  const data = path.resolve(dataArg);
  await c.signIn();
  const playerPort = await freePort();
  const created = await c.create({ name: "Isolated", software: "paper", mcVersion: "1.21.4", memoryMb: 1024, port: playerPort, bindAddress: "127.0.0.1" });
  id = created.id;
  await c.waitInstalled(id);
  await c.call("PUT", `/api/servers/${id}/properties`, { values: { "view-distance": "3", "simulation-distance": "3" } });
  const started = await c.start(id);
  const pid = started.pid;
  const log = await c.log(id);
  assert.match(log.find((line) => line.text.startsWith("Starting:"))?.text ?? "", /\(restricted token\)$/, "Not started under a restricted token");
  assert(!log.some((line) => line.text.includes("Isolation is incomplete")), "The token can read the panel's secrets");
  assert.equal((await ps("(Get-Process -Id $env:CP_PID).ProcessName", pid)).toLowerCase(), "java", "The reported PID is not Java's");
  record("paper-runs-under-a-restricted-token", { pid });

  const status = JSON.parse(await ping(playerPort));
  assert.equal(status.version.name, "Paper 1.21.4");
  record("reachable-over-loopback", { port: playerPort });

  const sid = serverSid(id);
  assert((await run("icacls", [started.directory])).stdout.includes(sid), "The server directory has no server SID");
  // The protective default limits hold Java itself, not the helper that started it.
  assert.equal(await ps("@(Get-CimInstance Win32_Process -Filter \"Name like 'job-helper-%'\" | Where-Object { $_.CommandLine -match ('\\s' + $env:CP_PID + '\\s') }).Count", pid), "1", "No job helper holds Java");
  record("server-sid-and-limits-on-java", { sid });

  // A probe with the token the runtime gives this server (same account here), started by the runtime's helper.
  const helper = (await fs.readdir(path.join(data, "runtime"))).find((name) => /^server-token-[0-9a-f]{12}\.exe$/.test(name));
  const neighbour = path.join(data, "servers", "neighbour-probe");
  await fs.mkdir(neighbour, { recursive: true });
  await fs.writeFile(path.join(neighbour, "secret.txt"), "secret");
  const probe = `const fs=require("fs"),p=require("path");const t=(n,f)=>{try{f();console.log(n,"allowed")}catch(e){console.log(n,e.code)}};
t("own",()=>fs.writeFileSync("isolation-probe.txt","x"));fs.rmSync("isolation-probe.txt",{force:true});
t("database",()=>fs.readFileSync(p.join(process.argv[1],"craftpanel.db")));t("token",()=>fs.readFileSync(p.join(process.argv[1],"runtime","token")));
t("neighbour",()=>fs.readFileSync(p.join(process.argv[2],"secret.txt")));`;
  const { stdout } = await run(path.join(data, "runtime", helper), ["run", sid, path.join(data, "game-temp", id), "--", process.execPath, "-e", probe, data, neighbour],
    { cwd: started.directory, timeout: 30_000 });
  assert.deepEqual(stdout.trim().split(/\r?\n/).slice(1), ["own allowed", "database EPERM", "token EPERM", "neighbour EPERM"]);
  await fs.rm(neighbour, { recursive: true, force: true });
  record("token-cannot-read-database-token-or-neighbour");

  await c.call("POST", `/api/servers/${id}/kill`);
  await c.waitStatus(id, "stopped", 30_000).catch(async () => c.waitStatus(id, "crashed", 30_000));
  for (let i = 0; i < 40 && alive(pid); i++) await c.sleep(250);
  assert(!alive(pid), "Java survived a forced kill");
  record("forced-kill-ends-java");

  const again = await c.start(id);
  assert.notEqual(again.pid, pid);
  await c.stop(id);
  const latest = await fs.readFile(path.join(again.directory, "logs", "latest.log"), "utf8");
  assert.match(latest, /All dimensions are saved/, "Paper did not stop cleanly");
  record("restart-and-clean-stop", { pid: again.pid });
  evidence.ok = true;
} finally {
  if (id) await c.call("DELETE", `/api/servers/${id}?deleteFiles=true`).catch(() => {});
  evidence.finishedAt = new Date().toISOString();
  console.log(JSON.stringify(evidence, null, 2));
}
