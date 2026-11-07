import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    username: text("username").notNull(),
    passwordHash: text("password_hash").notNull(),
    role: text("role", { enum: ["owner", "admin", "operator", "viewer"] }).notNull(),
    disabled: integer("disabled", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at").notNull(),
    lastLoginAt: integer("last_login_at"),
  },
  (t) => [uniqueIndex("users_username_idx").on(t.username)],
);

export const sessions = sqliteTable(
  "sessions",
  {
    /** SHA-256 of the session token; the raw token only lives in the cookie. */
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    csrfToken: text("csrf_token").notNull(),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    lastSeenAt: integer("last_seen_at").notNull(),
    ip: text("ip"),
    userAgent: text("user_agent"),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export const servers = sqliteTable("servers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  edition: text("edition").notNull().default("java"),
  software: text("software", { enum: ["vanilla", "paper", "purpur", "fabric"] }).notNull(),
  mcVersion: text("mc_version").notNull(),
  build: text("build"),
  jarFile: text("jar_file"),
  jarSha: text("jar_sha"),
  javaMajor: integer("java_major").notNull(),
  javaPath: text("java_path"),
  memoryMb: integer("memory_mb").notNull(),
  jvmArgs: text("jvm_args").notNull().default(""),
  directory: text("directory").notNull(),
  port: integer("port").notNull(),
  networkMode: text("network_mode", { enum: ["lan", "wan"] }).notNull().default("lan"),
  bindAddress: text("bind_address").notNull().default(""),
  eulaAccepted: integer("eula_accepted", { mode: "boolean" }).notNull().default(false),
  eulaAcceptedAt: integer("eula_accepted_at"),
  autoStart: integer("auto_start", { mode: "boolean" }).notNull().default(false),
  /** In-game info command (/craftpanel, /trigger craftpanel): null follows the global setting. */
  infoCommand: integer("info_command", { mode: "boolean" }),
  installState: text("install_state", { enum: ["pending", "installing", "installed", "failed"] }).notNull().default("pending"),
  installError: text("install_error"),
  /** Last observed lifecycle state, persisted for startup recovery. */
  lastStatus: text("last_status").notNull().default("stopped"),
  /** Whether the user wants it running (used to decide crash notifications). */
  desiredRunning: integer("desired_running", { mode: "boolean" }).notNull().default(false),
  pid: integer("pid"),
  startedAt: integer("started_at"),
  lastExitCode: integer("last_exit_code"),
  lastError: text("last_error"),
  maxPlayers: integer("max_players").notNull().default(20),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const events = sqliteTable(
  "events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    serverId: text("server_id"),
    kind: text("kind").notNull(),
    level: text("level", { enum: ["info", "warn", "error"] }).notNull().default("info"),
    message: text("message").notNull(),
    actor: text("actor"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("events_server_idx").on(t.serverId, t.createdAt), index("events_created_idx").on(t.createdAt)],
);

export const auditLog = sqliteTable(
  "audit_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: text("user_id"),
    username: text("username"),
    action: text("action").notNull(),
    target: text("target"),
    details: text("details"),
    ip: text("ip"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("audit_created_idx").on(t.createdAt)],
);

export const backups = sqliteTable(
  "backups",
  {
    id: text("id").primaryKey(),
    serverId: text("server_id").notNull(),
    filename: text("filename").notNull(),
    storage: text("storage").notNull().default("local"),
    storageKey: text("storage_key").notNull(),
    size: integer("size").notNull().default(0),
    sha256: text("sha256"),
    kind: text("kind").notNull(),
    status: text("status", { enum: ["pending", "running", "completed", "failed"] }).notNull(),
    error: text("error"),
    note: text("note"),
    createdAt: integer("created_at").notNull(),
    completedAt: integer("completed_at"),
  },
  (t) => [index("backups_server_idx").on(t.serverId, t.createdAt)],
);

export const schedules = sqliteTable("schedules", {
  id: text("id").primaryKey(),
  serverId: text("server_id"),
  name: text("name").notNull(),
  cron: text("cron").notNull(),
  action: text("action").notNull(),
  payload: text("payload").notNull().default("{}"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  lastRunAt: integer("last_run_at"),
  lastStatus: text("last_status"),
  createdAt: integer("created_at").notNull(),
});

export const scheduleRuns = sqliteTable(
  "schedule_runs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    scheduleId: text("schedule_id").notNull(),
    /** Scheduled fire time truncated to the minute; unique to prevent duplicate runs. */
    slot: integer("slot").notNull(),
    startedAt: integer("started_at").notNull(),
    finishedAt: integer("finished_at"),
    status: text("status", { enum: ["running", "success", "failed", "skipped"] }).notNull(),
    output: text("output"),
  },
  (t) => [uniqueIndex("schedule_runs_slot_idx").on(t.scheduleId, t.slot)],
);

export const playerSessions = sqliteTable(
  "player_sessions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    serverId: text("server_id").notNull(),
    name: text("name").notNull(),
    uuid: text("uuid"),
    ip: text("ip"),
    joinedAt: integer("joined_at").notNull(),
    leftAt: integer("left_at"),
  },
  (t) => [index("player_sessions_server_idx").on(t.serverId, t.joinedAt)],
);

export const appSettings = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});
