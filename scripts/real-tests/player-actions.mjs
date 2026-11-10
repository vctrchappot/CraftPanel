// The player Actions tab's API against a real server: every action in the catalog on a mineflayer bot, what the game
// did about it (read back from the running game), what the bot received, refusals, and the inspect endpoint.
//   node player-actions.mjs <base> <tools-dir> [mcVersion] [mcPort] [software]
// With KEEP_OPEN=<file> the instance stays up after the action checks (for a look at the Actions tab, with both bots
// online) until Ctrl+C, and the file gets the server id.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { client } from "./client.mjs";

const [base, toolsDir, mcVersion = "1.21.4", mcPort = "25852", software = "paper"] = process.argv.slice(2);
if (!base || !toolsDir) throw new Error("usage: player-actions.mjs <base> <tools-dir> [mcVersion] [mcPort] [software]");
const mineflayer = createRequire(path.join(path.resolve(toolsDir), "package.json"))("mineflayer");
const c = client(base);
await c.signIn();
const ok = (cond, msg) => {
  console.log(`${cond ? "PASS" : "FAIL"} ${msg}`);
  if (!cond) process.exitCode = 1;
};

const NAME = "ActionBot";
const OTHER = "FriendBot";
const s = await c.create({ name: "player-actions", software, mcVersion, port: Number(mcPort) });
await c.waitInstalled(s.id);
await c.start(s.id);
const profile = (name = NAME) => c.call("GET", `/api/servers/${s.id}/players/${name}/profile?tz=0`);
const inspect = (name = NAME) => c.call("GET", `/api/servers/${s.id}/players/${name}/inspect`);
const act = (action, params = {}, name = NAME) => c.call("POST", `/api/servers/${s.id}/players/${name}/actions/${action}`, { params });
const refused = (p) => p.then(() => null, (e) => e);
const join = async (username) => {
  const bot = mineflayer.createBot({ host: "127.0.0.1", port: Number(mcPort), username, auth: "offline", version: mcVersion });
  bot.on("error", () => {});
  bot.chatLog = [];
  bot.titles = [];
  bot.on("messagestr", (m) => bot.chatLog.push(m));
  bot._client.on("set_title_text", (p) => bot.titles.push(JSON.stringify(p)));
  await new Promise((resolve, reject) => {
    bot.once("spawn", resolve);
    setTimeout(() => reject(new Error(`${username} did not join`)), 120_000);
  });
  return bot;
};

