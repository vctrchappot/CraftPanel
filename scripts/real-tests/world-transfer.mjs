// World import and export on a real Paper server: export while running, import that archive back under a new name
// with its Nether and End, activate it and boot from it; archives that hold no world, several worlds or a taken name
// are refused without leaving anything behind.
// usage: node world-transfer.mjs <base> [mcVersion] [mcPort]
import zlib from "node:zlib";
import { client } from "./client.mjs";

const [base = "http://127.0.0.1:8231", mcVersion = "1.21.11", port = "25831"] = process.argv.slice(2);
const c = client(base);
await c.signIn();
const ok = (cond, msg) => {
  console.log(`${cond ? "PASS" : "FAIL"} ${msg}`);
  if (!cond) process.exitCode = 1;
};

/** A zip of stored (uncompressed) entries: enough for the archives these checks need. */
function storedZip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBuf = Buffer.from(name);
    const data = Buffer.from(text);
    const crc = zlib.crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBuf.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBuf);
    parts.push(local, nameBuf, data);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

const { cookie, csrf } = c.session();
async function importWorld(id, zip, name, activate) {
  const fd = new FormData();
  fd.append("file", new Blob([zip]), "world.zip");
  const r = await fetch(`${base}/api/servers/${id}/worlds/import?name=${encodeURIComponent(name)}&activate=${activate}`, { method: "POST", body: fd, headers: { cookie, "x-csrf-token": csrf } });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
}

const s = await c.create({ name: "world-transfer", software: "paper", mcVersion, port: Number(port), memoryMb: 2048 });
await c.waitInstalled(s.id);
await c.start(s.id);

const worlds = () => c.call("GET", `/api/servers/${s.id}/worlds`);
// A fresh world only gets its level.dat with the first save.
await c.command(s.id, "save-all flush");
let before = await worlds();
for (let i = 0; i < 20 && !before.every((w) => w.modifiedAt > 0 && w.dimensions.length > 2); i++) {
  await c.sleep(1500);
  before = await worlds();
}
const original = before.find((w) => w.active);
console.log("worlds after first start:", JSON.stringify(before));
ok(original?.name === "world" && original.dimensions.includes("nether") && original.dimensions.includes("the_end"), `Paper generated "world" with ${original?.dimensions.join(", ")}`);

// Export while the server runs.
const exp = await fetch(`${base}/api/servers/${s.id}/worlds/world/export`, { headers: { cookie } });
const archive = Buffer.from(await exp.arrayBuffer());
const disposition = exp.headers.get("content-disposition") ?? "";
ok(exp.status === 200 && archive.length > 1000 && archive.subarray(0, 2).toString() === "PK", `export of the running world is a ${(archive.length / 1e6).toFixed(1)} MB zip`);
ok(/filename="world-\d{4}-\d{2}-\d{2}\.zip"/.test(disposition), `download is named with the date (${disposition})`);

// Import it back as a new world: all three folders arrive, the new world becomes the active one.
const imported = await importWorld(s.id, archive, "Copy", true);
ok(imported.status === 200 && imported.body?.name === "Copy" && imported.body.activated, `imported as "Copy": ${JSON.stringify(imported.body)}`);
const after = await worlds();
const copy = after.find((w) => w.name === "Copy");
ok(copy?.active && copy.dimensions.join() === original.dimensions.join(), `"Copy" is active with ${copy?.dimensions.join(", ")}`);
ok(!after.find((w) => w.name === "world")?.active, 'the original "world" is no longer active');

// Refused archives leave nothing behind.
const taken = await importWorld(s.id, archive, "copy", false);
ok(taken.status === 409 && /already exists/.test(taken.body?.error?.message ?? ""), `a taken name (any case) is refused: ${taken.body?.error?.message}`);
const empty = await importWorld(s.id, storedZip({ "readme.txt": "hi", "plugins/a.jar": "x" }), "Junk", false);
ok(empty.status === 400 && /level\.dat/.test(empty.body?.error?.message ?? ""), `an archive without a world is refused: ${empty.body?.error?.message}`);
const several = await importWorld(s.id, storedZip({ "one/level.dat": "a", "two/level.dat": "b" }), "Several", false);
ok(several.status === 400 && /several worlds/.test(several.body?.error?.message ?? ""), `an archive with several worlds is refused: ${several.body?.error?.message}`);
ok((await worlds()).length === after.length, "no folder was left behind by the refused imports");

// A hand-made archive with the world one folder down, as a singleplayer save is zipped.
const wrapped = await importWorld(s.id, storedZip({ "My Save/level.dat": "nbt", "My Save/region/r.0.0.mca": "region" }), "Save", false);
ok(wrapped.status === 200 && wrapped.body.dimensions.join() === "overworld", "a world inside one wrapper folder is found");

// The server boots from the imported world.
await c.call("POST", `/api/servers/${s.id}/restart`);
await c.sleep(4000);
await c.waitStatus(s.id, "running");
const props = (await c.call("GET", `/api/servers/${s.id}/properties`)).values;
ok(props["level-name"] === "Copy", `level-name is "${props["level-name"]}" after the restart`);
const log = JSON.stringify(await c.log(s.id));
ok(/Preparing level \\?"Copy\\?"/.test(log), 'the server log says it prepared level "Copy"');
if (!process.env.KEEP_RUNNING) await c.stop(s.id);
