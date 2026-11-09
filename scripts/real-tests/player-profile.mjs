// The player profile reads what Minecraft keeps per player (statistics, advancements, player data) and what CraftPanel
// recorded. A real Paper server and a mineflayer bot (see README) produce all of it:
//   node player-profile.mjs <base> <tools-dir> [mcVersion] [mcPort] [software]
import path from "node:path";
import { createRequire } from "node:module";
import { client } from "./client.mjs";

const [base, toolsDir, mcVersion = "1.21.4", mcPort = "25851", software = "paper"] = process.argv.slice(2);
if (!base || !toolsDir) throw new Error("usage: player-profile.mjs <base> <tools-dir> [mcVersion] [mcPort] [software]");
const mineflayer = createRequire(path.join(path.resolve(toolsDir), "package.json"))("mineflayer");
const c = client(base);
await c.signIn();
const ok = (cond, msg) => {
  console.log(`${cond ? "PASS" : "FAIL"} ${msg}`);
  if (!cond) process.exitCode = 1;
};

const NAME = "ProfileBot";
const s = await c.create({ name: "player-profile", software, mcVersion, port: Number(mcPort) });
await c.waitInstalled(s.id);
await c.start(s.id);
const profile = (name = NAME) => c.call("GET", `/api/servers/${s.id}/players/${name}/profile?tz=-60`);

