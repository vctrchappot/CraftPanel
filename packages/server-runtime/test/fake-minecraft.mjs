// Minimal stand-in for a Minecraft server process used by lifecycle tests.
// Behaviour is selected by argv[2]: "normal" | "crash" | "modfail" | "hang" | "slowstart".
import readline from "node:readline";

const mode = process.argv[2] ?? "normal";
const log = (lvl, msg) => console.log(`[12:00:00] [Server thread/${lvl}]: ${msg}`);
log("INFO", "Starting minecraft server version test");
if (mode === "crash") {
  log("ERROR", "Encountered an unexpected exception");
  process.exit(1);
}
if (mode === "modfail") {
  // NeoForge's mod loading report for a client-only mod (abridged), then exit code 0 like the real thing.
  console.log("-- Mod loading issue for: statuseffectbars --");
  console.log("Details:");
  console.log("\tCaused by 0: java.lang.BootstrapMethodError: java.lang.RuntimeException: Attempted to load class net/minecraft/client/gui/screens/Screen for invalid dist DEDICATED_SERVER");
  console.log("\tMod file: /srv/mc/mods/statuseffectbars-1.21.1-NeoForge-1.0.2.jar");
  log("ERROR", "Failed to start the minecraft server");
  process.exit(0);
}
setTimeout(() => log("INFO", 'Done (0.123s)! For help, type "help"'), mode === "slowstart" ? 500 : 50);

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const cmd = line.trim();
  if (cmd === "stop") {
    if (mode === "hang") return; // simulate a server that ignores stop
    log("INFO", "Stopping the server");
    setTimeout(() => process.exit(0), 50);
  } else if (cmd === "list") log("INFO", "There are 1 of a max of 20 players online: Steve");
  else if (cmd === "save-all flush") log("INFO", "System chat: Saved the game");
  else if (cmd.startsWith("join ")) {
    const n = cmd.slice(5);
    console.log(`[12:00:01] [User Authenticator #1/INFO]: UUID of player ${n} is 069a79f4-44e9-4726-a5be-fca90e38aaf5`);
    log("INFO", `${n} joined the game`);
  } else if (cmd.startsWith("leave ")) log("INFO", `${cmd.slice(6)} left the game`);
  else log("INFO", `Unknown or incomplete command, see below for error`);
});
