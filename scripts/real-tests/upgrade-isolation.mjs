// Upgrade of a real earlier release with existing servers to per-server game accounts, on an isolated installed
// Linux service (root, systemd). Files written by the old version belong to the service account; the new runtime must
// hand them to each server's game account on its next start without losing anything.
//
//   curl -fsSL -o craftpanel-v1.0.0.tar.gz https://github.com/vctrchappot/CraftPanel/releases/download/v1.0.0/craftpanel-v1.0.0.tar.gz
//   node scripts/real-tests/installer-fixtures.mjs test-results/upgrade craftpanel-ops-up --previous craftpanel-v1.0.0.tar.gz
//   sudo node scripts/real-tests/upgrade-isolation.mjs test-results/upgrade craftpanel-ops-up 19688
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { client } from "./client.mjs";

const run = promisify(execFile);
const [fixturesArg, instance, portArg] = process.argv.slice(2);
if (process.platform !== "linux" || process.getuid() !== 0 || !/^craftpanel-ops-[a-z0-9-]+$/.test(instance ?? ""))
  throw new Error("Use Linux/root: upgrade-isolation.mjs FIXTURES craftpanel-ops-NAME PORT");
const fixtures = path.resolve(fixturesArg);
const manifest = JSON.parse(await fs.readFile(path.join(fixtures, "fixtures.json"), "utf8"));
if (!manifest.previous) throw new Error("The fixtures have no previous release; generate them with installer-fixtures.mjs --previous ARCHIVE");
const port = Number(portArg);
assert(Number.isInteger(port) && port >= 1024 && port <= 65535);
const data = `/var/lib/${instance}`;
const oldInstaller = manifest.previous.installer;
const oldArchive = manifest.previous.archive;
const newInstaller = path.join(fixtures, "install.sh");
const newArchive = path.join(fixtures, "craftpanel-v99.0.0.tar.gz");
const c = client(`http://127.0.0.1:${port}`);
const original = (await run("systemctl", ["show", "craftpanel", "-p", "MainPID", "--value"])).stdout.trim();
await assert.rejects(fs.access(data), { code: "ENOENT" });
const evidence = { instance, previous: manifest.previous.version, checks: [], startedAt: new Date().toISOString() };
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
const ids = async (name) => ({ name, uid: Number((await run("id", ["-u", name])).stdout), gid: Number((await run("id", ["-g", name])).stdout) });
const status = async (pid) => Object.fromEntries((await fs.readFile(`/proc/${pid}/status`, "utf8")).split("\n").map((l) => l.split(":\t")).filter((p) => p.length === 2));
/** The Java process whose working directory is a server's folder. */
const javaPid = async (dir) => {
  for (const entry of await fs.readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const cwd = await fs.readlink(`/proc/${entry}/cwd`).catch(() => "");
    const cmd = await fs.readFile(`/proc/${entry}/cmdline`, "utf8").catch(() => "");
    if (cwd === dir && /java/.test(cmd.split("\0")[0] ?? "")) return Number(entry);
  }
  return 0;
};
const sha256 = async (file) => crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex");
/** Runs a command as a game account, exactly like the runtime does, and reports whether it succeeded. */
const asGame = async (who, file, args) => {
  try { await run("setpriv", [`--reuid=${who.uid}`, `--regid=${who.gid}`, "--clear-groups", "--", file, ...args], { timeout: 10_000 }); return true; }
  catch { return false; }
};
const ready = () => wait(async () => (await fetch(`http://127.0.0.1:${port}/api/ready`)).ok, 120_000);

