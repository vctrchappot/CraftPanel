// Real Paper + player acceptance against an isolated installed Windows SCM runtime and dashboard task.
// Elevated shell under the dashboard owner's account; CI uses a disposable hosted runner.
// node runtime-continuity-windows.mjs FIXTURES TOOLS_DIR
// The runtime wrapper handles SCM stop, shutdown and preshutdown with the same code path, and Windows
// does not let applications send preshutdown, so a service stop stands in for host shutdown here.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { client } from "./client.mjs";

const run = promisify(execFile);
const [fixturesArg, toolsDir] = process.argv.slice(2);
if (process.platform !== "win32" || !fixturesArg || !toolsDir) throw new Error("Use Windows: runtime-continuity-windows.mjs FIXTURES TOOLS_DIR");
const fixtures = path.resolve(fixturesArg);
const suffix = crypto.randomBytes(5).toString("hex");
const testRoot = path.join(os.tmpdir(), `craftpanel-ops-${suffix}`);
const installRoot = path.join(testRoot, "app");
const dataRoot = path.join(testRoot, "data");
const taskName = `CraftPanel Ops ${suffix}`;
const runtimeName = `${taskName} Runtime`;
const free = async () => {
  const listener = net.createServer();
  await new Promise((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
  const { port } = listener.address();
  await new Promise((resolve) => listener.close(resolve));
  return port;
};
const port = await free();
// Values reach PowerShell only through the environment, never interpolated into script text.
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("CRAFTPANEL_")));
Object.assign(env, { CRAFTPANEL_INSTALL_DIR: installRoot, CRAFTPANEL_DATA_DIR: dataRoot, CRAFTPANEL_TASK_NAME: taskName,
  CRAFTPANEL_PORT: String(port), CRAFTPANEL_PROFILE: "lan", CP_RUNTIME: runtimeName, CP_TASK: taskName });
