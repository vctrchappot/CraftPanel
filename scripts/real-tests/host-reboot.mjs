// Graceful host shutdown/boot acceptance against an isolated installed Linux service.
// Run on a DISPOSABLE systemd host only; the host is powered off between the two phases.
// node host-reboot.mjs prepare FIXTURES craftpanel-ops-NAME PORT TOOLS_DIR [JAVA_PATH]
// (power the host off with `systemctl poweroff` and boot it again)
// node host-reboot.mjs verify  FIXTURES craftpanel-ops-NAME PORT TOOLS_DIR
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import zlib from "node:zlib";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { client } from "./client.mjs";

const run = promisify(execFile);
const [phase, fixturesArg, instance, portArg, toolsDir, javaPath] = process.argv.slice(2);
if (process.platform !== "linux" || process.getuid() !== 0 || !["prepare", "verify"].includes(phase) || !/^craftpanel-ops-[a-z0-9-]+$/.test(instance ?? "") || !toolsDir)
  throw new Error("Use Linux/root: host-reboot.mjs prepare|verify FIXTURES craftpanel-ops-NAME PORT TOOLS_DIR [JAVA_PATH]");
const fixtures = path.resolve(fixturesArg);
const port = Number(portArg);
assert(Number.isInteger(port) && port >= 1024 && port <= 65535);
const data = `/var/lib/${instance}`;
const installer = path.join(fixtures, "install.sh");
const stateFile = path.join(fixtures, "host-reboot-state.json");
const evidenceFile = path.join(fixtures, "host-reboot-evidence.json");
const c = client(`http://127.0.0.1:${port}`);
const credentials = ["reboot-owner", "throwaway-reboot-acceptance-1"];
const wait = async (fn, timeout = 90_000) => {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { const value = await fn(); if (value) return value; } catch (error) { last = error; }
    await c.sleep(250);
  }
  throw last ?? new Error("Acceptance condition timed out");
};
const ready = () => wait(async () => (await fetch(`http://127.0.0.1:${port}/api/ready`)).ok, 180_000);
const unitPid = async (unit) => (await run("systemctl", ["show", unit, "-p", "MainPID", "--value"])).stdout.trim();
// WSL distros share the VM kernel, so boot_id does not change; PID 1's start time marks a new systemd boot.
const bootMarker = async () => (await run("ps", ["-o", "lstart=", "-p", "1"])).stdout.trim();
const mineflayer = createRequire(path.join(path.resolve(toolsDir), "package.json"))("mineflayer");
const connectPlayer = async (playerPort, id) => {
  const bot = mineflayer.createBot({ host: "127.0.0.1", port: playerPort, username: "RebootBot", auth: "offline", version: "1.21.4" });
  bot.on("error", () => {});
  await wait(() => bot.entity && bot.health !== undefined, 90_000);
  await wait(async () => (await c.server(id)).players.some((player) => player.name === "RebootBot"));
  return bot;
};
const blockExists = async (id, x, block) => {
  const marker = `host-reboot-${block}-${Date.now()}`;
  await c.command(id, `execute if block ${x} 100 0 minecraft:${block} run say ${marker}`);
  return wait(async () => (await c.log(id)).some((line) => line.stream !== "command" && line.text.includes(marker)), 10_000);
};

