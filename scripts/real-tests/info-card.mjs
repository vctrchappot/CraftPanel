// The in-game /craftpanel card shows the current CraftPanel version and server software, also on a server that
// kept running while the dashboard was replaced. Needs mineflayer (see README); two phases around a dashboard restart:
//   node info-card.mjs <base> prepare <state-file> <tools-dir> [mcVersion] [mcPort]
//   (restart the API process only, keep the runtime and the data directory)
//   node info-card.mjs <base> verify  <state-file> <tools-dir> [mcVersion] [mcPort]
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { client } from "./client.mjs";

const [base, phase, stateFile, toolsDir, mcVersion = "1.21.4", mcPort = "25841"] = process.argv.slice(2);
if (!base || !["prepare", "verify"].includes(phase) || !stateFile || !toolsDir) throw new Error("usage: info-card.mjs <base> prepare|verify <state-file> <tools-dir> [mcVersion] [mcPort]");
const mineflayer = createRequire(path.join(path.resolve(toolsDir), "package.json"))("mineflayer");
const c = client(base);
await c.signIn();
const pkg = JSON.parse(await fs.readFile(new URL("../../package.json", import.meta.url), "utf8"));
const ok = (cond, msg) => {
  console.log(`${cond ? "PASS" : "FAIL"} ${msg}`);
  if (!cond) process.exitCode = 1;
};

/** Join as a bot, run /craftpanel and return the card as plain text lines. */
async function readCard(id, name) {
  const bot = mineflayer.createBot({ host: "127.0.0.1", port: Number(mcPort), username: name, auth: "offline", version: mcVersion });
  bot.on("error", () => {});
  const lines = [];
  bot.on("messagestr", (m) => lines.push(m));
  await new Promise((resolve, reject) => {
    bot.once("spawn", resolve);
    setTimeout(() => reject(new Error("bot did not join")), 90_000);
  });
  await c.sleep(1500);
  lines.length = 0;
  bot.chat("/craftpanel");
  await c.sleep(2500);
  bot.end();
  return lines;
}
const show = (lines) => lines.find((l) => /powered by CraftPanel/.test(l)) + " | " + lines.find((l) => /Running /.test(l));

if (phase === "prepare") {
  const s = await c.create({ name: "info-card", software: "paper", mcVersion, port: Number(mcPort) });
  await c.waitInstalled(s.id);
  await c.start(s.id);
  await fs.writeFile(stateFile, s.id);
  let card = await readCard(s.id, "CardBot1");
  ok(card.some((l) => l.includes(`powered by CraftPanel v${pkg.version}`)) && card.some((l) => l.includes(`Running Paper ${mcVersion}`)), `fresh start shows v${pkg.version} and Paper ${mcVersion}: ${show(card)}`);
  // Simulate a card left over from an older CraftPanel: the running game still holds old values.
  await c.command(s.id, `data merge storage craftpanel:info {version:"0.0.1",software:"Paper 0.0"}`);
  await c.sleep(500);
  card = await readCard(s.id, "CardBot2");
  ok(card.some((l) => l.includes("powered by CraftPanel v0.0.1")), `the card reads the running game's values (proof it is not baked in): ${show(card)}`);
  console.log("Now restart the API process only, then run the verify phase.");
} else {
  const id = (await fs.readFile(stateFile, "utf8")).trim();
  const d = await c.server(id);
  ok(d.status === "running", `server kept running across the dashboard restart (${d.status})`);
  let card = [];
  for (let i = 0; i < 10 && !card.some((l) => l.includes(`powered by CraftPanel v${pkg.version}`)); i++) {
    await c.sleep(2000);
    card = await readCard(id, `CardBot${3 + i}`);
  }
  ok(card.some((l) => l.includes(`powered by CraftPanel v${pkg.version}`)) && card.some((l) => l.includes(`Running Paper ${mcVersion}`)), `the running server shows the current values again without a restart: ${show(card)}`);
  await c.stop(id);
  await c.call("DELETE", `/api/servers/${id}`).catch(() => undefined);
}