try {
  // ---- the old release, as a user has it: no game accounts, every server runs as the service account --------------
  await run("bash", [oldInstaller, "--archive", oldArchive, "--port", String(port)], { timeout: 300_000, maxBuffer: 4 * 1024 * 1024 });
  await assert.rejects(run("id", ["-u", `${instance}-game-00`]), "the old installer created game accounts");
  const service = await ids(instance);
  await ready();
  const setupToken = (await fs.readFile(path.join(data, "setup-token.txt"), "utf8")).trim();
  const setup = await fetch(`http://127.0.0.1:${port}/api/auth/setup`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "up-owner", password: "throwaway-upgrade-test-1", setupToken }) });
  assert(setup.ok, `Setup failed: ${setup.status}`);
  await c.signIn("up-owner", "throwaway-upgrade-test-1");
  const servers = [];
  for (const name of ["Old A", "Old B"]) servers.push(await c.create({ name, software: "paper", mcVersion: "1.21.4", memoryMb: 1024, port: await freePort(), bindAddress: "127.0.0.1" }));
  for (const s of servers) {
    await c.waitInstalled(s.id);
    await c.call("PUT", `/api/servers/${s.id}/properties`, { values: { "view-distance": "3", "simulation-distance": "3" } });
  }
  const [A, B] = servers.map((s) => ({ ...s }));
  for (const s of [A, B]) {
    const started = await c.start(s.id);
    s.directory = started.directory;
    s.pid = await wait(() => javaPid(s.directory), 30_000);
    assert.equal(Number((await status(s.pid)).Uid.split("\t")[0]), service.uid, `${s.name} did not run as the service account before the upgrade`);
  }
  record("before-the-upgrade-servers-run-as-the-service-account", { service: service.name, A: A.pid, B: B.pid });
  for (const s of [A, B]) await c.command(s.id, "save-all flush");
  await c.sleep(2000);
  for (const s of [A, B]) await c.stop(s.id);
  // What the old version left behind: files of the service account, readable by everyone, a plugin's data file.
  const note = path.join(A.directory, "plugins", "old-plugin-data.txt");
  await fs.mkdir(path.dirname(note), { recursive: true });
  await fs.writeFile(note, "written before the upgrade\n", { mode: 0o644 });
  await run("chown", ["-R", `${service.uid}:${service.gid}`, path.join(A.directory, "plugins")]);
  const levelDat = path.join(A.directory, "world", "level.dat");
  const levelBefore = await sha256(levelDat);
  const owned = (await fs.stat(levelDat)).uid;
  assert.equal(owned, service.uid, "level.dat is not the service account's before the upgrade");
  record("old-files-belong-to-the-service-account", { levelDatSha256: levelBefore.slice(0, 16) });

  // ---- the upgrade: current installer and release over the existing data, with the runtime restart it needs --------
  const upgrade = await run("bash", [newInstaller, "--archive", newArchive, "--port", String(port), "--allow-runtime-restart"],
    { env: { ...process.env, CRAFTPANEL_GAME_ACCOUNTS: "4" }, timeout: 300_000, maxBuffer: 4 * 1024 * 1024 });
  await fs.writeFile(path.join(fixtures, "upgrade.log"), upgrade.stdout + upgrade.stderr);
  const accounts = await Promise.all([0, 1, 2, 3].map((i) => ids(`${instance}-game-0${i}`)));
  const groups = (await run("id", ["-nG", instance])).stdout.trim().split(/\s+/);
  for (const a of accounts) assert(groups.includes(a.name), `${instance} is not in ${a.name}`);
  await ready();
  await c.signIn("up-owner", "throwaway-upgrade-test-1");
  assert.equal((await fs.stat(levelDat)).uid, service.uid, "the upgrade itself rewrote ownership (it should happen at each server's next start)");
  record("upgrade-created-game-accounts-and-kept-the-data", { accounts: accounts.map((a) => a.name) });

  // The deployment checks see it (Remote access shows the same).
  const checks = (await c.call("GET", "/api/system/diagnostics")).checks;
  const isolation = checks.find((k) => k.id === "isolation");
  assert(isolation && isolation.status === "ok", `isolation check: ${JSON.stringify(isolation)}`);
  const limits = checks.find((k) => k.id === "limits");
  assert(limits && limits.status === "ok", `limits check: ${JSON.stringify(limits)}`);
  record("deployment-checks-report-isolation-and-limits", { isolation: isolation.message, limits: limits.message });

  // ---- first start after the upgrade: the old servers move to game accounts with everything they had ----------------
  for (const s of [A, B]) {
    await c.start(s.id);
    s.pid = await wait(() => javaPid(s.directory), 30_000);
  }
  const uidOf = async (pid) => Number((await status(pid)).Uid.split("\t")[0]);
  const [uidA, uidB] = [await uidOf(A.pid), await uidOf(B.pid)];
  const gameA = accounts.find((a) => a.uid === uidA), gameB = accounts.find((a) => a.uid === uidB);
  assert(gameA && gameB && gameA !== gameB, `The old servers run as ${uidA}/${uidB}, not as two different game accounts`);
  for (const s of [A, B]) {
    const st = await status(s.pid);
    for (const key of ["CapInh", "CapPrm", "CapEff", "CapAmb"]) assert.equal(BigInt("0x" + st[key]), 0n, `${key} of ${s.name} is ${st[key]}`);
    assert.equal(st.NoNewPrivs, "1");
    assert.equal(st.Groups.trim(), "", "supplementary groups survived");
  }
  record("old-servers-start-under-their-game-accounts-without-capabilities", { A: gameA.name, B: gameB.name });

  const dirStat = await fs.stat(A.directory);
  assert.equal(dirStat.mode & 0o7777, 0o2770, `server directory mode ${(dirStat.mode & 0o7777).toString(8)}`);
  assert.equal(dirStat.gid, gameA.gid);
  const levelStat = await fs.stat(levelDat);
  assert.equal(levelStat.gid, gameA.gid, "level.dat did not get the game group");
  assert.equal(levelStat.mode & 0o007, 0, "level.dat is still accessible to everyone");
  assert(await asGame(gameA, "cat", [note]), "the game account cannot read the plugin file the old version wrote");
  assert(await asGame(gameA, "touch", [note]), "the game account cannot write the plugin file the old version wrote");
  await c.command(A.id, "save-all flush");
  await c.sleep(2000);
  record("old-files-were-handed-to-the-game-account", { mode: (dirStat.mode & 0o7777).toString(8), levelDatGroup: levelStat.gid });

  // The world is the one the old version saved, and the server found it.
  const log = (await c.call("GET", `/api/servers/${A.id}/files/content?path=${encodeURIComponent("logs/latest.log")}`)).content;
  assert.match(log, /Done \(/);
  assert.doesNotMatch(log, /Failed to load level|Failed to read level|Failed to access/i);
  assert(await fs.access(path.join(A.directory, "world", "region")).then(() => true, () => false), "the world folder disappeared");
  record("the-old-world-loads", { levelDatChangedBySaving: (await sha256(levelDat)) !== levelBefore });

  // What the game account must not reach, and what the dashboard still can.
  const denied = { database: path.join(data, "craftpanel.db"), runtimeToken: path.join(data, "runtime", "token"), otherServer: path.join(B.directory, "server.properties") };
  for (const [what, file] of Object.entries(denied)) assert.equal(await asGame(gameA, "cat", [file]), false, `the old server's account can read ${what}`);
  await c.call("PUT", `/api/servers/${A.id}/files/content`, { path: "dashboard-note.txt", content: "written by the dashboard after the upgrade\n" });
  assert(await asGame(gameA, "cat", [path.join(A.directory, "dashboard-note.txt")]), "the game account cannot read a file the dashboard wrote");
  await c.call("POST", `/api/servers/${A.id}/backups`, { note: "after the upgrade" });
  const backup = await wait(async () => (await c.call("GET", `/api/backups?serverId=${A.id}`)).find((b) => b.status === "completed" || b.status === "failed"), 180_000);
  assert.equal(backup.status, "completed", backup.error);
  record("secrets-stay-closed-and-the-dashboard-still-works", { backup: backup.id });

  for (const s of [A, B]) await c.stop(s.id);
  evidence.ok = true;
} catch (error) {
  evidence.error = String(error.message).slice(0, 1000);
  throw error;
} finally {
  evidence.finishedAt = new Date().toISOString();
  let cleanupError;
  try { await run("bash", [newInstaller, "--uninstall"], { timeout: 150_000 }); }
  catch (error) { cleanupError = error; evidence.ok = false; }
  await fs.rm(data, { recursive: true, force: true });
  await fs.rm(`/etc/${instance}`, { recursive: true, force: true });
  await fs.rm(`/var/log/${instance}`, { recursive: true, force: true });
  await run("userdel", [instance]).catch(() => undefined);
  for (let i = 0; i < 4; i++) {
    await run("userdel", [`${instance}-game-0${i}`]).catch(() => undefined);
    await run("groupdel", [`${instance}-game-0${i}`]).catch(() => undefined);
  }
  evidence.originalServiceUnchanged = (await run("systemctl", ["show", "craftpanel", "-p", "MainPID", "--value"])).stdout.trim() === original;
  await fs.writeFile(path.join(fixtures, "upgrade-evidence.json"), JSON.stringify(evidence, null, 2) + "\n").catch(() => undefined);
  if (cleanupError) throw cleanupError;
  assert(evidence.originalServiceUnchanged, "Existing CraftPanel service changed");
}
