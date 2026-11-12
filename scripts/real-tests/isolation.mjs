// Per-server OS isolation on an isolated installed Linux service (root, systemd).
// node scripts/real-tests/installer-fixtures.mjs test-results/isolation craftpanel-ops-iso
// sudo node scripts/real-tests/isolation.mjs test-results/isolation craftpanel-ops-iso 19686 [JAVA_PATH]
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { client } from "./client.mjs";

const run = promisify(execFile);
const [fixturesArg, instance, portArg, javaPath] = process.argv.slice(2);
if (process.platform !== "linux" || process.getuid() !== 0 || !/^craftpanel-ops-[a-z0-9-]+$/.test(instance ?? ""))
  throw new Error("Use Linux/root: isolation.mjs FIXTURES craftpanel-ops-NAME PORT [JAVA_PATH]");
const fixtures = path.resolve(fixturesArg);
const port = Number(portArg);
assert(Number.isInteger(port) && port >= 1024 && port <= 65535);
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
const account = async (name) => ({ name, uid: Number((await run("id", ["-u", name])).stdout), gid: Number((await run("id", ["-g", name])).stdout) });
const status = async (pid) => Object.fromEntries((await fs.readFile(`/proc/${pid}/status`, "utf8")).split("\n").map((l) => l.split(":\t")).filter((p) => p.length === 2));
/** Runs a command as a game account, exactly like the runtime does, and reports whether it succeeded. */
const asGame = async (who, file, args) => {
  try { await run("setpriv", [`--reuid=${who.uid}`, `--regid=${who.gid}`, "--clear-groups", "--", file, ...args], { timeout: 10_000 }); return true; }
  catch { return false; }
};

