// A scheduled application backup from a standalone host, imported into a fresh installed service.
// Linux/root: node app-migration-service.mjs FIXTURES craftpanel-ops-move
// Windows/elevated dashboard owner: node app-migration-service.mjs FIXTURES
// Each run owns its source processes and a new service/task; existing installations are untouched.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { client } from "./client.mjs";

const run = promisify(execFile);
const windows = process.platform === "win32";
const [fixturesArg, instance = "craftpanel-ops-move"] = process.argv.slice(2);
if (!fixturesArg || (!windows && (process.platform !== "linux" || process.getuid() !== 0)) || !/^craftpanel-ops-[a-z0-9-]+$/.test(instance))
  throw new Error("Use Linux/root or Windows/elevated: app-migration-service.mjs FIXTURES [craftpanel-ops-NAME]");
const fixtures = path.resolve(fixturesArg);
const root = await fs.mkdtemp(path.join(os.tmpdir(), "cp-service-move-"));
const source = path.join(root, "source");
const task = `CraftPanel Move ${crypto.randomBytes(5).toString("hex")}`;
const runtime = `${task} Runtime`;
const install = windows ? path.join(root, "app") : `/opt/${instance}`;
const data = windows ? path.join(root, "target") : `/var/lib/${instance}`;
const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../apps/api/dist");
// PowerShell 7's module path cannot be used by the installer's Windows PowerShell 5.1 child.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CRAFTPANEL_") && (!windows || k.toLowerCase() !== "psmodulepath")));
const freePort = async () => {
  const listener = net.createServer();
  await new Promise((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
  const { port } = listener.address();
  await new Promise((resolve) => listener.close(resolve));
  return port;
};
const portA = await freePort(), portB = await freePort();
const a = client(`http://127.0.0.1:${portA}`), b = client(`http://127.0.0.1:${portB}`);
const credentials = ["migration-owner", "throwaway-migration-test-1"];
const targetEnv = { ...env, CRAFTPANEL_INSTALL_DIR: install, CRAFTPANEL_DATA_DIR: data, CRAFTPANEL_TASK_NAME: task,
  CRAFTPANEL_PORT: String(portB), CRAFTPANEL_GAME_ACCOUNTS: "2", CP_RUNTIME: runtime, CP_TASK: task,
  CP_INSTALLER: path.join(fixtures, "install.ps1"), CRAFTPANEL_ARCHIVE: path.join(fixtures, "craftpanel-v99.0.0.tar.gz") };
const ps = async (script, extra = {}) => {
  try {
    return (await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { env: { ...targetEnv, ...extra }, timeout: 300_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true })).stdout.trim();
  } catch (error) {
    // The installer reports errors on stdout; include them in the retained JSON evidence too.
    throw new Error([error.message, error.stdout, error.stderr].filter(Boolean).join("\n"), { cause: error });
  }
};
if (windows) assert.equal(await ps("([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)"), "True", "Run elevated");
else { assert(instance.length <= 24); await assert.rejects(fs.access(data), { code: "ENOENT" }); }
const original = windows ? null : (await run("systemctl", ["show", "craftpanel", "-p", "MainPID", "--value"])).stdout.trim();
const wait = async (fn, timeout = 120_000) => {
  let last;
  for (const end = Date.now() + timeout; Date.now() < end; await a.sleep(250)) {
    try { const result = await fn(); if (result) return result; } catch (error) { last = error; }
  }
  throw last ?? new Error("Acceptance condition timed out");
};
const ready = (port) => wait(async () => (await fetch(`http://127.0.0.1:${port}/api/ready`)).ok);
const children = [];
const evidence = { platform: process.platform, checks: [], startedAt: new Date().toISOString() };
const record = (check, extra = {}) => { evidence.checks.push({ check, ...extra }); console.log(`PASS ${check} ${JSON.stringify(extra)}`); };
const stopSource = async () => {
  await Promise.all(children.map((child) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    // Subscribe before terminating, and allow cleanup to be called again after a signal exit.
    return new Promise((resolve, reject) => {
      child.once("exit", resolve);
      child.once("error", reject);
      child.kill("SIGTERM");
    });
  }));
};
let installed = false, id, log;
try {
  await fs.mkdir(source);
  log = await fs.open(path.join(root, "source.log"), "a");
  for (const entry of ["runtime.js", "index.js"]) children.push(spawn(process.execPath, [path.join(dist, entry)], {
    env: { ...env, CRAFTPANEL_DATA_DIR: source, CRAFTPANEL_PORT: String(portA), CRAFTPANEL_HOST: "127.0.0.1", CRAFTPANEL_UPDATE_CHECK: "false" },
    stdio: ["ignore", log.fd, log.fd], windowsHide: true,
  }));
  await ready(portA);
  await a.signIn(...credentials);
  id = (await a.create({ name: "Service migration", software: "paper", mcVersion: "1.21.4", memoryMb: 1024, port: await freePort(), bindAddress: "127.0.0.1", autoStart: true })).id;
  await a.waitInstalled(id);
  await a.call("PUT", `/api/servers/${id}/properties`, { values: { "view-distance": "3", "simulation-distance": "3", motd: "Moved to a service" } });
  await a.start(id);
  await a.command(id, "forceload add 0 0");
  await a.sleep(1000);
  await a.command(id, "setblock 0 100 0 minecraft:gold_block");
  await a.command(id, "save-all flush");
  await a.sleep(2000);
  // The actual cron callback, followed by two manual runs of that same schedule, exercises retention.
  const schedule = await a.call("POST", "/api/schedules", { name: "Migration backup", cron: "* * * * * *", action: "application-backup", payload: { includeServers: true, keep: 2 }, enabled: true });
  await wait(async () => (await a.call("GET", `/api/schedules/${schedule.id}/runs`)).some((r) => r.status === "success"), 300_000);
  await a.call("PUT", `/api/schedules/${schedule.id}`, { ...schedule, enabled: false });
  await wait(async () => !(await a.call("GET", "/api/app-backups")).progress.running, 300_000);
  for (let i = 0; i < 2; i++) {
    const before = (await a.call("GET", `/api/schedules/${schedule.id}/runs`)).length;
    await a.call("POST", `/api/schedules/${schedule.id}/run`);
    await wait(async () => {
      const runs = await a.call("GET", `/api/schedules/${schedule.id}/runs`);
      if (runs[0]?.status === "failed") throw new Error(runs[0].output);
      return runs.length > before && runs[0].status === "success";
    }, 300_000);
  }
  const listing = await a.call("GET", "/api/app-backups");
  assert.equal(listing.backups.length, 2);
  assert(listing.backups.every((f) => f.scheduleId === schedule.id && f.servers.withFiles === 1));
  assert.equal((await a.server(id)).status, "running");
  record("cron-and-retention-with-a-running-paper-server", { kept: listing.backups.length });
  const transfer = path.join(root, "transfer.zip");
  await fs.copyFile(path.join(source, "backups/application", listing.backups[0].filename), transfer);
  await a.stop(id);
  await stopSource();

  // Install the target first, then import under the dashboard account while both services are stopped.
  installed = true; // A partially failed install must be cleaned up too.
  if (windows) {
    await ps("& powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File $env:CP_INSTALLER; exit $LASTEXITCODE");
  } else await run("bash", [path.join(fixtures, "install.sh"), "--archive", targetEnv.CRAFTPANEL_ARCHIVE, "--port", String(portB)], { env: targetEnv, timeout: 300_000, maxBuffer: 4 * 1024 * 1024 });
  await ready(portB);
  if (windows) {
    await ps("Stop-ScheduledTask -TaskName $env:CP_TASK; Stop-Service -Name $env:CP_RUNTIME");
    await wait(async () => (await ps("(Get-ScheduledTask -TaskName $env:CP_TASK).State")) !== "Running");
  } else await run("systemctl", ["stop", instance, `${instance}-runtime`]);
  const targetArchive = path.join(data, "transfer.zip");
  await fs.copyFile(transfer, targetArchive);
  if (!windows) { await run("chown", [`${instance}:${instance}`, targetArchive]); await fs.chmod(targetArchive, 0o600); }
  const args = [path.join(install, "apps/api/dist/index.js"), "import-backup", targetArchive];
  const result = windows
    ? await run(process.execPath, args, { env: targetEnv, timeout: 300_000, windowsHide: true })
    : await run("runuser", ["-u", instance, "--", "env", `CRAFTPANEL_DATA_DIR=${data}`, process.execPath, ...args], { timeout: 300_000 });
  assert.match(result.stdout, /Restored 1 server\(s\), 1 with their files and worlds/);
  const directory = path.join(data, "servers", id);
  await fs.access(path.join(directory, "world/level.dat"));
  if (!windows) {
    const uid = Number((await run("id", ["-u", instance])).stdout);
    assert.equal((await fs.stat(path.join(data, "craftpanel.db"))).uid, uid);
    assert.equal((await fs.stat(path.join(directory, "world/level.dat"))).uid, uid);
  }
  record("import-runs-as-the-dashboard-account-while-services-are-stopped");
  if (windows) await ps("Start-Service -Name $env:CP_RUNTIME; Start-ScheduledTask -TaskName $env:CP_TASK");
  else await run("systemctl", ["start", `${instance}-runtime`, instance]);
  await ready(portB);
  await b.signIn(...credentials);
  const moved = await b.waitStatus(id, "running", 15 * 60_000);
  assert.equal(moved.directory, directory);
  assert.equal(moved.installState, "installed");
  assert((await fs.readdir(directory)).some((n) => n.endsWith(".jar")), "Game files were not downloaded again");
  await b.command(id, "execute if block 0 100 0 minecraft:gold_block run say service-move-gold-intact");
  await wait(async () => (await b.log(id)).some((l) => l.stream !== "command" && l.text.includes("service-move-gold-intact")));
  if (windows) {
    const service = JSON.parse(await ps("Get-CimInstance Win32_Service -Filter (\"Name='\" + $env:CP_RUNTIME.Replace(\"'\", \"''\") + \"'\") | Select-Object StartName | ConvertTo-Json -Compress"));
    assert.equal(service.StartName, `NT SERVICE\\${runtime}`);
    assert((await b.log(id)).some((l) => /Starting:.*\(restricted token\)$/.test(l.text)));
    assert(!(await b.log(id)).some((l) => l.text.includes("Isolation is incomplete")));
    assert.match((await run("icacls", [directory])).stdout, /S-1-9-\d+-\d+-\d+-\d+-\d+:\(OI\)\(CI\)\(M\)/);
  } else {
    const stat = await fs.readFile(`/proc/${moved.pid}/status`, "utf8");
    const uid = Number(stat.match(/^Uid:\s+(\d+)/m)[1]);
    const game = (await run("id", ["-un", String(uid)])).stdout.trim();
    assert(game.startsWith(`${instance}-game-`), `Java runs as ${game}`);
    const gid = Number((await run("id", ["-g", game])).stdout);
    assert.equal((await fs.stat(directory)).gid, gid);
    for (const secret of [path.join(data, "craftpanel.db"), path.join(data, "runtime/token")]) {
      await assert.rejects(run("setpriv", [`--reuid=${uid}`, `--regid=${gid}`, "--clear-groups", "--", "cat", secret]));
    }
  }
  record("first-start-reinstalls-game-files-preserves-world-and-applies-service-isolation", { pid: moved.pid });
  // A backup after the move must still read Minecraft's private files through the runtime.
  await b.call("POST", "/api/app-backups", { includeServers: true });
  await wait(async () => {
    const state = await b.call("GET", "/api/app-backups");
    if (state.progress.error) throw new Error(state.progress.error);
    return !state.progress.running && state.backups.some((f) => f.servers?.withFiles === 1);
  }, 300_000);
  record("dashboard-can-back-up-the-imported-game-files");
  await b.stop(id);
  evidence.ok = true;
} catch (error) {
  evidence.error = error.message;
  console.error(error.stack);
  for (const file of [path.join(root, "source.log"), path.join(data, "logs/runtime.err.log"), path.join(data, "logs/craftpanel.err.log")]) {
    const text = await fs.readFile(file, "utf8").catch(() => null);
    if (text) console.log(`${file}\n${text.split(/\r?\n/).slice(-40).join("\n")}`);
  }
  throw error;
} finally {
  if (id) { await a.call("POST", `/api/servers/${id}/kill`).catch(() => {}); await b.call("POST", `/api/servers/${id}/kill`).catch(() => {}); }
  await stopSource();
  await log?.close();
  try {
    if (installed && windows) await ps("$env:CRAFTPANEL_UNINSTALL = '1'; & powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File $env:CP_INSTALLER; exit $LASTEXITCODE");
    if (!windows) {
      if (installed) await run("bash", [path.join(fixtures, "install.sh"), "--uninstall"], { timeout: 180_000 });
      // Only the throwaway instance, checked before installation above.
      for (const dir of [data, `/etc/${instance}`, `/var/log/${instance}`]) await fs.rm(dir, { recursive: true, force: true });
      await run("userdel", [instance]).catch(() => {});
      for (let i = 0; i < 2; i++) { await run("userdel", [`${instance}-game-0${i}`]).catch(() => {}); await run("groupdel", [`${instance}-game-0${i}`]).catch(() => {}); }
      assert.equal((await run("systemctl", ["show", "craftpanel", "-p", "MainPID", "--value"])).stdout.trim(), original);
    }
  } catch (error) { evidence.ok = false; evidence.cleanupError = error.message; process.exitCode = 1; }
  evidence.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(fixtures, `app-migration-service-${process.platform}-evidence.json`), JSON.stringify(evidence, null, 2) + "\n");
  console.log(JSON.stringify(evidence, null, 2));
  if (evidence.ok) await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
  else console.log(`Test artifacts retained: ${root}`);
}