if (phase === "prepare") {
  await assert.rejects(fs.access(data), { code: "ENOENT" });
  await assert.rejects(fs.access(stateFile), { code: "ENOENT" });
  const free = async () => {
    const listener = net.createServer();
    await new Promise((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
    const { port: value } = listener.address();
    await new Promise((resolve) => listener.close(resolve));
    return value;
  };
  const result = await run("bash", [installer, "--archive", path.join(fixtures, "craftpanel-v99.0.0.tar.gz"), "--port", String(port)], { timeout: 180_000, maxBuffer: 2 * 1024 * 1024 });
  await fs.writeFile(path.join(fixtures, "host-reboot-install.log"), result.stdout + result.stderr);
  await ready();
  let isolatedJava;
  if (javaPath) {
    const target = path.join(data, "runtimes", "java", "acceptance-jdk");
    await fs.cp(path.dirname(path.dirname(path.resolve(javaPath))), target, { recursive: true });
    await run("chown", ["-R", `${instance}:${instance}`, target]);
    isolatedJava = path.join(target, "bin", "java");
  }
  const setupToken = (await fs.readFile(path.join(data, "setup-token.txt"), "utf8")).trim();
  const response = await fetch(`http://127.0.0.1:${port}/api/auth/setup`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: credentials[0], password: credentials[1], setupToken }),
  });
  assert(response.ok, `Setup failed: ${response.status} ${await response.text()}`);
  await c.signIn(...credentials);
  const servers = {};
  for (const [key, autoStart] of [["autostart", true], ["manual", false]]) {
    const playerPort = await free();
    const server = await c.create({ name: `Reboot ${key}`, software: "paper", mcVersion: "1.21.4", memoryMb: 1024,
      port: playerPort, bindAddress: "127.0.0.1", autoStart, ...(isolatedJava ? { javaPath: isolatedJava } : {}) });
    await c.waitInstalled(server.id);
    await c.call("PUT", `/api/servers/${server.id}/properties`, { values: { "view-distance": "3", "simulation-distance": "3", "spawn-protection": "0" } });
    const started = await c.start(server.id);
    servers[key] = { id: server.id, playerPort, javaPid: started.pid, directory: started.directory };
  }
  const { id, playerPort } = servers.autostart;
  const bot = await connectPlayer(playerPort, id);
  await c.command(id, "forceload add 0 0");
  await c.sleep(500);
  // Gold is flushed explicitly; diamond is only persisted by the graceful stop during host shutdown.
  await c.command(id, "setblock 0 100 0 minecraft:gold_block");
  await c.command(id, "save-all flush");
  await wait(async () => (await c.log(id)).some((line) => /Saved the (game|world)/.test(line.text)), 30_000);
  await c.command(id, "setblock 1 100 0 minecraft:diamond_block");
  await blockExists(id, 1, "diamond_block");
  bot.end();
  const state = { instance, servers, bootMarker: await bootMarker(), runtimePid: await unitPid(`${instance}-runtime`),
    dashboardPid: await unitPid(instance), preparedAt: new Date().toISOString() };
  await fs.writeFile(stateFile, JSON.stringify(state, null, 2) + "\n");
  console.log(`PREPARED ${JSON.stringify(state)}`);
} else {
  const state = JSON.parse(await fs.readFile(stateFile, "utf8"));
  const evidence = { instance, scenarios: [], startedAt: new Date().toISOString(), prepared: state };
  const record = (scenario, extra = {}) => { evidence.scenarios.push({ scenario, ...extra }); console.log(`PASS ${scenario} ${JSON.stringify(extra)}`); };
  let bot;
  try {
    const marker = await bootMarker();
    assert.notEqual(marker, state.bootMarker, "systemd was not restarted; this is not a new boot");
    record("new-systemd-boot", { before: state.bootMarker, after: marker });

    // The runtime unit must have stopped by itself, not by systemd's stop timeout. Journal boot IDs follow the
    // kernel and do not change between WSL distro boots, so read everything since preparation instead of `-b -1`.
    const journal = (await run("journalctl", ["--since", `@${Math.floor(Date.parse(state.preparedAt) / 1000)}`, "-u", `${instance}-runtime`, "-o", "cat", "--no-pager"], { maxBuffer: 8 * 1024 * 1024 })).stdout;
    assert.match(journal, /Stopped|Deactivated successfully/, "Previous boot has no runtime stop record");
    assert.doesNotMatch(journal, /State 'stop-sigterm' timed out|Killing process .* with signal SIGKILL/, "Runtime stop needed SIGKILL");
    record("runtime-stopped-gracefully-at-shutdown");
    for (const [key, server] of Object.entries(state.servers)) {
      // A server started at boot has rotated the previous log; one without auto-start still has it as latest.log.
      const logs = (await fs.readdir(path.join(server.directory, "logs"))).filter((name) => name.endsWith(".log.gz")).sort();
      const previous = key === "manual"
        ? await fs.readFile(path.join(server.directory, "logs", "latest.log"), "utf8")
        : zlib.gunzipSync(await fs.readFile(path.join(server.directory, "logs", logs.at(-1) ?? assert.fail(`${key}: no rotated log`)))).toString("utf8");
      assert.match(previous, /Stopping server/, `${key}: previous log has no graceful stop`);
      assert.match(previous, /All dimensions are saved|Saving worlds/, `${key}: previous log has no world save`);
    }
    record("minecraft-saved-and-stopped-at-shutdown", { servers: Object.keys(state.servers) });

    await ready();
    assert.equal(await run("systemctl", ["is-enabled", instance, `${instance}-runtime`]).then((r) => r.stdout.trim().split("\n").every((v) => v === "enabled")), true);
    await c.signIn(...credentials);
    const autostart = await c.waitStatus(state.servers.autostart.id, "running");
    assert.notEqual(autostart.pid, state.servers.autostart.javaPid);
    const manual = await c.server(state.servers.manual.id);
    assert.equal(manual.status, "stopped", "Server without auto-start was started at boot");
    record("services-and-autostart-server-return-after-boot", { runtimePid: await unitPid(`${instance}-runtime`), javaPid: autostart.pid, manualStatus: manual.status });

    const { id, playerPort } = state.servers.autostart;
    bot = await connectPlayer(playerPort, id);
    await blockExists(id, 0, "gold_block");
    await blockExists(id, 1, "diamond_block");
    record("world-changes-survive-host-reboot", { flushed: "gold_block", savedByShutdown: "diamond_block", playerConnected: true });
    evidence.ok = true;
  } catch (error) {
    evidence.error = String(error.message).slice(0, 1000);
    throw error;
  } finally {
    bot?.end();
    evidence.finishedAt = new Date().toISOString();
    try { await run("bash", [installer, "--uninstall"], { timeout: 150_000 }); }
    catch (error) { evidence.ok = false; evidence.cleanupError = error.message.slice(0, 1000); }
    await fs.writeFile(evidenceFile, JSON.stringify(evidence, null, 2) + "\n").catch((error) => console.error("Could not write acceptance evidence:", error.code));
  }
}
