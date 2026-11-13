// Per-server resource limits on an isolated installed Linux service (root, systemd, cgroup v2).
// node scripts/real-tests/installer-fixtures.mjs test-results/limits craftpanel-ops-lim
// sudo node scripts/real-tests/limits.mjs test-results/limits craftpanel-ops-lim 19687
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { client } from "./client.mjs";

const run = promisify(execFile);
const [fixturesArg, instance, portArg] = process.argv.slice(2);
if (process.platform !== "linux" || process.getuid() !== 0 || !/^craftpanel-ops-[a-z0-9-]+$/.test(instance ?? ""))
  throw new Error("Use Linux/root: limits.mjs FIXTURES craftpanel-ops-NAME PORT");
const fixtures = path.resolve(fixturesArg);
const port = Number(portArg);
const data = `/var/lib/${instance}`;
const installer = path.join(fixtures, "install.sh");
const c = client(`http://127.0.0.1:${port}`);
const original = (await run("systemctl", ["show", "craftpanel", "-p", "MainPID", "--value"])).stdout.trim();
await assert.rejects(fs.access(data), { code: "ENOENT" });
const evidence = { instance, checks: [], startedAt: new Date().toISOString() };
const record = (check, extra = {}) => { evidence.checks.push({ check, ...extra }); console.log(`PASS ${check} ${JSON.stringify(extra)}`); };
const wait = async (fn, timeout = 90_000) => {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { const value = await fn(); if (value) return value; } catch (error) { last = error; }
    await c.sleep(250);
  }
  throw last ?? new Error("Condition timed out");
};
const freePort = async () => {
  const listener = net.createServer();
  await new Promise((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
  const { port: free } = listener.address();
  await new Promise((resolve) => listener.close(resolve));
  return free;
};
const read = async (file) => (await fs.readFile(file, "utf8")).trim();

try {
  await run("bash", [installer, "--archive", path.join(fixtures, "craftpanel-v99.0.0.tar.gz"), "--port", String(port)], { env: { ...process.env, CRAFTPANEL_GAME_ACCOUNTS: "2" }, timeout: 300_000, maxBuffer: 4 * 1024 * 1024 });
  await wait(async () => (await fetch(`http://127.0.0.1:${port}/api/ready`)).ok);
  const setupToken = (await fs.readFile(path.join(data, "setup-token.txt"), "utf8")).trim();
  const setup = await fetch(`http://127.0.0.1:${port}/api/auth/setup`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "lim-owner", password: "throwaway-limits-test-1", setupToken }) });
  assert(setup.ok, `Setup failed: ${setup.status}`);
  await c.signIn("lim-owner", "throwaway-limits-test-1");

  const created = await c.create({ name: "Limited", software: "paper", mcVersion: "1.21.4", memoryMb: 1024, port: await freePort(), bindAddress: "127.0.0.1" });
  const id = created.id;
  await c.waitInstalled(id);
  await c.call("PUT", `/api/servers/${id}/properties`, { values: { "view-distance": "3", "simulation-distance": "3" } });
  const before = await c.server(id);
  assert.equal(before.resourceLimits.available, true, before.resourceLimits.reason);
  assert.deepEqual(before.resourceLimits.controllers, ["memory", "cpu", "pids"]);
  assert.deepEqual(before.resourceLimits.effective, { memoryMb: 2048, tasks: 4096 });
  record("runtime-reports-delegated-controllers", { controllers: before.resourceLimits.controllers });

  const started = await c.start(id);
  const unit = `/sys/fs/cgroup/system.slice/${instance}-runtime.service`;
  const cg = path.join(unit, `server-${id}`);
  assert.equal(await read(`/proc/${started.pid}/cgroup`), `0::/system.slice/${instance}-runtime.service/server-${id}`);
  assert.equal(await read(path.join(cg, "memory.max")), String(2048 * 1024 * 1024));
  assert.equal(await read(path.join(cg, "memory.swap.max")), "0");
  assert.equal(await read(path.join(cg, "pids.max")), "4096");
  assert.equal(await read(path.join(cg, "cpu.max")), "max 100000");
  // Half a core, set live, must throttle chunk generation.
  await c.call("PATCH", `/api/servers/${id}`, { limitCpuPercent: 50 });
  assert.equal(await read(path.join(cg, "cpu.max")), "50000 100000");
  const throttledBefore = Number(/^nr_throttled (\d+)$/m.exec(await read(path.join(cg, "cpu.stat")))[1]);
  await c.command(id, "forceload add -160 -160 160 160");
  await c.sleep(15_000);
  await c.command(id, "forceload remove all");
  await c.command(id, "save-all flush");
  const throttled = Number(/^nr_throttled (\d+)$/m.exec(await read(path.join(cg, "cpu.stat")))[1]) - throttledBefore;
  assert(throttled > 0, "Half a core was never throttled while generating chunks");
  const runtimePid = (await run("systemctl", ["show", `${instance}-runtime`, "-p", "MainPID", "--value"])).stdout.trim();
  assert.equal(await read(`/proc/${runtimePid}/cgroup`), `0::/system.slice/${instance}-runtime.service/runtime`);
  record("server-runs-in-its-own-cgroup-with-limits", { pid: started.pid, nrThrottled: throttled, memoryCurrentMb: Math.round(Number(await read(path.join(cg, "memory.current"))) / 1048576), tasks: Number(await read(path.join(cg, "pids.current"))) });

  // Changes reach the running server without a restart.
  await c.call("PATCH", `/api/servers/${id}`, { limitCpuPercent: null, limitMemoryMb: 3072, limitProcesses: 2048 });
  assert.equal(await read(path.join(cg, "cpu.max")), "max 100000");
  assert.equal(await read(path.join(cg, "memory.max")), String(3072 * 1024 * 1024));
  assert.equal(await read(path.join(cg, "pids.max")), "2048");
  const same = await c.server(id);
  assert.equal(same.pid, started.pid);
  assert.equal(same.restartRequired, false);
  record("limits-change-live-without-restart");
  const refused = await c.call("PATCH", `/api/servers/${id}`, { limitMemoryMb: 1100 }).catch((error) => error);
  assert.equal(refused.status, 400);
  record("memory-cap-below-heap-refused");

  // Fault injection: squeeze the cgroup below what the server uses, as a too-small cap would.
  await fs.writeFile(path.join(cg, "memory.max"), String(256 * 1024 * 1024));
  const crashed = await c.waitStatus(id, "crashed", 60_000);
  assert.match(crashed.lastError, /Memory limit reached \(3072 MB\)/);
  await wait(async () => !(await fs.access(cg).then(() => true, () => false)), 15_000);
  record("out-of-memory-reported-and-cgroup-removed", { lastError: crashed.lastError });

  // A new run gets a fresh cgroup with the stored limits; stopping removes it.
  const again = await c.start(id);
  assert.equal(await read(path.join(cg, "memory.max")), String(3072 * 1024 * 1024));
  assert.equal(await read(`/proc/${again.pid}/cgroup`), `0::/system.slice/${instance}-runtime.service/server-${id}`);
  await c.stop(id);
  await wait(async () => !(await fs.access(cg).then(() => true, () => false)), 15_000);
  record("restart-reapplies-limits-and-stop-cleans-up");
  evidence.ok = true;
} catch (error) {
  evidence.error = String(error.message).slice(0, 1000);
  const servers = await c.call("GET", "/api/servers").catch(() => []);
  for (const s of servers) evidence[`console-${s.id}`] = ((await c.log(s.id)) ?? []).slice(-40).map((l) => l.text);
  console.error(JSON.stringify(evidence, null, 1).slice(-6000));
  throw error;
} finally {
  evidence.finishedAt = new Date().toISOString();
  let cleanupError;
  try { await run("bash", [installer, "--uninstall"], { timeout: 150_000 }); }
  catch (error) { cleanupError = error; evidence.ok = false; }
  await fs.rm(data, { recursive: true, force: true });
  await fs.rm(`/etc/${instance}`, { recursive: true, force: true });
  await fs.rm(`/var/log/${instance}`, { recursive: true, force: true });
  await run("userdel", [instance]).catch(() => undefined);
  for (let i = 0; i < 2; i++) {
    await run("userdel", [`${instance}-game-0${i}`]).catch(() => undefined);
    await run("groupdel", [`${instance}-game-0${i}`]).catch(() => undefined);
  }
  evidence.originalServiceUnchanged = (await run("systemctl", ["show", "craftpanel", "-p", "MainPID", "--value"])).stdout.trim() === original;
  await fs.writeFile(path.join(fixtures, "limits-evidence.json"), JSON.stringify(evidence, null, 2) + "\n").catch(() => undefined);
  if (cleanupError) throw cleanupError;
  assert(evidence.originalServiceUnchanged, "Existing CraftPanel service changed");
}
