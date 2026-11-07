import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CRAFTPANEL_VERSION } from "@craftpanel/shared";
import { lanAddresses } from "@craftpanel/network";
import { loadConfig, PROFILES, type AppConfig } from "./config";
import { createContext } from "./bootstrap";
import { buildApp } from "./app";
import { prettyLogStream } from "./logging";

const tty = process.stdout.isTTY === true && !process.env.NO_COLOR;
const style = (code: string) => (s: string) => (tty ? `\u001b[${code}m${s}\u001b[0m` : s);
const bold = style("1");
const dim = style("2");
const cyan = style("36");

const VIRTUAL_ADAPTER = /vEthernet|Hyper-V|VirtualBox|VMware|docker|^br-|^veth|^virbr|^vboxnet|^tailscale|^zt/i;

function banner(config: AppConfig, setupToken: string | null): string {
  const port = config.port;
  const wildcard = config.host === "0.0.0.0" || config.host === "::";
  const local = `http://${config.isLoopbackOnly || wildcard ? "localhost" : config.host}:${port}`;
  // Hide virtual adapters (WSL, Hyper-V, VirtualBox, Docker) unless they are all there is.
  const all = wildcard ? lanAddresses() : [];
  const physical = all.filter((a) => !VIRTUAL_ADAPTER.test(a.interface));
  const lan = (physical.length ? physical : all).map((a) => `http://${a.address}:${port}`);
  const what = config.serveWeb && config.webDir ? "Dashboard" : "API";
  const rows: string[] = [
    "",
    `  ${bold("CraftPanel")} ${dim("v" + CRAFTPANEL_VERSION)}  ·  profile ${bold(config.profile)} ${dim("(" + PROFILES[config.profile].summary + ")")}`,
    "",
    `  ${what.padEnd(10)} ${cyan(local)}`,
    ...lan.map((u) => `  ${"".padEnd(10)} ${cyan(u)} ${dim("(network)")}`),
    `  ${"Data".padEnd(10)} ${config.layout.root}`,
  ];
  if (setupToken) rows.push("", `  ${bold("Setup token")} ${bold(cyan(setupToken))}  ${dim("needed once to create the owner account")}`);
  rows.push("", dim(`  Profiles: ${Object.keys(PROFILES).join(" | ")}  →  pnpm start:<profile>  or  --profile <name>.  Stop with Ctrl+C.`), "");
  return rows.join("\n");
}

async function main() {
  const config = loadConfig(process.env, process.argv.slice(2));
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Bundled layout: apps/api/dist/{index.js,drizzle/,web/}
  const bundledMigrations = path.join(here, "drizzle");
  const migrationsFolder = fs.existsSync(path.join(bundledMigrations, "meta")) ? bundledMigrations : undefined;
  if (!config.serveWeb) config.webDir = null;
  else if (!config.webDir) {
    const candidates = [path.join(here, "web"), path.resolve(here, "../../web/out")];
    config.webDir = candidates.find((c) => fs.existsSync(path.join(c, "index.html"))) ?? null;
  }

  const ctx = await createContext(config, { migrationsFolder });
  const app = await buildApp(ctx, {
    logger: config.logFormat === "json" ? { level: config.logLevel } : { level: config.logLevel, stream: prettyLogStream({ level: config.logLevel }) },
  });

  await ctx.backups.recover();
  await ctx.servers.recover();
  await ctx.schedules.boot();
  const housekeeping = setInterval(() => {
    void ctx.sessions.purgeExpired();
    void ctx.activity.prune();
  }, 3600_000);

  await app.listen({ host: config.host, port: config.port });
  if (config.logFormat === "pretty") console.log(banner(config, ctx.setupToken));
  else {
    app.log.info({ profile: config.profile, host: config.host, port: config.port, dataDir: config.layout.root }, "CraftPanel started");
    // Printed so the person installing on a headless machine can finish setup in the browser.
    if (ctx.setupToken) app.log.info(`First-run setup token: ${ctx.setupToken} (also stored in ${path.join(config.layout.root, "setup-token.txt")})`);
  }
  if (config.serveWeb && !config.webDir) app.log.warn("Web dashboard build not found; only the API is served. Run `pnpm build` or use `pnpm dev`.");
  if (!config.isLoopbackOnly) app.log.warn("The dashboard is reachable from other devices. Keep it on a private network or VPN, and never port-forward it to the internet.");

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info(`${signal} received: stopping Minecraft servers gracefully…`);
    clearInterval(housekeeping);
    ctx.schedules.stop();
    await ctx.agent.shutdown(60_000);
    await app.close();
    ctx.database.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  if (process.platform === "win32") process.on("SIGBREAK", () => void shutdown("SIGBREAK"));
}

main().catch((err) => {
  console.error("CraftPanel failed to start:", err);
  process.exit(1);
});