const ps = async (script, extra = {}, timeout = 180_000) =>
  (await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { env: { ...env, ...extra }, timeout, maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
assert.equal(await ps("([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)"), "True", "Run elevated");
const c = client(`http://127.0.0.1:${port}`);
const evidence = { taskName, scenarios: [], startedAt: new Date().toISOString() };
const record = (scenario, extra = {}) => { evidence.scenarios.push({ scenario, ...extra }); console.log(`PASS ${scenario} ${JSON.stringify(extra)}`); };
const wait = async (fn, timeout = 90_000) => {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { const value = await fn(); if (value) return value; } catch (error) { last = error; }
    await c.sleep(250);
  }
  throw last ?? new Error("Acceptance condition timed out");
};
const ready = () => wait(async () => (await fetch(`http://127.0.0.1:${port}/api/ready`)).ok, 120_000);
const service = async () => JSON.parse(await ps("Get-CimInstance Win32_Service -Filter (\"Name='\" + $env:CP_RUNTIME.Replace(\"'\", \"''\") + \"'\") | Select-Object State, ProcessId, ExitCode, StartMode, StartName | ConvertTo-Json -Compress"));
const dashboardPid = async () => JSON.parse(await fs.readFile(path.join(dataRoot, "control.json"), "utf8")).pid;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const install = async (version, succeeds, extra = {}) => {
  try {
    await ps("& powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File $env:CP_INSTALLER; exit $LASTEXITCODE",
      { CRAFTPANEL_ARCHIVE: path.join(fixtures, `craftpanel-v${version}.tar.gz`), CP_INSTALLER: path.join(fixtures, "install.ps1"), ...extra }, 300_000);
    assert(succeeds, `Fixture ${version} unexpectedly installed`);
  } catch (error) {
    if (succeeds || error.killed || !Number.isInteger(error.code)) throw error;
  }
};
// Only a new dashboard counts: the dying one can still answer readiness with the old control.json.
const newDashboard = async (previous) => {
  await wait(() => !alive(previous), 60_000);
  await wait(async () => (await dashboardPid()) !== previous && (await fetch(`http://127.0.0.1:${port}/api/ready`)).ok, 150_000);
  await c.signIn(...credentials);
};
const credentials = ["windows-owner", "throwaway-windows-acceptance-1"];
let bot;
let id;
let disconnected = null;
let passed = false;
try {
  await install("99.0.0", true);
  await ready();
  const installed = await service();
  assert.equal(installed.State, "Running");
  assert.equal(installed.StartMode, "Auto", "Runtime service does not start at boot");
  assert.equal(installed.StartName, `NT SERVICE\\${runtimeName}`);
  const preshutdown = Number(await ps("(Get-ItemProperty -LiteralPath ('HKLM:\\SYSTEM\\CurrentControlSet\\Services\\' + $env:CP_RUNTIME) -Name PreshutdownTimeout).PreshutdownTimeout"));
  assert(preshutdown >= 120_000, `Preshutdown timeout is ${preshutdown} ms`);
  record("runtime-service-configured-for-boot-and-preshutdown", { startMode: installed.StartMode, preshutdownTimeoutMs: preshutdown });

  const setupToken = (await fs.readFile(path.join(dataRoot, "setup-token.txt"), "utf8")).trim();
  const response = await fetch(`http://127.0.0.1:${port}/api/auth/setup`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: credentials[0], password: credentials[1], setupToken }),
  });
  assert(response.ok, `Setup failed: ${response.status} ${await response.text()}`);
  await c.signIn(...credentials);
  const playerPort = await free();
  const created = await c.create({ name: "Windows acceptance", software: "paper", mcVersion: "1.21.4", memoryMb: 1024,
    port: playerPort, bindAddress: "127.0.0.1", autoStart: true });
  id = created.id;
  await c.waitInstalled(id);
  await c.call("PUT", `/api/servers/${id}/properties`, { values: { "view-distance": "3", "simulation-distance": "3", "spawn-protection": "0" } });
  const started = await c.start(id);
  let javaPid = started.pid;
  const directory = started.directory;
  const runtimePid = installed.ProcessId;
  const mineflayer = createRequire(path.join(path.resolve(toolsDir), "package.json"))("mineflayer");
  const connectPlayer = async () => {
    disconnected = null;
    const active = mineflayer.createBot({ host: "127.0.0.1", port: playerPort, username: "WindowsBot", auth: "offline", version: "1.21.4" });
    bot = active;
    active.on("end", (reason) => { if (bot === active) disconnected ??= String(reason); });
    active.on("error", (error) => { if (bot === active) disconnected ??= error.message; });
    active.on("kicked", (reason) => { if (bot === active) disconnected ??= JSON.stringify(reason); });
    await wait(() => active.entity && active.health !== undefined, 90_000);
    await wait(async () => (await c.server(id)).players.some((player) => player.name === "WindowsBot"));
  };
  await connectPlayer();
  record("real-player-connected", { javaPid, runtimePid, playerPort });

  let marker = 0;
  const continuity = async (scenario) => {
    await ready();
    assert.equal(disconnected, null, `Player disconnected: ${disconnected}`);
    const current = await c.server(id);
    assert.equal(current.pid, javaPid, "Java PID changed");
    assert.equal(current.status, "running");
    assert(current.players.some((player) => player.name === "WindowsBot"));
    assert.equal((await service()).ProcessId, runtimePid, "Runtime service process changed");
    const text = `windows-continuity-${++marker}`;
    let received = false;
    const onMessage = (message) => { if (message.includes(text)) received = true; };
    bot.on("messagestr", onMessage);
    try {
      await c.command(id, `say ${text}`);
      await wait(() => received, 10_000);
      await wait(async () => (await c.log(id)).some((line) => line.text.includes(text)), 10_000);
    } finally { bot.removeListener("messagestr", onMessage); }
    record(scenario, { javaPid, runtimePid, commandsAndConsole: true, playerConnected: true });
  };

  const taskStopped = () => wait(async () => (await ps("(Get-ScheduledTask -TaskName $env:CP_TASK).State")) !== "Running", 60_000);
  let previous = await dashboardPid();
  await ps("Stop-ScheduledTask -TaskName $env:CP_TASK");
  // Starting a task that still reports Running is ignored (MultipleInstances IgnoreNew).
  await taskStopped();
  await ps("Start-ScheduledTask -TaskName $env:CP_TASK");
  await newDashboard(previous);
  await continuity("dashboard-task-restart");

  previous = await dashboardPid();
  process.kill(previous, "SIGKILL");
  // The task's Job Object launcher ends with the dashboard; start it again like its restart policy would.
  await taskStopped();
  await ps("Start-ScheduledTask -TaskName $env:CP_TASK");
  await newDashboard(previous);
  await continuity("dashboard-forced-kill-and-recovery");

  previous = await dashboardPid();
  await install("99.0.0", true);
  await newDashboard(previous);
  await continuity("dashboard-only-successful-update");
  await install("99.0.1", false);
  await ready();
  await c.signIn(...credentials);
  await continuity("failed-migration-dashboard-rollback");
  assert((await c.log(id)).some((line) => line.text.includes("windows-continuity-1")), "Earlier console history was not replayed");
  record("console-history-survives-dashboard-replacements");

  // Gold is flushed explicitly; diamond is only persisted by the service's graceful stop.
  await c.command(id, "forceload add 0 0");
  await c.sleep(500);
  await c.command(id, "setblock 0 100 0 minecraft:gold_block");
  await c.command(id, "save-all flush");
  await wait(async () => (await c.log(id)).some((line) => /Saved the (game|world)/.test(line.text)), 30_000);
  await c.command(id, "setblock 1 100 0 minecraft:diamond_block");
  bot.end();
  bot = null;
  await ps("Stop-Service -Name $env:CP_RUNTIME", {}, 200_000);
  const stopped = await service();
  assert.equal(stopped.State, "Stopped");
  assert.equal(stopped.ExitCode, 0, `Runtime service stopped with exit code ${stopped.ExitCode}`);
  assert(!alive(javaPid), "Java survived the runtime service stop");
  const lastLog = await fs.readFile(path.join(directory, "logs", "latest.log"), "utf8");
  assert.match(lastLog, /Stopping server/, "Minecraft did not stop gracefully");
  assert.match(lastLog, /All dimensions are saved/, "Minecraft did not save its worlds");
  record("service-stop-saves-and-stops-minecraft", { exitCode: stopped.ExitCode });

  await ps("Start-Service -Name $env:CP_RUNTIME");
  await ready();
  await c.signIn(...credentials);
  const restarted = await wait(async () => { const s = await c.server(id); return s.status === "running" && s.pid !== javaPid ? s : null; }, 300_000);
  javaPid = restarted.pid;
  await connectPlayer();
  for (const [x, block] of [[0, "gold_block"], [1, "diamond_block"]]) {
    const text = `windows-${block}-${Date.now()}`;
    await c.command(id, `execute if block ${x} 100 0 minecraft:${block} run say ${text}`);
    await wait(async () => (await c.log(id)).some((line) => line.stream !== "command" && line.text.includes(text)), 10_000);
  }
  record("service-start-autostarts-and-preserves-world", { javaPid, runtimePid: (await service()).ProcessId, playerConnected: true });
  evidence.ok = passed = true;
} catch (error) {
  evidence.error = String(error.message).slice(0, 1000);
  // CI runners discard retained artifacts, so print what is needed before cleanup removes it.
  for (const log of ["craftpanel.log", "craftpanel.err.log", "runtime.log", "runtime.err.log", "runtime-host.err.log"]) {
    const text = await fs.readFile(path.join(dataRoot, "logs", log), "utf8").catch(() => null);
    if (text) console.log(`--- ${log} (tail)\n${text.split(/\r?\n/).slice(-30).join("\n")}`);
  }
  if (id) {
    const lines = await c.log(id);
    if (lines) console.log(`--- server console (tail)\n${lines.slice(-60).map((line) => line.text).join("\n")}`);
    const server = await c.server(id).catch(() => null);
    const latest = server && await fs.readFile(path.join(server.directory, "logs", "latest.log"), "utf8").catch(() => null);
    if (latest) console.log(`--- latest.log (tail)\n${latest.split(/\r?\n/).slice(-60).join("\n")}`);
  }
  throw error;
} finally {
  bot?.end();
  evidence.finishedAt = new Date().toISOString();
  await ps(`
    $updater = Join-Path $env:CRAFTPANEL_INSTALL_DIR "update.ps1"
    if (Test-Path -LiteralPath $updater) { $env:CRAFTPANEL_UNINSTALL = "1"; & powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File $updater }
    foreach ($name in @($env:CP_TASK, "$env:CP_TASK Update")) {
      if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) { Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName $name -Confirm:$false }
    }
    if (Get-Service -Name $env:CP_RUNTIME -ErrorAction SilentlyContinue) { Stop-Service -Name $env:CP_RUNTIME; & sc.exe delete $env:CP_RUNTIME | Out-Null }`, {}, 300_000)
    .catch((error) => { evidence.ok = false; evidence.cleanupError = error.message.slice(0, 1000); });
  if (passed && !evidence.cleanupError) await fs.rm(testRoot, { recursive: true, force: true }).catch(() => {});
  else console.log(`Test artifacts retained: ${testRoot}`);
  console.log(JSON.stringify(evidence, null, 2));
  await fs.writeFile(path.join(fixtures, "runtime-continuity-windows-evidence.json"), JSON.stringify(evidence, null, 2) + "\n").catch(() => {});
  if (evidence.cleanupError) process.exitCode = 1;
}
