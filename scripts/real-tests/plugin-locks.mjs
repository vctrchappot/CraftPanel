// Plugin jars a running server has loaded: on Windows they are locked, so disable, remove and update must fail with a
// clear 409 (not a 500) and leave exactly one copy behind; after a stop, all three work.
//   scripts/real-tests/run.sh <port> <data-dir> plugin-locks.mjs [mc-port]
import { client } from "./client.mjs";

const c = client(process.argv[2] ?? "http://127.0.0.1:8130");
const mcPort = Number(process.argv[3] ?? 25891);
await c.signIn();
const ok = (cond, msg) => {
  console.log(`${cond ? "PASS" : "FAIL"} ${msg}`);
  if (!cond) process.exitCode = 1;
};
const status = (p) => p.then(() => 204, (e) => e.status);
const chunkyJars = async (id) => (await c.call("GET", `/api/servers/${id}/plugins`)).plugins.filter((p) => /chunky/i.test(p.file)).map((p) => p.file);

const s = await c.create({ name: "plugin-locks", software: "paper", mcVersion: "1.21.4", port: mcPort, memoryMb: 1024 });
await c.waitInstalled(s.id);
const versions = await c.call("GET", `/api/servers/${s.id}/plugins/versions/chunky`);
const releases = versions.filter((v) => v.type === "release");
const [latest, older] = [releases[0], releases[1]];
await c.call("POST", `/api/servers/${s.id}/plugins/install`, { projectId: "chunky", versionId: older.id });
const [file] = await chunkyJars(s.id);
console.log(`installed ${file} (latest ${latest.version})`);
await c.start(s.id);

const locked = process.platform === "win32";
const again = await c.call("POST", `/api/servers/${s.id}/plugins/install`, { projectId: "chunky" }).then(() => 200, (e) => e);
ok(again.status === 409 && /already installed/.test(again.body), `reinstall while running → 409 already installed (${again.status})`);
const del = await c.call("DELETE", `/api/servers/${s.id}/plugins/${encodeURIComponent(file)}`).then(() => 204, (e) => e);
ok(locked ? del.status === 409 && /in use by the running server/.test(del.body) : del === 204, `remove while running → ${locked ? "409 in use" : "204"} (${del.status ?? del})`);
if (locked) {
  ok((await status(c.call("PATCH", `/api/servers/${s.id}/plugins/${encodeURIComponent(file)}`, { enabled: false }))) === 409, "disable while running → 409");
  const upd = await status(c.call("POST", `/api/servers/${s.id}/plugins/${encodeURIComponent(file)}/update`, { versionId: latest.id }));
  ok(upd === 409, `update while running → 409 (${upd})`);
  const jars = await chunkyJars(s.id);
  ok(jars.length === 1 && jars[0] === file, `still exactly one jar after the refused update: ${jars.join(", ")}`);

  await c.stop(s.id);
  ok((await status(c.call("POST", `/api/servers/${s.id}/plugins/${encodeURIComponent(file)}/update`, { versionId: latest.id }))) === 204, "update while stopped → 204");
  const after = await chunkyJars(s.id);
  ok(after.length === 1 && after[0] !== file, `one updated jar: ${after.join(", ")}`);
  ok((await status(c.call("DELETE", `/api/servers/${s.id}/plugins/${encodeURIComponent(after[0])}`))) === 204, "remove while stopped → 204");
} else {
  await c.stop(s.id);
}
ok((await chunkyJars(s.id)).length === 0, "no Chunky jar left");
