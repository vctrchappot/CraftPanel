// Rules against a real server (Paper by default): a "freeze when empty" rule that thaws when a player joins, and a "sleep when empty"
// rule that stops the server, answers the server list on its port and wakes the server when a player tries to join:
//   node rules.mjs <base> <tools-dir> [mcVersion] [mcPort] [software]
// <tools-dir> holds minecraft-protocol and mineflayer. The rules wait a minute and CraftPanel looks every 15 seconds, so
// this takes about five minutes.
import path from "node:path";
import { createRequire } from "node:module";
import { client } from "./client.mjs";

const [base, toolsDir, mcVersion = "1.21.4", mcPort = "25865", software = "paper"] = process.argv.slice(2);
if (!base || !toolsDir) throw new Error("usage: rules.mjs <base> <tools-dir> [mcVersion] [mcPort] [software]");
const req = createRequire(path.join(path.resolve(toolsDir), "package.json"));
const mc = req("minecraft-protocol");
const mineflayer = req("mineflayer");
const c = client(base);
await c.signIn();
const ok = (cond, msg) => {
  console.log(`${cond ? "PASS" : "FAIL"} ${msg}`);
  if (!cond) process.exitCode = 1;
};
const flatten = (d) => (typeof d === "string" ? d : (d.text ?? "") + (d.extra ?? []).map(flatten).join(""));
const ping = () => mc.ping({ host: "127.0.0.1", port: Number(mcPort) });
const text = async (id) => (await c.log(id))?.map((l) => l.text).join("\n") ?? "";
async function until(what, fn, timeoutMs = 180_000) {
  for (const end = Date.now() + timeoutMs; Date.now() < end; await c.sleep(2000)) if (await fn()) return true;
  console.log(`timeout: ${what}`);
  return false;
}

const s = await c.create({ name: "rules", software, mcVersion, port: Number(mcPort) });
await c.waitInstalled(s.id);
const rules = `/api/servers/${s.id}/rules`;
const list = () => c.call("GET", rules);
await c.start(s.id);

// ---- freeze while empty, thaw on join -------------------------------------------------------------------------
const freeze = await c.call("POST", rules, { name: "Freeze", enabled: true, when: { kind: "empty" }, forMinutes: 1, onlyIfEmpty: false, then: { kind: "command", command: "tick freeze", undoCommand: "tick unfreeze" } });
ok((await list()).length === 1, "the rule is stored");
ok(await until("the freeze rule fires", async () => (await list())[0].active), "after a quiet minute the freeze rule is in effect");
await c.sleep(1500);
const frozen = await text(s.id);
ok(/frozen/i.test(frozen), "the game confirms that it is frozen");
console.log("  " + (frozen.split("\n").filter((l) => /frozen|tick/i.test(l)).pop() ?? ""));

const bot = mineflayer.createBot({ host: "127.0.0.1", port: Number(mcPort), username: "RuleBot", auth: "offline", version: mcVersion });
await new Promise((resolve, reject) => {
  bot.once("spawn", resolve);
  bot.once("error", reject);
  bot.once("kicked", (r) => reject(new Error(String(r))));
});
ok(await until("the freeze rule lets go", async () => !(await list())[0].active, 60_000), "a player joining ends the rule's effect");
await c.sleep(1500);
const thawed = await text(s.id);
ok(/unfrozen|running normally|no longer frozen|unfreeze/i.test(thawed.slice(thawed.lastIndexOf("frozen"))) || (await c.call("GET", `/api/servers/${s.id}/overview`)).events.some((e) => e.kind === "rule.released"), "the game is thawed again");
bot.end();
await c.sleep(2500);
await c.call("DELETE", `${rules}/${freeze.id}`);

// ---- sleep when empty, wake on join ----------------------------------------------------------------------------
await c.call("POST", rules, { name: "Sleep", enabled: true, when: { kind: "empty" }, forMinutes: 1, onlyIfEmpty: false, then: { kind: "stop", warnSeconds: 0, wake: true } });
ok(await until("the server stops", async () => (await c.server(s.id)).status === "stopped", 240_000), "an empty server is stopped by the rule");
ok(await until("the server is asleep", async () => (await list())[0].sleeping, 30_000), "the rule reports the server as asleep");
const asleep = await ping();
ok(flatten(asleep.description).includes("Asleep"), `the server list shows it as asleep: ${JSON.stringify(flatten(asleep.description))}`);
ok(asleep.version.name.includes(mcVersion) && asleep.players.max > 0, `the server list keeps the version and slots: ${asleep.version.name}, ${asleep.players.max} slots`);

const kicked = await new Promise((resolve) => {
  const client = mc.createClient({ host: "127.0.0.1", port: Number(mcPort), username: "Sleeper", auth: "offline", version: mcVersion });
  client.on("disconnect", (p) => resolve(p.reason ?? JSON.stringify(p)));
  client.on("error", (e) => resolve(`error: ${e.message}`));
  setTimeout(() => resolve("timeout"), 15_000);
});
ok(/waking up/.test(String(kicked)), `trying to join answers that the server wakes up: ${String(kicked).slice(0, 120)}`);
ok(await until("the server wakes", async () => (await c.server(s.id)).status === "running", 180_000), "the server starts by itself");
ok(!(await list())[0].sleeping, "it no longer counts as asleep");
const awake = await ping();
ok(!flatten(awake.description).includes("Asleep"), `the real server answers again: ${JSON.stringify(flatten(awake.description))}`);
const events = (await c.call("GET", `/api/servers/${s.id}/overview`)).events.map((e) => e.kind);
ok(events.includes("server.sleep") && events.includes("server.wake") && events.includes("rule.fired"), `the activity log tells the story: ${events.join(", ")}`);

await c.call("DELETE", `${rules}/${(await list())[0].id}`);
await c.stop(s.id).catch(() => {});
