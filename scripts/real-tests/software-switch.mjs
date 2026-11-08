// Real software switches: a block placed in Paper's Nether must survive Paper -> Vanilla -> Fabric -> Paper.
import fs from "node:fs";
import path from "node:path";
import { client } from "./client.mjs";

const c = client(process.argv[2] ?? "http://127.0.0.1:8130");
await c.signIn();
const ok = (cond, msg) => {
  console.log(`${cond ? "PASS" : "FAIL"} ${msg}`);
  if (!cond) process.exitCode = 1;
};
const tree = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).filter((f) => f.endsWith(".mca")).sort() : []);
async function lines(id) {
  const h = await c.log(id);
  return (h ?? []).map((l) => (typeof l === "string" ? l : l.text ?? l.line ?? JSON.stringify(l)));
}
async function run(id, command, re, timeoutMs = 20000) {
  const before = (await lines(id)).length;
  await c.command(id, command);
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const all = await lines(id);
    const hit = all.slice(Math.max(0, before - 5)).find((l) => re.test(l));
    if (hit) return hit;
    await c.sleep(500);
  }
  return null;
}
async function checkGold(id, label) {
  await c.start(id);
  await c.sleep(2000);
  await run(id, "execute in minecraft:the_nether run forceload add 0 0", /forceload|Marked|already/i);
  const hit = await run(id, "execute in minecraft:the_nether if block 0 100 0 minecraft:gold_block", /Test (passed|failed)/i);
  ok(/passed/i.test(hit ?? ""), `${label}: gold block in the Nether (${hit})`);
  await c.stop(id);
}
async function switchTo(id, software, version, extra = {}) {
  const p = await c.call("GET", `/api/servers/${id}/software/preview?software=${software}&version=${version}`);
  console.log(`-- preview -> ${software} ${version}:`, JSON.stringify(p.notes.map((n) => `[${n.level}] ${n.text}`), null, 1));
  await c.call("POST", `/api/servers/${id}/software`, { software, version, ...extra });
  return p;
}

const s = await c.create({ name: "switch-test", software: "paper", mcVersion: "1.21.11", port: 25790 });
await c.waitInstalled(s.id);
await c.start(s.id);
await c.sleep(2000);
await run(s.id, "execute in minecraft:the_nether run forceload add 0 0", /forceload|Marked/i);
const set = await run(s.id, "execute in minecraft:the_nether run setblock 0 100 0 minecraft:gold_block", /Changed the block|Could not set/i);
console.log("setblock:", set);
await run(s.id, "save-all flush", /Saved the game/i, 60000);
await c.stop(s.id);
const netherPaper = tree(path.join(s.directory, "world_nether/DIM-1"));
ok(netherPaper.length > 0, `Paper wrote Nether regions to world_nether/DIM-1 (${netherPaper.length})`);

// Paper -> Vanilla
const p1 = await switchTo(s.id, "vanilla", "1.21.11");
ok(p1.notes.some((n) => /Nether.*world_nether\/DIM-1.*world\/DIM-1/.test(n.text)), "preview announces the Nether move");
ok(tree(path.join(s.directory, "world/DIM-1")).join() === netherPaper.join(), "Nether regions now in world/DIM-1");
ok(!fs.existsSync(path.join(s.directory, "world_nether")), "world_nether removed");
await checkGold(s.id, "Vanilla 1.21.11");
const worlds = await c.call("GET", `/api/servers/${s.id}/worlds`);
console.log("worlds:", JSON.stringify(worlds.map((w) => [w.name, w.dimensions])));

// Downgrade guard
try {
  await c.call("POST", `/api/servers/${s.id}/software`, { software: "vanilla", version: "1.21.4" });
  ok(false, "downgrade without confirmation is refused");
} catch (e) {
  ok(e.status === 409 && /downgrade/.test(e.body), `downgrade without confirmation is refused (${e.status})`);
}
const pd = await c.call("GET", `/api/servers/${s.id}/software/preview?software=vanilla&version=1.21.4`);
ok(pd.downgrade && pd.notes.some((n) => n.level === "danger"), "preview flags the downgrade");

// Vanilla -> Fabric -> Paper
await switchTo(s.id, "fabric", "1.21.11");
await checkGold(s.id, "Fabric 1.21.11");
await switchTo(s.id, "paper", "1.21.11");
await checkGold(s.id, "Paper 1.21.11 again");
ok(tree(path.join(s.directory, "world_nether/DIM-1")).length > 0, "Paper converted the Nether back into world_nether");

// Same software, other build
const builds = await c.call("GET", `/api/catalog/paper/versions/1.21.11`);
const currentBuild = (await c.server(s.id)).build;
const older = builds.builds.find((b) => b.id !== currentBuild);
if (older) {
  await switchTo(s.id, "paper", "1.21.11", { build: older.id });
  ok((await c.server(s.id)).build === older.id, `build changed to #${older.id}`);
}
const acts = await c.call("GET", `/api/activity?serverId=${s.id}&limit=50`).catch(() => null);
console.log("activity:", JSON.stringify((acts?.items ?? acts ?? []).filter?.((a) => /dimension|software/.test(a.type)).map((a) => a.message)));
const backups = await c.call("GET", `/api/backups?serverId=${s.id}`);
console.log("backups:", (backups.items ?? backups).length);
