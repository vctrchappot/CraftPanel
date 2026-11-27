import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CRAFTPANEL_VERSION } from "@craftpanel/shared";
import { RuntimeClient } from "@craftpanel/server-runtime";
import { importApplicationBackup } from "./app-restore";
import { dashboardUrls } from "@craftpanel/network";
import { loadConfig, PROFILES, type AppConfig } from "./config";
import { createContext } from "./bootstrap";
import { buildApp } from "./app";
import { prettyLogStream } from "./logging";
import { deploymentDiagnostics } from "./diagnostics";

const tty = process.stdout.isTTY === true && !process.env.NO_COLOR;
const style = (code: string) => (s: string) => (tty ? `\u001b[${code}m${s}\u001b[0m` : s);
const bold = style("1");
const dim = style("2");
const cyan = style("36");

function banner(config: AppConfig, setupToken: string | null): string {
  // VM/container adapters (WSL, Hyper-V, Docker…) are rarely what you want to share; the dashboard lists them all.
  const shown = dashboardUrls(config.host, config.port, !!config.tls).filter((u) => u.kind !== "virtual");
  const what = config.serveWeb && config.webDir ? "Dashboard" : "API";
  const rows: string[] = [
    "",
    `  ${bold("CraftPanel")} ${dim("v" + CRAFTPANEL_VERSION)}  ·  profile ${bold(config.profile)} ${dim("(" + PROFILES[config.profile].summary + ")")}`,
    "",
    ...shown.map((u, i) => `  ${(i === 0 ? what : "").padEnd(10)} ${cyan(u.url)}${u.kind === "local" ? "" : " " + dim(u.kind === "vpn" ? "(VPN)" : "(network)")}`),
    `  ${"Data".padEnd(10)} ${config.layout.root}`,
  ];
  if (setupToken) rows.push("", `  ${bold("Setup token")} ${bold(cyan(setupToken))}  ${dim("needed once to create the owner account")}`);
  rows.push("", dim(`  Profiles: ${Object.keys(PROFILES).join(" | ")}  →  pnpm start:<profile>  or  --profile <name>.${tty ? "  Stop with Ctrl+C." : ""}`), "");
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

  if (process.argv[2] === "doctor" || process.argv.includes("--doctor")) {
    // Ask the runtime what it enforces; `doctor` stays read-only (a handshake changes nothing) and never starts it.
    const probe = new RuntimeClient(config.layout.root, () => undefined); // the check itself reports an unreachable runtime
    await probe.connect().catch(() => undefined);
    const runtime = { connected: probe.connected, ...probe.identity };
    await probe.disconnect();
    const report = await deploymentDiagnostics(config, undefined, runtime);
    if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
    else for (const check of report.checks) console.log(`${check.status.toUpperCase().padEnd(7)} ${check.message}${check.hint ? `\n        ${check.hint}` : ""}`);
    process.exitCode = report.ok ? 0 : 1;
    return;
  }

  if (process.argv[2] === "import-backup") {
    const archive = process.argv[3];
    if (!archive || archive.startsWith("--")) {
      console.error("Usage (CraftPanel and its runtime stopped): node index.js import-backup <backup.zip|backup.cpbackup> [--replace] [--passphrase-file FILE]");
      process.exitCode = 2;
      return;
    }
    try {
      const passwordAt = process.argv.indexOf("--passphrase-file");
      if (passwordAt >= 0 && (!process.argv[passwordAt + 1] || process.argv[passwordAt + 1]!.startsWith("--"))) throw new Error("--passphrase-file needs a file path");
      const passphrase = passwordAt >= 0 ? fs.readFileSync(process.argv[passwordAt + 1]!, "utf8").replace(/\r?\n$/, "") : undefined;
      if (passphrase && passphrase.length > 1024) throw new Error("Passphrase exceeds 1,024 characters");
      const result = await importApplicationBackup(config.layout, archive, { replace: process.argv.includes("--replace"), passphrase, log: (m) => console.log(m) });
      console.log(`\nRestored ${result.servers} server(s), ${result.withFiles} with their files and worlds, into ${config.layout.root}.`);
      for (const note of result.notes) console.log(`  - ${note}`);
      if (result.backups) console.log(`Restored ${result.backups} earlier server backup(s).`);
      console.log("\nStart CraftPanel and sign in with the account from the old computer. The game files of every server are downloaded again at the first start.");
    } catch (err) {
      console.error(`Import failed: ${(err as Error).message}`);
      process.exitCode = 1;
    }
    return;
  }

  // Folder that holds apps/ (a git checkout or an installer's install directory).
  const installRoot = path.resolve(here, "../../..");
  const agent = new RuntimeClient(config.layout.root);
  await agent.connect().catch(() => console.warn("Minecraft runtime unavailable; server state remains unknown until it reconnects. Start the runtime service with the same data directory."));
  const ctx = await createContext(config, { migrationsFolder, installRoot, agent });
  // Lets the installers stop CraftPanel gracefully before an update (see control.json below).
  const controlToken = crypto.randomBytes(24).toString("hex");
  const controlFile = path.join(config.layout.root, "control.json");
  let requestShutdown = (_reason: string) => undefined as void;
  let ready = false;
  const app = await buildApp(ctx, {
    isReady: () => ready && ctx.agent.connected,
    control: { token: controlToken, shutdown: () => requestShutdown("Shutdown request") },
    logger: config.logFormat === "json" ? { level: config.logLevel } : { level: config.logLevel, stream: prettyLogStream({ level: config.logLevel }) },
  });

  await ctx.backups.recover();
  await ctx.servers.recover();
  await ctx.schedules.boot();
  await ctx.updates.recordStartup(async (kind, message, level) => void (await ctx.activity.event(null, kind, message, { level }))).catch(() => undefined);
  ctx.notifications.start();
  ctx.maps.start();
  await ctx.rules.start();
  ctx.monitoring.start();
  const housekeeping = setInterval(() => {
    if (ctx.setup.activating) return;
    void ctx.sessions.purgeExpired();
    void ctx.activity.prune();
  }, 3600_000);

  await app.listen({ host: config.host, port: config.port });
  const wildcard = config.host === "0.0.0.0" || config.host === "::";
  const controlHost = wildcard ? "127.0.0.1" : config.host.includes(":") ? `[${config.host}]` : config.host;
  fs.writeFileSync(controlFile, JSON.stringify({ pid: process.pid, version: CRAFTPANEL_VERSION, url: `${config.tls ? "https" : "http"}://${controlHost}:${config.port}`, token: controlToken }) + "\n", { mode: 0o600 });
  if (config.logFormat === "pretty") console.log(banner(config, ctx.setupToken));
  else {
    app.log.info({ profile: config.profile, host: config.host, port: config.port, dataDir: config.layout.root }, "CraftPanel started");
    // Printed so the person installing on a headless machine can finish setup in the browser.
    if (ctx.setupToken) app.log.info(`First-run setup token: ${ctx.setupToken} (also stored in ${path.join(config.layout.root, "setup-token.txt")})`);
  }
  if (config.serveWeb && !config.webDir) app.log.warn("Web dashboard build not found; only the API is served. Run `pnpm build` or use `pnpm dev`.");
  if (config.publicUrl) app.log.info(`External dashboard: ${config.publicUrl}`);
  if (!config.isLoopbackOnly) app.log.warn("The dashboard is reachable from other devices. Keep it on a private network or VPN, and never port-forward it to the internet.");

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    ready = false;
    app.log.info(`${signal} received: closing the dashboard; Minecraft servers remain in the runtime…`);
    clearInterval(housekeeping);
    ctx.schedules.stop();
    ctx.notifications.stop();
    ctx.maps.stop();
    await ctx.rules.stop();
    await ctx.monitoring.stop();
    ctx.updates.stop();
    await ctx.agent.disconnect();
    await app.close();
    ctx.database.close();
    fs.rmSync(controlFile, { force: true });
    process.exit(0);
  };
  requestShutdown = (reason) => void shutdown(reason);
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  if (process.platform === "win32") process.on("SIGBREAK", () => void shutdown("SIGBREAK"));
  ready = true;
}

main().catch((err) => {
  if ((process.argv[2] === "doctor" || process.argv.includes("--doctor")) && process.argv.includes("--json"))
    console.log(JSON.stringify({ ok: false, checks: [{ id: "configuration", status: "error", message: err.message }] }));
  else console.error("CraftPanel failed to start:", err);
  process.exit(1);
});
