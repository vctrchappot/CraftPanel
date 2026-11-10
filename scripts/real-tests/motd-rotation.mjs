// Rotating server list messages need the CraftPanel plugin: the API writes the messages to a file and installs the plugin,
// and a Paper server answers the server list ping with the next message every few seconds. This sets two messages,
// starts the server, pings it the way the game does and follows the messages through an edit and a removal:
//   node motd-rotation.mjs <base> <tools-dir> [mcVersion] [mcPort] [software]
import path from "node:path";
import { createRequire } from "node:module";
import { client } from "./client.mjs";

const [base, toolsDir, mcVersion = "1.21.4", mcPort = "25855", software = "paper"] = process.argv.slice(2);
if (!base || !toolsDir) throw new Error("usage: motd-rotation.mjs <base> <tools-dir> [mcVersion] [mcPort] [software]");
const mc = createRequire(path.join(path.resolve(toolsDir), "package.json"))("minecraft-protocol");
const c = client(base);
await c.signIn();
const ok = (cond, msg) => {
  console.log(`${cond ? "PASS" : "FAIL"} ${msg}`);
  if (!cond) process.exitCode = 1;
};
const flatten = (d) => (typeof d === "string" ? d : (d.text ?? "") + (d.extra ?? []).map(flatten).join(""));
const segments = (d, out = []) => {
  if (typeof d === "string") return out.concat({ text: d });
  if (d.text) out.push({ text: d.text, color: d.color });
  for (const e of d.extra ?? []) segments(e, out);
  return out;
};
const ping = () => mc.ping({ host: "127.0.0.1", port: Number(mcPort) });
/** Ping every 700 ms for a while and collect what the server announced. */
async function watch(ms) {
  const seen = new Map();
  for (const end = Date.now() + ms; Date.now() < end; await c.sleep(700)) {
    const r = await ping();
    seen.set(flatten(r.description), r.description);
  }
  return seen;
}

const s = await c.create({ name: "rotation", software, mcVersion, port: Number(mcPort) });
await c.waitInstalled(s.id);
const url = `/api/servers/${s.id}/motd-rotation`;

ok((await c.call("GET", url)).frames.length === 0, "a new server has no rotating messages");
await c.call("PUT", `/api/servers/${s.id}/properties`, { values: { motd: "§7The ordinary message\n§7from server.properties" } });
const frames = ["§x§f§f§8§0§0§0§lMoonlight Valley\n§7Survival with friends", "§b§lCome and play\n§7New players are welcome"];
await c.call("PUT", url, { interval: 2, frames });
ok(JSON.stringify((await c.call("GET", url)).frames) === JSON.stringify(frames), "the messages come back as saved");

await c.start(s.id);
await c.sleep(1500);
const first = await watch(9000);
const texts = [...first.keys()];
ok(texts.length === 2 && texts.includes("Moonlight Valley\nSurvival with friends") && texts.includes("Come and play\nNew players are welcome"), `the game rotates through both messages: ${JSON.stringify(texts)}`);
ok(!texts.some((t) => t.includes("ordinary")), "the message of server.properties is replaced while messages rotate");
const moon = segments(first.get("Moonlight Valley\nSurvival with friends")).find((x) => x.text.includes("Moonlight"));
ok(moon?.color === "#ff8000", `a smooth colour survives the plugin: ${JSON.stringify(moon)}`);

// Edits apply without a restart: the plugin reads the file again when it changes.
const edited = ["§aEdited while running\n§7No restart needed"];
await c.call("PUT", url, { interval: 2, frames: edited });
await c.sleep(1200);
const second = await watch(3000);
ok([...second.keys()].length === 1 && [...second.keys()][0] === "Edited while running\nNo restart needed", `an edit shows without a restart: ${JSON.stringify([...second.keys()])}`);

// Removing the messages brings back the one message of server.properties.
await c.call("PUT", url, { interval: 2, frames: [] });
await c.sleep(1200);
const third = await watch(2000);
ok([...third.keys()].length === 1 && [...third.keys()][0] === "The ordinary message\nfrom server.properties", `without messages the game shows server.properties again: ${JSON.stringify([...third.keys()])}`);

await c.stop(s.id).catch(() => {});