let accounts = [];
try {
  await run("bash", [installer, "--archive", path.join(fixtures, "craftpanel-v99.0.0.tar.gz"), "--port", String(port)], { env: { ...process.env, CRAFTPANEL_GAME_ACCOUNTS: "4" }, timeout: 300_000, maxBuffer: 4 * 1024 * 1024 });
  accounts = await Promise.all([0, 1, 2, 3].map((i) => account(`${instance}-game-0${i}`)));
  const groups = (await run("id", ["-nG", instance])).stdout.trim().split(/\s+/);
  for (const a of accounts) assert(groups.includes(a.name), `${instance} is not in ${a.name}`);
  record("installer-created-game-accounts", { accounts: accounts.map((a) => `${a.name}=${a.uid}`) });
  await wait(async () => (await fetch(`http://127.0.0.1:${port}/api/ready`)).ok);

  let sharedJava;
  if (javaPath) {
    const target = path.join(data, "runtimes", "java", "isolation-jdk");
    await fs.cp(path.dirname(path.dirname(path.resolve(javaPath))), target, { recursive: true });
    await run("chown", ["-R", `${instance}:${instance}`, target]);
    await run("chmod", ["-R", "o-rwx", target]);
    sharedJava = path.join(target, "bin", "java");
  }
  const setupToken = (await fs.readFile(path.join(data, "setup-token.txt"), "utf8")).trim();
  const setup = await fetch(`http://127.0.0.1:${port}/api/auth/setup`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "iso-owner", password: "throwaway-isolation-test-1", setupToken }) });
  assert(setup.ok, `Setup failed: ${setup.status}`);
  await c.signIn("iso-owner", "throwaway-isolation-test-1");
  const servers = [];
  for (const name of ["Isolated A", "Isolated B"]) {
    const s = await c.create({ name, software: "paper", mcVersion: "1.21.4", memoryMb: 1024, port: await freePort(), bindAddress: "127.0.0.1", ...(sharedJava ? { javaPath: sharedJava } : {}) });
    servers.push(s);
  }
  for (const s of servers) {
    await c.waitInstalled(s.id);
    await c.call("PUT", `/api/servers/${s.id}/properties`, { values: { "view-distance": "3", "simulation-distance": "3" } });
  }
  const [A, B] = [await c.start(servers[0].id), await c.start(servers[1].id)];
  const owner = async (pid) => Number((await status(pid)).Uid.split("\t")[0]);
  const uidA = await owner(A.pid), uidB = await owner(B.pid);
  const accA = accounts.find((a) => a.uid === uidA), accB = accounts.find((a) => a.uid === uidB);
  assert(accA && accB && accA !== accB, `Servers run as ${uidA}/${uidB}, not as two different game accounts`);
  for (const s of [A, B]) {
    const st = await status(s.pid);
    for (const key of ["CapInh", "CapPrm", "CapEff", "CapAmb"]) assert.equal(BigInt("0x" + st[key]), 0n, `${key} of PID ${s.pid} is ${st[key]}`);
    assert.equal(st.NoNewPrivs, "1");
    const gid = accounts.find((a) => a.uid === Number(st.Uid.split("\t")[0])).gid;
    assert.equal(Number(st.Gid.split("\t")[0]), gid);
    assert.equal(st.Groups.trim(), "", "supplementary groups survived");
  }
  const consoleA = (await c.log(A.id)).map((l) => l.text).join("\n");
  assert.match(consoleA, new RegExp(`as ${accA.name}`));
  record("servers-run-as-separate-game-accounts-without-capabilities", { A: accA.name, B: accB.name, pidA: A.pid, pidB: B.pid });

  const dirA = A.directory, dirB = B.directory;
  const stA = await fs.stat(dirA);
  assert.equal(stA.mode & 0o7777, 0o2770);
  assert.equal(stA.gid, accA.gid);
  const latest = await fs.stat(path.join(dirA, "logs", "latest.log"));
  assert.equal(latest.uid, accA.uid);
  assert.equal(latest.gid, accA.gid);
  assert.equal(latest.mode & 0o077, 0o060);
  record("server-directory-shared-with-its-group-only", { mode: (stA.mode & 0o7777).toString(8), latestLog: (latest.mode & 0o777).toString(8) });

  // What a malicious plugin in server A could try.
  assert(await asGame(accA, "cat", [path.join(dirA, "server.properties")]), "A cannot read its own files");
  const denied = {
    database: path.join(data, "craftpanel.db"),
    runtimeToken: path.join(data, "runtime", "token"),
    setupToken: path.join(data, "setup-token.txt"),
    otherServer: path.join(dirB, "server.properties"),
  };
  for (const [what, file] of Object.entries(denied)) assert.equal(await asGame(accA, "cat", [file]), false, `A can read ${what}`);
  for (const dir of [data, path.join(data, "servers"), path.join(data, "backups"), dirB]) assert.equal(await asGame(accA, "ls", [dir]), false, `A can list ${dir}`);
  assert.equal(await asGame(accA, "touch", [path.join(dirB, "planted")]), false, "A can write into B");
  record("game-account-cannot-read-panel-secrets-or-other-servers", { denied: Object.keys(denied) });

  // The dashboard still reads and writes everything: file manager, backups.
  const log = await c.call("GET", `/api/servers/${A.id}/files/content?path=${encodeURIComponent("logs/latest.log")}`);
  assert.match(log.content, /Done \(/);
  await c.call("PUT", `/api/servers/${A.id}/files/content`, { path: "dashboard-note.txt", content: "written by the dashboard\n" });
  assert(await asGame(accA, "cat", [path.join(dirA, "dashboard-note.txt")]), "A cannot read a file the dashboard wrote");
  await c.call("POST", `/api/servers/${A.id}/backups`, { note: "isolation" });
  const backup = await wait(async () => (await c.call("GET", `/api/backups?serverId=${A.id}`)).find((b) => b.status === "completed" || b.status === "failed"), 180_000);
  assert.equal(backup.status, "completed", backup.error);
  // Java writes level.dat through a 0600 temp file; downloads and exports ask the runtime to share it.
  await c.command(A.id, "save-all flush");
  await c.sleep(2000);
  const levelMode = (await fs.stat(path.join(dirA, "world", "level.dat"))).mode & 0o777;
  const download = await fetch(`http://127.0.0.1:${port}/api/servers/${A.id}/files/download?path=${encodeURIComponent("world/level.dat")}`, { headers: { cookie: c.session().cookie } });
  assert.equal(download.status, 200, `level.dat download: ${download.status}`);
  assert((await download.arrayBuffer()).byteLength > 100);
  const exported = await fetch(`http://127.0.0.1:${port}/api/servers/${A.id}/worlds/world/export`, { headers: { cookie: c.session().cookie } });
  assert.equal(exported.status, 200, `world export: ${exported.status}`);
  assert((await exported.arrayBuffer()).byteLength > 10_000);
  record("dashboard-reads-writes-and-backs-up-game-files", { backup: backup.id, levelDatModeAfterSave: levelMode.toString(8) });

  // Leftovers: a process a plugin forked off dies with its server.
  spawn("setpriv", [`--reuid=${accA.uid}`, `--regid=${accA.gid}`, "--clear-groups", "--", "setsid", "-f", "sleep", "600"], { stdio: "ignore", detached: true }).unref();
  await wait(async () => (await run("pgrep", ["-u", String(accA.uid), "sleep"]).then(() => true, () => false)));
  await c.stop(A.id);
  await wait(async () => (await run("pgrep", ["-u", String(accA.uid)]).then(() => false, () => true)), 15_000);
  record("leftover-processes-stopped-with-their-server");

  // Restore renames entries in from outside the server directory; the next start must fix them.
  await c.call("POST", `/api/backups/${backup.id}/restore`);
  const restarted = await c.start(A.id);
  assert.equal(await owner(restarted.pid), accA.uid);
  record("restored-server-starts-under-its-account", { pid: restarted.pid });

  // Accounts stay with their servers across a runtime restart.
  await run("systemctl", ["stop", instance]);
  await run("systemctl", ["restart", `${instance}-runtime`], { timeout: 150_000 });
  await run("systemctl", ["start", instance]);
  await wait(async () => (await fetch(`http://127.0.0.1:${port}/api/ready`)).ok);
  await c.signIn("iso-owner", "throwaway-isolation-test-1");
  for (const [s, acc] of [[A, accA], [B, accB]]) {
    const again = await c.start(s.id);
    assert.equal(await owner(again.pid), acc.uid, `${s.name} changed accounts`);
  }
  record("accounts-stable-across-runtime-restart");
  for (const s of servers) await c.stop(s.id);
  evidence.ok = true;
} catch (error) {
  evidence.error = String(error.message).slice(0, 1000);
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
  for (let i = 0; i < 4; i++) {
    await run("userdel", [`${instance}-game-0${i}`]).catch(() => undefined);
    await run("groupdel", [`${instance}-game-0${i}`]).catch(() => undefined);
  }
  evidence.originalServiceUnchanged = (await run("systemctl", ["show", "craftpanel", "-p", "MainPID", "--value"])).stdout.trim() === original;
  await fs.writeFile(path.join(fixtures, "isolation-evidence.json"), JSON.stringify(evidence, null, 2) + "\n").catch(() => undefined);
  if (cleanupError) throw cleanupError;
  assert(evidence.originalServiceUnchanged, "Existing CraftPanel service changed");
}
