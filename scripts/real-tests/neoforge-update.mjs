// NeoForge in-place update: install an older NeoForge build, switch to the newest one, and check that the
// previous version's library folder is gone and the server still starts.
// usage: node neoforge-update.mjs <base> [mcVersion] [port]
import fs from "node:fs";
import path from "node:path";
import { client } from "./client.mjs";

const [base, mc = "1.21.1", port = "25791"] = process.argv.slice(2);
const c = client(base);
await c.signIn();
const ok = (cond, msg) => {
  console.log(`${cond ? "PASS" : "FAIL"} ${msg}`);
  if (!cond) process.exitCode = 1;
};
const versionDir = (s, v) => path.join(s.directory, "libraries/net/neoforged/neoforge", v);

const { builds } = await c.call("GET", `/api/catalog/neoforge/versions/${mc}`);
const [newest, older] = builds.map((b) => b.id);
console.log("builds:", newest, "<-", older);
const created = await c.create({ name: `nf-update-${mc}`, software: "neoforge", mcVersion: mc, build: older, port: Number(port), memoryMb: 3072 });
let s = await c.waitInstalled(created.id, 20 * 60_000);
ok(s.build === older && fs.existsSync(versionDir(s, older)), `NeoForge ${older} installed`);

const preview = await c.call("GET", `/api/servers/${s.id}/software/preview?software=neoforge&version=${mc}&build=${newest}`);
console.log("preview:", JSON.stringify(preview.notes.map((n) => `[${n.level}] ${n.text}`)));
await c.call("POST", `/api/servers/${s.id}/software`, { software: "neoforge", version: mc, build: newest });
s = await c.waitInstalled(s.id, 20 * 60_000);
ok(s.build === newest, `updated to NeoForge ${newest}`);
ok(!fs.existsSync(versionDir(s, older)), `NeoForge ${older} library folder removed`);
ok(fs.existsSync(versionDir(s, newest)), `NeoForge ${newest} library folder present`);
ok(fs.existsSync(path.join(s.directory, "libraries/net/minecraft")), "shared Minecraft libraries kept");

await c.start(s.id);
const lines = ((await c.log(s.id)) ?? []).map((l) => l.text ?? String(l));
ok(lines.some((l) => /Done \(/.test(l)), "server starts after the update");
await c.stop(s.id);
