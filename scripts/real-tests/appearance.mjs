// The server's icon and message of the day are what players see in Minecraft's multiplayer list. This sets both through
// the API on a real server, restarts it, and asks it the way the game does (a server list ping) what it announces:
//   node appearance.mjs <base> <tools-dir> [mcVersion] [mcPort] [software]
import path from "node:path";
import zlib from "node:zlib";
import { createRequire } from "node:module";
import { client } from "./client.mjs";

const [base, toolsDir, mcVersion = "1.21.4", mcPort = "25853", software = "paper"] = process.argv.slice(2);
if (!base || !toolsDir) throw new Error("usage: appearance.mjs <base> <tools-dir> [mcVersion] [mcPort] [software]");
const mc = createRequire(path.join(path.resolve(toolsDir), "package.json"))("minecraft-protocol");
const c = client(base);
await c.signIn();
const ok = (cond, msg) => {
  console.log(`${cond ? "PASS" : "FAIL"} ${msg}`);
  if (!cond) process.exitCode = 1;
};

// A 64×64 PNG with a diagonal gradient, drawn here so the check needs no image files.
function png() {
  const chunk = (type, body) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    const t = Buffer.concat([Buffer.from(type, "latin1"), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(t));
    return Buffer.concat([len, t, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(64, 0);
  ihdr.writeUInt32BE(64, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const raw = Buffer.alloc(64 * (1 + 64 * 4));
  for (let y = 0; y < 64; y++) {
    const row = y * (1 + 64 * 4);
    for (let x = 0; x < 64; x++) raw.set([40 + x * 3, 160 - y, 70 + y * 2, 255], row + 1 + x * 4);
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const flatten = (d) => (typeof d === "string" ? d : (d.text ?? "") + (d.extra ?? []).map(flatten).join(""));
const segments = (d, out = []) => {
  if (typeof d === "string") return out.concat({ text: d });
  if (d.text) out.push({ text: d.text, color: d.color, bold: d.bold });
  for (const e of d.extra ?? []) segments(e, out);
  return out;
};
const ping = () => mc.ping({ host: "127.0.0.1", port: Number(mcPort) });
const restart = async (id) => {
  await c.stop(id);
  await c.start(id);
  await c.sleep(1500);
};

const s = await c.create({ name: "appearance", software, mcVersion, port: Number(mcPort) });
await c.waitInstalled(s.id);
await c.start(s.id);
const summary = async () => (await c.call("GET", "/api/servers")).find((x) => x.id === s.id);

ok((await summary()).iconVersion === null, "a new server has no icon");
const first = await ping();
ok(!first.favicon, "the game announces no icon yet");

const file = png();
await c.call("PUT", `/api/servers/${s.id}/icon`, { png: file.toString("base64") });
const motd = "§6§lWelcome to Appearance\n§7a server with its own look";
await c.call("PUT", `/api/servers/${s.id}/properties`, { values: { motd } });
const after = await summary();
ok(typeof after.iconVersion === "number", `CraftPanel reports the icon (version ${after.iconVersion})`);
ok(after.restartRequired === true, "the dashboard says a restart is needed");
const back = await fetch(`${base}/api/servers/${s.id}/icon`, { headers: { cookie: c.session().cookie } });
ok(back.status === 200 && Buffer.from(await back.arrayBuffer()).equals(file), "the icon comes back byte for byte");

await restart(s.id);
const second = await ping();
const favicon = second.favicon ? Buffer.from(second.favicon.replace(/^data:image\/png;base64,/, ""), "base64") : null;
ok(!!favicon && favicon.subarray(0, 8).equals(file.subarray(0, 8)), "after a restart the game announces a PNG icon");
ok(!!favicon && favicon.readUInt32BE(16) === 64 && favicon.readUInt32BE(20) === 64, "…of 64×64 pixels");
const text = flatten(second.description);
ok(text === "Welcome to Appearance\na server with its own look", `the game announces both lines of the message: ${JSON.stringify(text)}`);
const first1 = segments(second.description).find((x) => x.text.includes("Welcome"));
ok(first1?.color === "gold" && first1?.bold === true, `colour and style arrive: ${JSON.stringify(first1)}`);

await c.call("DELETE", `/api/servers/${s.id}/icon`);
ok((await summary()).iconVersion === null, "removing the icon is reflected in the server list");
await restart(s.id);
ok(!(await ping()).favicon, "after removing it and restarting, the game announces no icon");
await c.stop(s.id).catch(() => {});
