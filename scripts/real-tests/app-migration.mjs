// Application backup and a move to another data directory with a real Paper server.
// scripts/real-tests/run.sh <port> <data-dir> app-migration.mjs <data-dir> [mcVersion]
// Instance A (run.sh) gets a server with a world; its application backup is imported into a fresh data directory
// that a second instance B (started here, on its own ports) opens: same account, new paths, the game files
// downloaded again, the world and its block still there.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { client } from "./client.mjs";

const [base, dataA, mcVersion = "1.21.4"] = process.argv.slice(2);
if (!dataA) throw new Error("Usage: run.sh <port> <data-dir> app-migration.mjs <data-dir> [mcVersion]");
const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../apps/api/dist");
const freePort = async () => {
  const listener = net.createServer();
  await new Promise((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
  const { port } = listener.address();
  await new Promise((resolve) => listener.close(resolve));
  return port;
};
const evidence = { checks: [], startedAt: new Date().toISOString() };
const record = (check, extra = {}) => { evidence.checks.push({ check, ...extra }); console.log(`PASS ${check} ${JSON.stringify(extra)}`); };

const a = client(base);
const dataB = await fs.mkdtemp(path.join(os.tmpdir(), "cp-moved-"));
const processes = [];
let id;
let b;
try {
  await a.signIn();
  const playerPort = await freePort();
  const created = await a.create({ name: "Moving", software: "paper", mcVersion, memoryMb: 1024, port: playerPort, bindAddress: "127.0.0.1", autoStart: true });
  id = created.id;
  await a.waitInstalled(id);
  await a.call("PUT", `/api/servers/${id}/properties`, { values: { "view-distance": "3", "simulation-distance": "3", motd: "Moved by CraftPanel" } });
  await a.start(id);
  await a.command(id, "forceload add 0 0");
  await a.sleep(500);
  await a.command(id, "setblock 0 100 0 minecraft:gold_block");
  await a.command(id, "save-all flush");
  await a.sleep(3000);
  record("server-with-a-world-on-the-old-host", { id });

  // A live backup: the server keeps running while it is archived.
  await a.call("POST", "/api/app-backups", { includeServers: true });
  const listing = await (async () => {
    for (const end = Date.now() + 5 * 60_000; Date.now() < end; await a.sleep(1000)) {
      const state = await a.call("GET", "/api/app-backups");
      if (state.progress.error) throw new Error(state.progress.error);
      if (!state.progress.running && state.backups.length) return state.backups;
    }
    throw new Error("The application backup did not finish");
  })();
  assert.equal(listing.length, 1);
  assert.deepEqual(listing[0].servers, { total: 1, withFiles: 1 });
  assert.equal((await a.server(id)).status, "running", "The backup stopped the server");
  const archive = path.join(dataA, "backups", "application", listing[0].filename);
  record("application-backup-of-a-running-server", { size: listing[0].size });
  await a.stop(id);

  // The new host: import while nothing runs there.
  const env = { ...process.env, CRAFTPANEL_DATA_DIR: dataB };
  const imported = spawnSync(process.execPath, [path.join(dist, "index.js"), "import-backup", archive], { env, encoding: "utf8" });
  assert.equal(imported.status, 0, imported.stderr || imported.stdout);
  assert.match(imported.stdout, /Restored 1 server\(s\), 1 with their files and worlds/);
  await fs.access(path.join(dataB, "servers", id, "world", "level.dat"));
  assert(!(await fs.readdir(path.join(dataB, "servers", id))).some((n) => n.endsWith(".jar")), "A game jar travelled in the backup");
  const again = spawnSync(process.execPath, [path.join(dist, "index.js"), "import-backup", archive], { env, encoding: "utf8" });
  assert.notEqual(again.status, 0);
  assert.match(again.stderr, /already has an owner account/);
  record("import-into-a-fresh-data-directory", { servers: 1 });

  const portB = await freePort();
  const out = await fs.open(path.join(dataB, "..", `${path.basename(dataB)}.log`), "a");
  const spawnNode = (file, extra) => processes.push(spawn(process.execPath, [path.join(dist, file)], { env: { ...env, ...extra }, stdio: ["ignore", out.fd, out.fd] }));
  spawnNode("runtime.js", {});
  spawnNode("index.js", { CRAFTPANEL_PORT: String(portB), CRAFTPANEL_HOST: "127.0.0.1", CRAFTPANEL_UPDATE_CHECK: "false" });
  b = client(`http://127.0.0.1:${portB}`);
  for (const end = Date.now() + 90_000; ; await b.sleep(500)) {
    if (await fetch(`http://127.0.0.1:${portB}/api/ready`).then((r) => r.ok, () => false)) break;
    if (Date.now() > end) throw new Error("The restored instance did not become ready");
  }
  await b.signIn();
  const moved = await b.server(id);
  assert.equal(moved.directory, path.join(dataB, "servers", id));
  record("old-account-signs-in-and-the-server-is-listed-with-its-new-path", { directory: moved.directory });

  // Game files come back on their own and, because of automatic start, the server runs again.
  const running = await b.waitStatus(id, "running", 15 * 60_000);
  assert.equal((await b.server(id)).installState, "installed");
  assert((await fs.readdir(path.join(dataB, "servers", id))).some((n) => n.endsWith(".jar")), "No game jar was downloaded");
  await b.command(id, "execute if block 0 100 0 minecraft:gold_block run say gold-is-still-there");
  for (const end = Date.now() + 30_000; ; await b.sleep(500)) {
    if (((await b.log(id)) ?? []).some((l) => l.stream !== "command" && l.text.includes("gold-is-still-there"))) break;
    if (Date.now() > end) throw new Error("The block placed on the old host is gone");
  }
  record("game-files-downloaded-again-world-and-block-intact", { pid: running.pid });
  evidence.ok = true;
} catch (error) {
  evidence.error = String(error.message).slice(0, 1000);
  console.error(JSON.stringify(evidence, null, 1));
  throw error;
} finally {
  if (id) {
    await a.call("POST", `/api/servers/${id}/kill`).catch(() => undefined);
    await b?.call("POST", `/api/servers/${id}/kill`).catch(() => undefined);
  }
  for (const p of processes.reverse()) {
    try { p.kill("SIGTERM"); } catch { /* gone */ }
  }
  await new Promise((resolve) => setTimeout(resolve, 8000));
  for (const p of processes) { try { p.kill("SIGKILL"); } catch { /* gone */ } }
  await fs.rm(dataB, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
  await fs.rm(`${dataB}.log`, { force: true }).catch(() => undefined);
}
