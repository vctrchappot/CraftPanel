import fsp from "node:fs/promises";
import path from "node:path";
import { openDatabase, runMigrations, sql, users } from "@craftpanel/database";
import { LocalAgent, type RuntimeAgent } from "@craftpanel/server-runtime";
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
import { RuleService } from "./services/rules";
import { GameService } from "./services/game";
import { SettingsService } from "./services/settings";
import { UpdateService } from "./services/updates";
import { PregenService } from "./services/pregen";
import { ProxyService } from "./services/proxy";
import { NotificationService } from "./services/notifications";
import { runtimeAccess } from "./services/runtime-access";
import { AssistantService } from "./services/assistant/service";
import { MapService } from "./services/map";

/** Wire up persistence, runtime and services. Does not start listening. */
export async function createContext(config: AppConfig, opts: { migrationsFolder?: string; installRoot?: string; agent?: RuntimeAgent; assistantFetch?: typeof fetch } = {}): Promise<AppContext> {
  const L = config.layout;
  for (const dir of [L.root, L.servers, L.backups, L.java, L.cache, L.logs, L.tmp]) await fsp.mkdir(dir, { recursive: true });
  // Clear leftovers from interrupted uploads/exports.
  for (const f of await fsp.readdir(L.tmp)) await fsp.rm(path.join(L.tmp, f), { recursive: true, force: true });

  const database = openDatabase(L.database);
  await runMigrations(database, opts.migrationsFolder);
  const { db } = database;

  const hub = new Hub();
  const agent = opts.agent ?? new LocalAgent();
  const java = new JavaManager(L.java, L.tmp);
  const activity = new ActivityService(db, hub);
  const settings = new SettingsService(db);
  const updates = new UpdateService(settings, opts.installRoot ?? null, undefined, undefined, undefined, opts.agent ? {
    build: () => agent.connected ? agent.identity?.build ?? null : null,
    approvalFile: path.join(L.root, "runtime", "update-approval.json"),
  } : undefined);
  const sessions = new SessionStore(db, config.sessionTtlMs, async () => (await settings.get()).twoFactorRoles);
  const servers = new ServerService(db, agent, hub, activity, java, config, settings, runtimeAccess(opts.installRoot, agent));
  const backups = new BackupService(db, servers, hub, activity, settings, config);
  const schedules = new ScheduleService(db, servers, backups, activity, settings);
  const game = new GameService(db, servers, activity, config);
  const pregen = new PregenService(servers, game);
  const maps = new MapService(servers, game, settings, activity);
  const proxies = new ProxyService(servers, game, activity);
  const notifications = new NotificationService(settings, updates);
  const rules = new RuleService(db, servers, backups, maps, notifications, activity);
  activity.listen((event, serverName) => notifications.onEvent(event, serverName));
  const assistant = new AssistantService({ settings, sessions, servers, game, backups, schedules, activity }, opts.assistantFetch);

  // First-run protection: on non-loopback binds, creating the owner needs a token
  // that only someone with access to the host (console or data dir) can read.
  let setupToken: string | null = null;
  const [{ n }] = await db.select({ n: sql<number>`count(*)` }).from(users);
  const tokenFile = path.join(L.root, "setup-token.txt");
  if (n === 0 && !config.isLoopbackOnly) {
    setupToken = randomToken(12);
    await fsp.writeFile(tokenFile, setupToken + "\n", { mode: 0o600 });
  } else await fsp.rm(tokenFile, { force: true });

  return { config, database, agent, hub, sessions, activity, servers, backups, schedules, rules, game, pregen, maps, proxies, settings, updates, notifications, java, assistant, setupToken };
}
