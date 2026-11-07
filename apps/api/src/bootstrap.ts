import fsp from "node:fs/promises";
import path from "node:path";
import { openDatabase, runMigrations, sql, users } from "@craftpanel/database";
import { LocalAgent } from "@craftpanel/server-runtime";
import { JavaManager } from "@craftpanel/minecraft-providers";
import type { AppConfig } from "./config";
import type { AppContext } from "./context";
import { Hub } from "./hub";
import { SessionStore } from "./auth/sessions";
import { randomToken } from "./auth/password";
import { ActivityService } from "./services/activity";
import { ServerService } from "./services/servers";
import { BackupService } from "./services/backups";
import { ScheduleService } from "./services/schedules";
import { GameService } from "./services/game";
import { SettingsService } from "./services/settings";

/** Wire up persistence, runtime and services. Does not start listening. */
export async function createContext(config: AppConfig, opts: { migrationsFolder?: string } = {}): Promise<AppContext> {
  const L = config.layout;
  for (const dir of [L.root, L.servers, L.backups, L.java, L.cache, L.logs, L.tmp]) await fsp.mkdir(dir, { recursive: true });
  // Clear leftovers from interrupted uploads/exports.
  for (const f of await fsp.readdir(L.tmp)) await fsp.rm(path.join(L.tmp, f), { recursive: true, force: true });

  const database = openDatabase(L.database);
  await runMigrations(database, opts.migrationsFolder);
  const { db } = database;

  const hub = new Hub();
  const agent = new LocalAgent();
  const java = new JavaManager(L.java, L.tmp);
  const activity = new ActivityService(db, hub);
  const settings = new SettingsService(db);
  const sessions = new SessionStore(db, config.sessionTtlMs);
  const servers = new ServerService(db, agent, hub, activity, java, config, settings);
  const backups = new BackupService(db, servers, hub, activity, settings, config);
  const schedules = new ScheduleService(db, servers, backups, activity, settings);
  const game = new GameService(db, servers, activity, config);

  // First-run protection: on non-loopback binds, creating the owner needs a token
  // that only someone with access to the host (console or data dir) can read.
  let setupToken: string | null = null;
  const [{ n }] = await db.select({ n: sql<number>`count(*)` }).from(users);
  const tokenFile = path.join(L.root, "setup-token.txt");
  if (n === 0 && !config.isLoopbackOnly) {
    setupToken = randomToken(12);
    await fsp.writeFile(tokenFile, setupToken + "\n", { mode: 0o600 });
  } else await fsp.rm(tokenFile, { force: true });

  return { config, database, agent, hub, sessions, activity, servers, backups, schedules, game, settings, java, setupToken };
}
