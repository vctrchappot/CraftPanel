// Dashboard-triggered updates and concurrent installers against an isolated installed Linux service.
// node dashboard-update.mjs FIXTURES craftpanel-ops-NAME PORT   (root, disposable systemd host)
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { client } from "./client.mjs";

const run = promisify(execFile);
const [fixturesArg, instance, portArg] = process.argv.slice(2);
if (process.platform !== "linux" || process.getuid() !== 0 || !/^craftpanel-ops-[a-z0-9-]+$/.test(instance ?? ""))
  throw new Error("Use Linux/root: dashboard-update.mjs FIXTURES craftpanel-ops-NAME PORT");
const fixtures = path.resolve(fixturesArg);
const port = Number(portArg);
assert(Number.isInteger(port) && port >= 1024 && port <= 65535);
const data = `/var/lib/${instance}`;
const app = `/opt/${instance}`;
// installer-fixtures.mjs renames craftpanel → the instance name, also in the settings file name.
const envFile = `/etc/${instance}/${instance}.env`;
const installer = path.join(fixtures, "install.sh");
const archive = (version) => path.join(fixtures, `craftpanel-v${version}.tar.gz`);
const c = client(`http://127.0.0.1:${port}`);
const credentials = ["update-owner", "throwaway-update-acceptance-1"];
const unitPid = async (unit) => (await run("systemctl", ["show", unit, "-p", "MainPID", "--value"])).stdout.trim();
const original = await unitPid("craftpanel");
for (const target of [app, data, `/etc/systemd/system/${instance}.service`]) await assert.rejects(fs.access(target), { code: "ENOENT" });
const evidence = { instance, scenarios: [], startedAt: new Date().toISOString() };
const record = (scenario, extra = {}) => { evidence.scenarios.push({ scenario, ...extra }); console.log(`PASS ${scenario} ${JSON.stringify(extra)}`); };
const wait = async (fn, timeout = 90_000) => {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { const value = await fn(); if (value) return value; } catch (error) { last = error; }
    await c.sleep(500);
  }
  throw last ?? new Error("Acceptance condition timed out");
};
const ready = () => wait(async () => (await fetch(`http://127.0.0.1:${port}/api/ready`)).ok, 180_000);
const installed = async () => JSON.parse(await fs.readFile(path.join(app, "release.json"), "utf8")).version;
const install = (version, extra = []) => new Promise((resolve) => {
  const child = spawn("bash", [installer, "--archive", archive(version), "--port", String(port), ...extra], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  child.on("close", (code) => resolve({ code, output }));
});
// The dashboard offers exactly what this folder holds: one release archive and its checksum.
const offer = async (version) => {
  const dir = path.join(fixtures, "dashboard-offer");
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  const name = path.basename(archive(version));
  await fs.copyFile(archive(version), path.join(dir, name));
  await fs.writeFile(path.join(dir, "SHA256SUMS"), `${crypto.createHash("sha256").update(await fs.readFile(archive(version))).digest("hex")}  ${name}\n`);
  await run("chmod", ["-R", "a+rX", dir]);
  return dir;
};
const signIn = () => wait(async () => { await c.signIn(...credentials); return true; }, 60_000);
// Starts an update like "Update now" and waits until the installer's result for this request exists.
const dashboardUpdate = async (approvedRuntime) => {
  const status = await c.call("GET", "/api/updates?refresh=1");
  assert.equal(status.available, true, `No update offered: ${JSON.stringify(status)}`);
  const started = await c.call("POST", "/api/updates/install", approvedRuntime ? { approvedRuntime } : {});
  assert.equal(started.target, status.latest);
  const result = await wait(async () => {
    const progress = await c.call("GET", "/api/updates/progress").catch(async (error) => { if (error.status === 401) await signIn(); throw error; });
    return progress.result && progress.result.finishedAt >= started.startedAt ? progress : null;
  }, 360_000);
  await ready();
  await signIn();
  return { status, result: result.result, log: result.log };
};

try {
  const first = await install("99.0.0");
  await fs.writeFile(path.join(fixtures, "dashboard-update-install.log"), first.output);
  assert.equal(first.code, 0, "Initial install failed");
  await ready();
  const setupToken = (await fs.readFile(path.join(data, "setup-token.txt"), "utf8")).trim();
  const response = await fetch(`http://127.0.0.1:${port}/api/auth/setup`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: credentials[0], password: credentials[1], setupToken }),
  });
  assert(response.ok, `Setup failed: ${response.status} ${await response.text()}`);
  await signIn();
  const runtimePid = await unitPid(`${instance}-runtime`);

  // 1. A release whose migration fails: the dashboard starts it, the installer rolls back.
  const offered = await offer("99.0.1");
  await fs.access(envFile);
  await fs.appendFile(envFile, `\nCRAFTPANEL_RELEASE_DIR=${offered}\n`);
  await run("systemctl", ["restart", instance]);
  await ready();
  await signIn();
  const failed = await dashboardUpdate();
  assert.equal(failed.status.latest, "99.0.1");
  assert.equal(failed.result.ok, false, "The broken release was reported as installed");
  assert.equal(failed.result.rolledBack, true, "The failed update was not rolled back");
  assert.equal(await installed(), "99.0.0");
  assert.equal(await unitPid(`${instance}-runtime`), runtimePid, "A dashboard-only update restarted the runtime");
  assert((await c.call("GET", "/api/updates/progress")).log.length > 0, "The failed update's log is not shown after the restart");
  record("dashboard-update-failed-migration-rolls-back", { result: failed.result, runtimePid });

  // 2. A runtime change needs the exact approval before anything stops.
  await offer("99.0.4");
  const runtimeOffer = await c.call("GET", "/api/updates?refresh=1");
  assert.equal(runtimeOffer.latest, "99.0.4");
  assert.equal(runtimeOffer.interruption, "required");
  const refused = await c.call("POST", "/api/updates/install", {}).then(() => null, (error) => error);
  assert.equal(refused?.status, 409);
  assert.match(refused.body, /runtime_update_confirmation/);
  assert.equal(await installed(), "99.0.0");
  assert.equal(await unitPid(`${instance}-runtime`), runtimePid);
  record("dashboard-runtime-update-refused-without-approval");

  // 3. With the approval for this runtime, the update installs and restarts the runtime.
  const approved = await dashboardUpdate(runtimeOffer.runtime.sha256);
  assert.equal(approved.result.ok, true, `Approved update failed: ${approved.log.slice(-10).join("\n")}`);
  assert.equal(await installed(), "99.0.4");
  const newRuntimePid = await unitPid(`${instance}-runtime`);
  assert.notEqual(newRuntimePid, runtimePid);
  // Fixtures relabel release.json only; the application inside still reports the checkout's version.
  assert((await c.call("GET", "/api/updates/progress")).result.ok, "The successful result is not shown after the restart");
  record("dashboard-runtime-update-approved-installs", { result: approved.result, runtimePid: newRuntimePid });

  // 4. Two installers at once: one holds the lock, the other is refused and changes nothing.
  const runtimeBefore = newRuntimePid;
  const [a, b] = await Promise.all([install("99.0.4"), install("99.0.4")]);
  await fs.writeFile(path.join(fixtures, "dashboard-update-concurrent.log"), `--- A (${a.code})\n${a.output}\n--- B (${b.code})\n${b.output}`);
  const codes = [a.code, b.code].sort();
  assert.equal(codes[0], 0, "Neither concurrent installer succeeded");
  assert.notEqual(codes[1], 0, "Both concurrent installers ran");
  assert.match((a.code ? a : b).output, /Another CraftPanel install or update is already running/);
  await ready();
  assert.equal(await installed(), "99.0.4");
  assert.equal(await unitPid(`${instance}-runtime`), runtimeBefore, "A same-runtime reinstall restarted the runtime");
  record("concurrent-installers-one-refused");
  evidence.ok = true;
} catch (error) {
  evidence.error = String(error.message).slice(0, 1000);
  throw error;
} finally {
  evidence.finishedAt = new Date().toISOString();
  try { await run("bash", [installer, "--uninstall"], { timeout: 150_000 }); }
  catch (error) { evidence.ok = false; evidence.cleanupError = error.message.slice(0, 1000); }
  evidence.originalServiceUnchanged = (await unitPid("craftpanel")) === original;
  if (!evidence.originalServiceUnchanged) evidence.ok = false;
  await fs.writeFile(path.join(fixtures, "dashboard-update-evidence.json"), JSON.stringify(evidence, null, 2) + "\n").catch(() => {});
}
