// Real Paper + player acceptance against an isolated installed Linux service.
// node runtime-continuity.mjs FIXTURES craftpanel-ops-NAME PORT TOOLS_DIR [JAVA_PATH]
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { client } from "./client.mjs";

const run = promisify(execFile);
const [fixturesArg, instance, portArg, toolsDir, javaPath] = process.argv.slice(2);
if (process.platform !== "linux" || process.getuid() !== 0 || !/^craftpanel-ops-[a-z0-9-]+$/.test(instance ?? "") || !toolsDir)
  throw new Error("Use Linux/root: runtime-continuity.mjs FIXTURES craftpanel-ops-NAME PORT TOOLS_DIR [JAVA_PATH]");
const fixtures = path.resolve(fixturesArg);
const fixtureManifest = JSON.parse(await fs.readFile(path.join(fixtures, "fixtures.json"), "utf8"));
// Fixtures generated on Windows are consumed by this Linux harness; derive paths locally.
const legacy = fixtureManifest.legacy ? { installer: path.join(fixtures, "legacy-install.sh"), archive: path.join(fixtures, "craftpanel-v97.0.0.tar.gz") } : null;
const port = Number(portArg);
assert(Number.isInteger(port) && port >= 1024 && port <= 65535);
const data = `/var/lib/${instance}`;
const app = `/opt/${instance}`;
const installer = path.join(fixtures, "install.sh");
const archive = (version) => path.join(fixtures, `craftpanel-v${version}.tar.gz`);
const c = client(`http://127.0.0.1:${port}`);
const original = (await run("systemctl", ["show", "craftpanel", "-p", "MainPID", "--value"])).stdout.trim();
const absent = async (file) => { await assert.rejects(fs.access(file), { code: "ENOENT" }); };
await absent(app);
await absent(data);
await absent(`/etc/systemd/system/${instance}.service`);
const evidence = { instance, scenarios: [], startedAt: new Date().toISOString() };
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
const ready = () => wait(async () => (await fetch(`http://127.0.0.1:${port}/api/ready`)).ok);
const install = async (version, succeeds = true, flags = [], expectedFailure, legacyInstall = false) => {
  const env = { ...process.env };
  if (flags.includes("--from-dashboard")) {
    // Dashboard updates intentionally ignore archive arguments. Offer exactly one checked local release.
    const releaseDir = path.join(fixtures, "dashboard-releases", version);
    await fs.mkdir(releaseDir, { recursive: true });
    const name = path.basename(archive(version));
    await fs.copyFile(archive(version), path.join(releaseDir, name));
    const sha = crypto.createHash("sha256").update(await fs.readFile(archive(version))).digest("hex");
    await fs.writeFile(path.join(releaseDir, "SHA256SUMS"), `${sha}  ${name}\n`);
    env.CRAFTPANEL_RELEASE_DIR = releaseDir;
  }
  try {
    const result = await run("bash", [legacyInstall ? legacy.installer : installer, "--archive", legacyInstall ? legacy.archive : archive(version), "--port", String(port), ...flags], { env, timeout: 180_000, maxBuffer: 2 * 1024 * 1024 });
    await fs.writeFile(path.join(fixtures, `continuity-${version}.log`), result.stdout + result.stderr);
    assert(succeeds, `Broken ${version} unexpectedly installed`);
  } catch (error) {
    await fs.writeFile(path.join(fixtures, `continuity-${version}.log`), String(error.stdout ?? "") + String(error.stderr ?? error.message));
    if (succeeds || error.killed || !Number.isInteger(error.code)) throw error;
    if (expectedFailure) assert.match(String(error.stdout) + String(error.stderr), expectedFailure);
  }
};
let bot;
let disconnected = null;
let id;
let playerPort;
try {
  const listener = net.createServer();
  await new Promise((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
  playerPort = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  await install(legacy ? "97.0.0" : "99.0.0", true, [], undefined, !!legacy);
  await ready();
  let isolatedJava;
  if (javaPath) {
    // Reuse an already downloaded JDK read-only; give this test its own copy and ownership.
    const javaRoot = path.dirname(path.dirname(path.resolve(javaPath)));
    const target = path.join(data, "runtimes", "java", "acceptance-jdk");
    await fs.cp(javaRoot, target, { recursive: true });
    await run("chown", ["-R", `${instance}:${instance}`, target]);
    isolatedJava = path.join(target, "bin", "java");
  }
  // The installer uses a LAN profile: finish setup with this isolated instance's token.
  const setupToken = (await fs.readFile(path.join(data, "setup-token.txt"), "utf8")).trim();
  const response = await fetch(`http://127.0.0.1:${port}/api/auth/setup`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "runtime-owner", password: "throwaway-runtime-acceptance-1", setupToken }),
  });
  assert(response.ok, `Setup failed: ${response.status} ${await response.text()}`);
  await c.signIn("runtime-owner", "throwaway-runtime-acceptance-1");
  const server = await c.create({ name: "Runtime acceptance", software: "paper", mcVersion: "1.21.4", memoryMb: 1024,
    port: playerPort, bindAddress: "127.0.0.1", autoStart: true, ...(isolatedJava ? { javaPath: isolatedJava } : {}) });
  id = server.id;
  await c.waitInstalled(id);
  await c.call("PUT", `/api/servers/${id}/properties`, { values: { "view-distance": "3", "simulation-distance": "3", "spawn-protection": "0" } });
  await c.start(id);
  let javaPid = (await c.server(id)).pid;
  let runtimePid = legacy ? null : (await run("systemctl", ["show", `${instance}-runtime`, "-p", "MainPID", "--value"])).stdout.trim();
  const mineflayer = createRequire(path.join(path.resolve(toolsDir), "package.json"))("mineflayer");
  const connectPlayer = async () => {
    disconnected = null;
    const active = mineflayer.createBot({ host: "127.0.0.1", port: playerPort, username: "RuntimeBot", auth: "offline", version: "1.21.4" });
    bot = active;
    active.on("end", (reason) => { if (bot === active) disconnected ??= String(reason); });
    active.on("error", (error) => { if (bot === active) disconnected ??= error.message; });
    active.on("kicked", (reason) => { if (bot === active) disconnected ??= JSON.stringify(reason); });
    await wait(() => active.entity && active.health !== undefined, 90_000);
    await wait(async () => (await c.server(id)).players.some((player) => player.name === "RuntimeBot"));
  };
  await connectPlayer();
  record("real-player-connected", { javaPid, runtimePid, playerPort });

  const sentinel = "runtime-world-preserved";
  const verifyWorld = async () => {
    await c.waitStatus(id, "running");
    await c.command(id, `execute if block 0 100 0 minecraft:gold_block run say ${sentinel}`);
    await wait(async () => (await c.log(id)).some((line) => line.stream !== "command" && line.text.includes(sentinel)), 10_000);
  };

  if (legacy) {
    await install("99.0.0", false, [], /changes the Minecraft runtime/);
    assert.equal((await c.server(id)).pid, javaPid);
    assert.equal(disconnected, null);
    record("legacy-migration-refused-without-maintenance-approval");
    const directory = (await c.server(id)).directory;
    const custom = path.join(directory, "acceptance-config.yml");
    await fs.writeFile(custom, "preserve: legacy configuration\n");
    const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
    const customHash = hash(await fs.readFile(custom));
    const propertiesHash = async () => hash((await fs.readFile(path.join(directory, "server.properties"), "utf8")).split(/\r?\n/).filter((line) => line && !line.startsWith("#")).sort().join("\n"));
    const propertiesBefore = await propertiesHash();
    await c.command(id, "forceload add 0 0");
    await c.sleep(500);
    await c.command(id, "setblock 0 100 0 minecraft:gold_block");
    await c.command(id, "save-all flush");
    bot.end(); bot = null;
    await install("99.0.1", false, ["--allow-runtime-restart"]);
    await ready();
    await verifyWorld();
    await absent(`/etc/systemd/system/${instance}-runtime.service`);
    assert.equal(hash(await fs.readFile(custom)), customHash);
    assert.equal(await propertiesHash(), propertiesBefore);
    record("failed-legacy-migration-restores-embedded-runtime-and-world", { customHash, propertiesHash: propertiesBefore });
    await install("99.0.0", true, ["--allow-runtime-restart"]);
    await ready();
    await verifyWorld();
    assert.equal(hash(await fs.readFile(custom)), customHash);
    assert.equal(await propertiesHash(), propertiesBefore);
    const migrated = await c.server(id);
    assert.notEqual(migrated.pid, javaPid);
    javaPid = migrated.pid;
    runtimePid = (await run("systemctl", ["show", `${instance}-runtime`, "-p", "MainPID", "--value"])).stdout.trim();
    await connectPlayer();
    record("legacy-migration-preserves-world-and-configuration", { javaPid, runtimePid, customHash, propertiesHash: propertiesBefore });
  }

  let marker = 0;
  const continuity = async (scenario) => {
    await ready();
    assert.equal(disconnected, null, `Player disconnected: ${disconnected}`);
    const current = await c.server(id);
    assert.equal(current.pid, javaPid, "Java PID changed");
    assert.equal(current.status, "running");
    assert(current.players.some((player) => player.name === "RuntimeBot"));
    assert.equal((await run("systemctl", ["show", `${instance}-runtime`, "-p", "MainPID", "--value"])).stdout.trim(), runtimePid);
    const text = `runtime-continuity-${++marker}`;
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

  await run("systemctl", ["restart", instance]);
  await continuity("dashboard-service-restart");
  await run("systemctl", ["kill", "--kill-whom=main", "--signal=SIGKILL", instance]);
  await continuity("dashboard-abrupt-crash-and-recovery");
  await install("99.0.0");
  await continuity("dashboard-only-successful-update");
  await install("99.0.1", false);
  await continuity("failed-migration-dashboard-rollback");
  await install("99.0.2", false);
  await continuity("invalid-dashboard-unit-rollback");
  const replay = await c.log(id);
  assert(replay.some((line) => line.text.includes("runtime-continuity-1")), "Earlier console history was not replayed");
  record("console-history-survives-dashboard-replacements");

  // Approval is bound to a runtime fingerprint and a short expiry, before stopping anything.
  await install("99.0.4", false, [], /changes the Minecraft runtime/);
  await continuity("changed-runtime-refused-without-approval");
  const manifestIn = async (version) => JSON.parse((await run("tar", ["-xOf", archive(version), `craftpanel-v${version}/release.json`])).stdout);
  const targetRuntime = (await manifestIn("99.0.4")).runtime.sha256;
  const approvalFile = path.join(data, "runtime", "update-approval.json");
  await fs.writeFile(approvalFile, JSON.stringify({ sha256: targetRuntime, expiresAt: Date.now() - 1 }), { mode: 0o600 });
  await install("99.0.4", false, ["--from-dashboard"], /changes the Minecraft runtime/);
  await continuity("expired-runtime-approval-refused");
  await fs.writeFile(approvalFile, JSON.stringify({ sha256: targetRuntime, expiresAt: Date.now() + 60_000 }));
  await install("99.0.5", false, ["--from-dashboard"], /changes the Minecraft runtime/);
  await continuity("approval-for-another-runtime-refused");
  await fs.rm(approvalFile, { force: true });

  // A world sentinel must survive a failed changed-runtime update and subsequent valid update.
  await c.command(id, "forceload add 0 0");
  await c.sleep(500);
  await c.command(id, "setblock 0 100 0 minecraft:gold_block");
  await c.command(id, "save-all flush");
  await wait(async () => (await c.log(id)).some((line) => /Saved the (game|world)/.test(line.text)), 30_000);
  bot.end();
  bot = null;
  await install("99.0.5", false, ["--allow-runtime-restart"]);
  await ready();
  await verifyWorld();
  const restoredRuntime = (await run("systemctl", ["show", `${instance}-runtime`, "-p", "MainPID", "--value"])).stdout.trim();
  assert.notEqual(restoredRuntime, runtimePid);
  record("changed-runtime-failed-migration-rollback-preserves-world", { runtimePid: restoredRuntime });
  await install("99.0.4", true, ["--allow-runtime-restart"]);
  await ready();
  await verifyWorld();
  record("approved-runtime-update-preserves-world-and-autostarts");

  // A service restart exercises the actual graceful shutdown + registry boot path.
  // This is deliberately recorded separately from a host reboot.
  const beforeRuntimeRestart = (await c.server(id)).pid;
  await run("systemctl", ["stop", instance]);
  await run("systemctl", ["restart", `${instance}-runtime`], { timeout: 150_000 });
  await run("systemctl", ["start", instance]);
  await ready();
  const rebooted = await c.waitStatus(id, "running");
  assert.notEqual(rebooted.pid, beforeRuntimeRestart);
  record("graceful-runtime-service-restart-and-autostart", { previousJavaPid: beforeRuntimeRestart, javaPid: rebooted.pid });
  evidence.ok = true;
} catch (error) {
  evidence.error = String(error.message).slice(0, 1000);
  throw error;
} finally {
  bot?.end();
  evidence.finishedAt = new Date().toISOString();
  // Remove services even after a partially completed installation, preserving diagnostic logs above.
  let cleanupError;
  try { await run("bash", [installer, "--uninstall"], { timeout: 150_000 }); }
  catch (error) { cleanupError = error; evidence.ok = false; evidence.cleanupError = error.message.slice(0, 1000); }
  evidence.originalServiceUnchanged = (await run("systemctl", ["show", "craftpanel", "-p", "MainPID", "--value"])).stdout.trim() === original;
  if (!evidence.originalServiceUnchanged) evidence.ok = false;
  await fs.writeFile(path.join(fixtures, "runtime-continuity-evidence.json"), JSON.stringify(evidence, null, 2) + "\n").catch((error) => console.error("Could not write acceptance evidence:", error.code));
  if (cleanupError) throw cleanupError;
  assert(evidence.originalServiceUnchanged, "Existing CraftPanel service changed");
}
