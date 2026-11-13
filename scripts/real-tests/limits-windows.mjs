// Per-server resource limits on Windows (job objects) with a real Paper server.
// scripts/real-tests/run.sh <port> <data-dir> limits-windows.mjs   (Git Bash, after pnpm build)
import assert from "node:assert/strict";
import net from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { client } from "./client.mjs";

if (process.platform !== "win32") throw new Error("Use Windows: run.sh <port> <data-dir> limits-windows.mjs");
const run = promisify(execFile);
const [base] = process.argv.slice(2);
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
// The PID only reaches PowerShell through the environment.
const ps = async (script, pid) => (await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
  { env: { ...process.env, CP_PID: String(pid) }, timeout: 60_000 })).stdout.trim();
const cpuMs = async (pid) => Number(await ps("(Get-Process -Id $env:CP_PID).TotalProcessorTime.TotalMilliseconds", pid));
const commitMb = async (pid) => Math.round(Number(await ps("(Get-Process -Id $env:CP_PID).PrivateMemorySize64", pid)) / 1048576);
const helperFor = async (pid) => (await ps("@(Get-CimInstance Win32_Process -Filter \"Name like 'job-helper-%'\" | Where-Object { $_.CommandLine -match ('\\s' + $env:CP_PID + '\\s') }).Count", pid)) === "1";
const inJob = async (pid) => (await ps(`Add-Type -Name P -Namespace W -MemberDefinition '[DllImport("kernel32.dll")] public static extern bool IsProcessInJob(IntPtr p, IntPtr j, out bool r);'
  $p = [Diagnostics.Process]::GetProcessById([int]$env:CP_PID); $r = $false; [void][W.P]::IsProcessInJob($p.Handle, [IntPtr]::Zero, [ref]$r); $r`, pid)) === "True";
/** Cores Java used while generating a square of chunks for `seconds`. Forceload blocks the main thread: keep it small while limited, or Paper's watchdog stops the server. */
const generate = async (id, pid, from, size, seconds) => {
  const before = await cpuMs(pid);
  const started = Date.now();
  await c.command(id, `forceload add ${from} ${from} ${from + size} ${from + size}`);
  await c.sleep(seconds * 1000);
  await c.command(id, "forceload remove all");
  return (await cpuMs(pid) - before) / (Date.now() - started);
};

let id;
try {
  await c.signIn();
  const created = await c.create({ name: "Limited", software: "paper", mcVersion: "1.21.4", memoryMb: 1024, port: await freePort(), bindAddress: "127.0.0.1" });
  id = created.id;
  await c.waitInstalled(id);
  await c.call("PUT", `/api/servers/${id}/properties`, { values: { "view-distance": "3", "simulation-distance": "3" } });
  const before = await c.server(id);
  assert.equal(before.resourceLimits.available, true, before.resourceLimits.reason);
  assert.deepEqual(before.resourceLimits.controllers, ["memory", "cpu", "processes"]);
  assert.deepEqual(before.resourceLimits.effective, { memoryMb: 2048, tasks: 4096 });
  record("runtime-reports-job-object-limits", { controllers: before.resourceLimits.controllers });

  const started = await c.start(id);
  const pid = started.pid;
  assert(await helperFor(pid), "No job helper holds the server process");
  assert(await inJob(pid), "Java is not in a job");
  record("server-runs-in-a-job", { pid, commitMb: await commitMb(pid) });

  // One core, set live, caps chunk generation; lifting it lets Java use several. (At half a core a forceload blocks the main thread past the watchdog.)
  await c.call("PATCH", `/api/servers/${id}`, { limitCpuPercent: 100 });
  const limited = await generate(id, pid, 0, 64, 15);
  await c.call("PATCH", `/api/servers/${id}`, { limitCpuPercent: null });
  const free = await generate(id, pid, 1000, 240, 15);
  assert(limited < 1.15, `One core allowed ${limited.toFixed(2)} cores`);
  assert(free > limited * 1.5, `Lifting the limit did not help: ${free.toFixed(2)} vs ${limited.toFixed(2)} cores`);
  const same = await c.server(id);
  assert.equal(same.pid, pid);
  assert.equal(same.restartRequired, false);
  record("cpu-limit-changes-live", { limitedCores: Number(limited.toFixed(2)), freeCores: Number(free.toFixed(2)) });

  const refused = await c.call("PATCH", `/api/servers/${id}`, { limitMemoryMb: 1100 }).catch((error) => error);
  assert.equal(refused.status, 400);
  record("memory-cap-below-heap-refused");

  // The smallest allowed cap, set live, below what Java has committed by now: its next allocations fail.
  const committed = await commitMb(pid);
  await c.call("PATCH", `/api/servers/${id}`, { limitMemoryMb: 1280 });
  await c.command(id, "forceload add 2000 2000 2240 2240");
  const crashed = await c.waitStatus(id, "crashed", 180_000);
  // Said in the console as soon as it happens, since Java does not always stop at once.
  assert(((await c.log(id)) ?? []).some((l) => /^Memory limit reached \(1280 MB\): Java could not get more memory, so the server may slow down/.test(l.text)), "No memory limit warning in the console");
  assert.match(crashed.lastError, /^Memory limit reached \(1280 MB\)/);
  record("memory-limit-stops-and-explains", { committedMbBefore: committed, lastError: crashed.lastError });

  // A new run gets the stored limits again; stopping ends its helper.
  await c.call("PATCH", `/api/servers/${id}`, { limitMemoryMb: null, limitCpuPercent: 100 });
  const again = await c.start(id);
  assert(await helperFor(again.pid), "No job helper after restart");
  await c.stop(id);
  await c.sleep(2000);
  assert.equal(await helperFor(again.pid), false, "The job helper outlived the server");
  record("restart-reapplies-limits-and-stop-ends-helper", { pid: again.pid });
  evidence.ok = true;
} catch (error) {
  evidence.error = String(error.message).slice(0, 1000);
  if (id) evidence.console = ((await c.log(id)) ?? []).slice(-40).map((l) => l.text);
  console.error(JSON.stringify(evidence, null, 1).slice(-6000));
  throw error;
} finally {
  evidence.finishedAt = new Date().toISOString();
  if (id) await c.call("POST", `/api/servers/${id}/kill`).catch(() => undefined);
}
