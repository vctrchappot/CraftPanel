import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config";
import { createContext } from "./bootstrap";
import { buildApp } from "./app";

async function main() {
  const config = loadConfig();
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Bundled layout: apps/api/dist/{index.js,drizzle/,web/}
  const bundledMigrations = path.join(here, "drizzle");
  const migrationsFolder = fs.existsSync(path.join(bundledMigrations, "meta")) ? bundledMigrations : undefined;
  if (!config.webDir) {
    const candidates = [path.join(here, "web"), path.resolve(here, "../../web/out")];
    config.webDir = candidates.find((c) => fs.existsSync(path.join(c, "index.html"))) ?? null;
  }

  const ctx = await createContext(config, { migrationsFolder });
  const app = await buildApp(ctx);

  await ctx.backups.recover();
  await ctx.servers.recover();
  await ctx.schedules.boot();
  const housekeeping = setInterval(() => {
    void ctx.sessions.purgeExpired();
    void ctx.activity.prune();
  }, 3600_000);

  await app.listen({ host: config.host, port: config.port });
  const url = `http://${config.host.includes(":") ? `[${config.host}]` : config.host}:${config.port}`;
  app.log.info(`CraftPanel listening on ${url} (data: ${config.layout.root})`);
  if (!config.webDir) app.log.warn("Web dashboard build not found; only the API is served. Run `pnpm build` or use `pnpm dev`.");
  if (!config.isLoopbackOnly) app.log.warn(`The dashboard is reachable from other machines on ${config.host}. Use a private network or HTTPS reverse proxy; never expose it directly to the internet.`);
  if (ctx.setupToken) {
    // Printed so the person installing on a headless machine can finish setup in the browser.
    console.log(`\n  First-run setup token: ${ctx.setupToken}\n  (also stored in ${path.join(config.layout.root, "setup-token.txt")})\n`);
  }

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