try {
  const bot = await join(NAME);
  const friend = await join(OTHER);
  await c.sleep(2500);
  await c.command(s.id, `gamemode survival ${NAME}`);
  await c.command(s.id, `gamemode survival ${OTHER}`);

  // ---- inspect: what the game says about the player right now -----------------------------------
  await c.command(s.id, `tag ${NAME} add vip`);
  await c.command(s.id, `effect give ${NAME} minecraft:regeneration 30 1`);
  await c.sleep(1500);
  let i = await inspect();
  ok(i.source === "game", `an online player is asked of the running game (${i.source})`);
  ok(i.tags.includes("vip"), `scoreboard tag shows: ${JSON.stringify(i.tags)}`);
  ok(i.effects.some((e) => e.id === "minecraft:regeneration" && e.level === 2 && e.seconds > 0 && e.seconds <= 30), `active effect with level and time left: ${JSON.stringify(i.effects)}`);
  ok(i.flags.some((f) => f.id === "mayBuild" && f.on) && !i.flags.find((f) => f.id === "flying").on, "ability flags read, survival: may build, not flying");
  ok(i.values.some((v) => v.label === "Walk speed"), `values: ${i.values.map((v) => `${v.label} ${v.value}`).join(", ")}`);
  ok(Array.isArray(i.plugins) && i.raw.includes('"Health"') && !i.raw.includes('"Inventory"'), "raw data is formatted JSON without the inventory");
  await c.command(s.id, `gamemode creative ${NAME}`);
  // Answers are shared for 2.5 s; a change made behind CraftPanel's back shows after that. Actions clear the cache themselves.
  await c.sleep(3000);
  i = await inspect();
  ok(i.flags.find((f) => f.id === "mayfly").on && i.flags.find((f) => f.id === "instabuild").on, "creative mode switches on may-fly and instant build");

  // ---- management -------------------------------------------------------------------------------
  const r1 = await act("gamemode", { mode: "survival" });
  ok(/survival/.test(r1.summary), `gamemode: ${r1.summary}`);
  await c.sleep(1200);
  ok((await profile()).state.gameMode === "survival", "the player is in survival again");

  await c.command(s.id, `damage ${NAME} 12`);
  await c.sleep(3000);
  const hurt = (await profile()).state.health;
  const r2 = await act("heal");
  await c.sleep(1500);
  const healed = (await profile()).state;
  ok(hurt < 20 && healed.health === 20 && healed.food === 20, `heal and feed: health ${hurt} -> ${healed.health}, food ${healed.food}`);

  await act("give-item", { item: "diamond", count: 3 });
  await c.sleep(800);
  ok((await profile()).state.inventory.some((it) => it.id === "minecraft:diamond" && it.count === 3), "3 diamonds in the inventory");
  await act("set-xp", { level: 12 });
  await c.sleep(800);
  ok((await profile()).state.xpLevel === 12, "experience level set to 12");

  await act("teleport-coords", { x: 120.5, y: 150, z: -80, dimension: "current" });
  await c.sleep(1500);
  let pos = (await profile()).state.pos;
  ok(Math.abs(pos.x - 120.5) < 1.5 && Math.abs(pos.z + 80) < 1.5, `teleported to coordinates: ${pos.x.toFixed(1)} ${pos.y.toFixed(1)} ${pos.z.toFixed(1)}`);
  // Mid-air in the Nether the bot falls, and a teleport keeps the fall: without this it dies on arriving at the other
  // player and respawns somewhere else (seen on Vanilla).
  await c.command(s.id, `effect give ${NAME} minecraft:slow_falling 120`);
  await act("teleport-coords", { x: 0, y: 100, z: 0, dimension: "minecraft:the_nether" });
  await c.sleep(1500);
  // The server's own confirmation is the hard check. Whether the bot stays in a freshly generated Nether is up to
  // mineflayer (in some runs it ended up back in the Overworld although the server had teleported it), so that is a note.
  const lines = JSON.stringify(await c.log(s.id));
  ok(/Teleported ActionBot to 0.500000, 100.000000, 0.500000/.test(lines), "the server teleported the player into the Nether (console confirmation)");
  let dim = null;
  for (let n = 0; n < 8 && dim !== "minecraft:the_nether"; n++) {
    dim = (await profile()).state.dimension;
    if (dim !== "minecraft:the_nether") await c.sleep(1000);
  }
  console.log(`NOTE the bot's dimension afterwards: ${dim}`);
  await act("teleport-player", { target: OTHER });
  // Coming back from the Nether (also a dimension change): the server may be busy loading chunks for a moment.
  let near = false;
  for (let n = 0; n < 40 && !near; n++) {
    await c.sleep(1000);
    const a = (await profile()).state;
    const b = (await profile(OTHER)).state;
    near = a.dimension === "minecraft:overworld" && Math.hypot(a.pos.x - b.pos.x, a.pos.z - b.pos.z) < 3;
  }
  ok(near, "teleported next to another player");

  await act("message", { text: 'Hello "there" \\ <3' });
  await c.sleep(800);
  ok(bot.chatLog.some((m) => m.includes('Hello "there" \\ <3')), `private message arrived with its quotes intact: ${bot.chatLog.at(-1)}`);

  // ---- fun --------------------------------------------------------------------------------------
  await act("title", { title: "Look up", subtitle: "Something is coming", seconds: 3 });
  await c.sleep(1000);
  ok(bot.titles.some((t) => t.includes("Look up")), `title packet received: ${bot.titles.at(-1)}`);
  await act("fake-op");
  await c.sleep(800);
  ok(bot.chatLog.some((m) => m.includes(`Made ${NAME} a server operator`)), "the fake operator message arrived");
  ok(!(await profile()).opLevel, "...and nothing changed: not an operator");
  const snd = await act("sound", { sound: "entity.creeper.primed", pitch: 0.7 });
  ok(/creeper/.test(snd.summary), `sound: ${snd.summary}`);
  await act("effect", { effect: "speed", seconds: 40, level: 3 });
  await c.sleep(1500);
  i = await inspect();
  ok(i.effects.some((e) => e.id === "minecraft:speed" && e.level === 3), `effect applied at level 3: ${JSON.stringify(i.effects.map((e) => `${e.id} ${e.level}`))}`);
  await act("clear-effects");
  await c.sleep(1500);
  ok((await inspect()).effects.length === 0, "all effects removed");

  await act("launch", { seconds: 4 });
  ok((await inspect()).effects.some((e) => e.id === "minecraft:levitation"), "launch: levitation is on");
  await c.sleep(9000);

  await c.command(s.id, `effect give ${NAME} minecraft:instant_health 1 10`);
  await act("lightning");
  ok(true, "lightning: accepted");

  await act("clear-inventory");
  await c.sleep(800);
  ok((await profile()).state.inventory.length === 0, "inventory cleared");
  await act("kill");
  await c.sleep(2500);
  const dead = await profile();
  ok(dead.state.lastDeath !== null, "kill: the death was recorded");
  ok(dead.events.some((e) => e.kind === "player.action" && /Killed ActionBot/.test(e.message) && e.actor), `actions appear in the player's history with the actor: ${dead.events.filter((e) => e.kind === "player.action").length} entries`);

  if (process.env.KEEP_OPEN) {
    await c.command(s.id, `effect give ${NAME} minecraft:speed 900 1`);
    await c.command(s.id, `tag ${NAME} add builder`);
    await c.command(s.id, `gamemode survival ${NAME}`);
    fs.writeFileSync(process.env.KEEP_OPEN, JSON.stringify({ serverId: s.id, name: NAME }));
    console.log(`Instance open at ${base} (owner / owner-password-1). Ctrl+C to stop.`);
    await new Promise(() => {});
  }

  // ---- refusals ---------------------------------------------------------------------------------
  const unknownEffect = await refused(act("effect", { effect: "mymod:fear", seconds: 5, level: 1 }));
  ok(unknownEffect?.status === 422 && /Can't find element|Unknown/i.test(unknownEffect.body), `a command the game refuses is shown to the user: ${unknownEffect?.body}`);
  for (const [action, params, why] of [
    ["message", { text: "hi\nop ActionBot" }, "a line break in a message"],
    ["give-item", { item: "diamond 64 run stop" }, "extra words in an item id"],
    ["teleport-player", { target: "x run stop" }, "a bad player name"],
    ["effect", { effect: "speed", seconds: 99999, level: 1 }, "an out-of-range duration"],
    ["nope", {}, "an unknown action"],
  ]) {
    const e = await refused(act(action, params));
    ok(e?.status === 400, `${why} is refused (400)`);
  }
  const noSuchPlayer = await refused(act("heal", {}, "Nobody_here"));
  ok(noSuchPlayer?.status === 409, "an action on a player who is not online is a 409");

  // ---- after leaving ----------------------------------------------------------------------------
  bot.end();
  friend.end();
  await c.sleep(3500);
  const gone = await refused(act("heal"));
  ok(gone?.status === 409 && /not online/.test(gone.body), `an offline player can't be acted on: ${gone?.body}`);
  const saved = await inspect();
  ok(saved.source === "file" && saved.savedAt > 0 && saved.tags.includes("vip"), `inspect falls back to the saved file (${saved.source}), tags kept: ${JSON.stringify(saved.tags)}`);
  ok((await refused(inspect("Nobody_here")))?.status === 404, "inspect of an unknown player is a 404");
} finally {
  await c.stop(s.id).catch(() => undefined);
  await c.call("DELETE", `/api/servers/${s.id}`).catch(() => undefined);
}