try {
  const bot = mineflayer.createBot({ host: "127.0.0.1", port: Number(mcPort), username: NAME, auth: "offline", version: mcVersion });
  bot.on("error", () => {});
  await new Promise((resolve, reject) => {
    bot.once("spawn", resolve);
    setTimeout(() => reject(new Error("bot did not join")), 120_000);
  });
  await c.sleep(2000);

  // Things worth seeing in a profile. The death comes first: dying drops the inventory.
  await c.command(s.id, `kill ${NAME}`);
  await c.sleep(3000);
  for (const cmd of [
    `gamemode survival ${NAME}`,
    `give ${NAME} minecraft:diamond_sword[enchantments={sharpness:3}] 1`,
    `give ${NAME} minecraft:apple 5`,
    `item replace entity ${NAME} armor.head with minecraft:iron_helmet`,
    `xp set ${NAME} 5 levels`,
    `advancement grant ${NAME} only minecraft:story/root`,
  ]) {
    await c.command(s.id, cmd);
    await c.sleep(400);
  }
  // Walking and jumping are counted separately: a jump in the air isn't a step.
  bot.setControlState("forward", true);
  await c.sleep(4000);
  bot.clearControlStates();
  bot.setControlState("jump", true);
  await c.sleep(2000);
  bot.clearControlStates();
  await c.command(s.id, "save-all flush");
  await c.sleep(3000);

  const roster = (await c.call("GET", `/api/servers/${s.id}/players`)).roster;
  ok(roster.some((r) => r.name === NAME && r.online && r.sessions === 1), `the roster lists ${NAME} as online with one session`);

  const live = await profile();
  ok(live.online && live.onlineSince > 0, "profile says online while the bot is connected");
  ok(/^[0-9a-f-]{36}$/.test(live.uuid ?? ""), `uuid read from the log: ${live.uuid}`);
  console.log(`world folder: ${live.world}; saved ${live.savedAt ? Math.round((Date.now() - live.savedAt) / 1000) + " s ago" : "never"}`);
  ok(!!live.state, "player data (.dat) was found and parsed");
  if (live.state) {
    const inv = live.state.inventory;
    const sword = inv.find((i) => i.id === "minecraft:diamond_sword");
    ok(!!sword && sword.enchantments?.some((e) => e.id === "minecraft:sharpness" && e.level === 3), `sword with Sharpness III in the inventory: ${JSON.stringify(sword)}`);
    ok(inv.some((i) => i.id === "minecraft:apple" && i.count === 5), "5 apples in the inventory");
    ok(live.state.armor[3]?.id === "minecraft:iron_helmet", `iron helmet in the head slot: ${live.state.armor[3]?.id}`);
    ok(live.state.xpLevel === 5, `XP level ${live.state.xpLevel}`);
    ok(live.state.gameMode === "survival" && live.state.dimension === "minecraft:overworld" && !!live.state.pos, `survival in ${live.state.dimension} at ${JSON.stringify(live.state.pos)}`);
    ok(live.state.lastDeath !== null, `last death location recorded: ${JSON.stringify(live.state.lastDeath)}`);
  }
  ok(!!live.stats, "statistics file was found and parsed");
  if (live.stats) {
    ok(live.stats.deaths >= 1, `deaths: ${live.stats.deaths}`);
    ok(live.stats.distances.some((d) => d.id === "walk" && d.cm > 0), `walked: ${JSON.stringify(live.stats.distances.slice(0, 3))}`);
    ok(live.stats.jumps > 0, `jumps: ${live.stats.jumps}`);
    ok(live.stats.playTicks > 0, `Minecraft's play time: ${live.stats.playTicks} ticks`);
  }
  ok(!!live.advancements && live.advancements.done >= 1 && live.advancements.recent.some((a) => a.id === "minecraft:story/root" && a.at > 0), `advancement read with its timestamp: ${JSON.stringify(live.advancements?.recent[0])}`);

  const kicked = c.call("POST", `/api/servers/${s.id}/players/kick`, { name: NAME, reason: "profile test" });
  await kicked;
  bot.end();
  await c.sleep(2500);
  const after = await profile();
  ok(!after.online && after.activity.sessions === 1 && after.activity.recent[0].leftAt > 0, "after leaving: offline, session closed");
  ok(after.activity.heat.flat().some((ms) => ms > 0) && after.activity.daily[29].ms > 0, "the heatmap and today's bar show the session");
  ok(after.events.some((e) => e.kind === "player.kick"), `the kick shows in the player's activity: ${after.events[0]?.message}`);
  ok(!!after.state && after.state.inventory.some((i) => i.id === "minecraft:apple"), "player data is still readable after the player left");

  // Item pictures: Mojang's client for this version is downloaded to the cache, only item/block PNGs are kept.
  const raw = async (url) => {
    const { cookie } = c.session();
    const r = await fetch(base + url, { headers: { cookie } });
    return { status: r.status, type: r.headers.get("content-type"), cache: r.headers.get("cache-control"), body: Buffer.from(await r.arrayBuffer()) };
  };
  const isPng = (b) => b.length > 67 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const sword = await raw(`/api/servers/${s.id}/item-icons/diamond_sword`);
  ok(sword.status === 200 && sword.type === "image/png" && isPng(sword.body), `diamond_sword texture served from the client jar (${sword.body.length} bytes)`);
  for (const [name, why] of [["sand", "a block"], ["apple", "an item"], ["crafting_table", "a block seen from its front"], ["iron_helmet", "armor"], ["grass_block", "a tinted block"]]) {
    const r = await raw(`/api/servers/${s.id}/item-icons/${name}`);
    ok(r.status === 200 && isPng(r.body), `${name} (${why}) has a texture`);
  }
  ok((await raw(`/api/servers/${s.id}/item-icons/not_an_item`)).status === 404, "an unknown item is a 404 (the dashboard shows a monogram instead)");
  ok((await raw(`/api/servers/${s.id}/item-icons/..%2F..%2Fserver`)).status >= 400, "a path-like item name is refused");

  // A real skin: Dinnerbone's account (a Mojang-issued UUID) through the dashboard's API; an offline UUID has none.
  const skin = await raw("/api/skins/61699b2e-d327-4a01-9f1e-0ea8c3f06bc6");
  ok(skin.status === 200 && isPng(skin.body) && skin.body.readUInt32BE(16) === 64, `a real skin PNG comes back through CraftPanel (${skin.body.length} bytes, ${skin.body.readUInt32BE(16)}x${skin.body.readUInt32BE(20)})`);
  ok((await raw(`/api/skins/${live.uuid}`)).status === 404, "the bot's offline-mode UUID has no skin (and Mojang was not asked)");

  // Case-insensitive lookup, unknown names and path-like names.
  ok((await profile(NAME.toLowerCase())).name === NAME, "lookup is case-insensitive");
  ok((await profile("Nobody_here").catch((e) => e.status)) === 404, "an unknown player is a 404");
  ok((await profile("..%2f..").catch((e) => e.status)) >= 400, "a path-like name is refused");
} finally {
  await c.stop(s.id).catch(() => undefined);
  await c.call("DELETE", `/api/servers/${s.id}`).catch(() => undefined);
}
