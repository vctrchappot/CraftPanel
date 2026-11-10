import type { Access, Role, ServerRole, ServerScope } from "./roles";
import type { ServerSoftware } from "./software";
import type { AssistantConversationView } from "./assistant";
export type { ServerSoftware };

export type Edition = "java";

/** A server behind a Velocity proxy. `name` is how the proxy (and `/server <name>`) calls it. */
export interface ProxyBackend {
  serverId: string;
  name: string;
  /** Optional forced host: players connecting via this address land on this server. */
  host?: string;
}

export interface ProxyConfig {
  /** In try order: new players join the first one that is online. */
  backends: ProxyBackend[];
  /** The proxy authenticates players with Mojang; backends trust its forwarded identity. */
  onlineMode: boolean;
  /** Bind backends to 127.0.0.1 so players can only reach them through the proxy. */
  localOnly: boolean;
}

export interface ProxyBackendStatus extends ProxyBackend {
  serverName: string;
  software: ServerSoftware;
  port: number;
  bindAddress: string;
  status: string;
  /** "ready": forwarding is configured; "restart": configured, applies on the next start; "manual": needs a step CraftPanel can't do. */
  setup: "ready" | "restart" | "manual";
  notes: string[];
}

export interface ProxyOverview {
  config: ProxyConfig;
  backends: ProxyBackendStatus[];
  /** Servers that can be added (every non-proxy server not yet in the list). */
  candidates: { id: string; name: string; software: ServerSoftware; port: number }[];
}
export type NetworkMode = "lan" | "wan";

/**
 * Runtime state of a managed server. `orphaned` means a process from a
 * previous CraftPanel run is still alive but we no longer own its stdin.
 */
export type ServerStatus =
  | "unknown"
  | "installing"
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "crashed"
  | "error"
  | "orphaned";

export type InstallState = "pending" | "installing" | "installed" | "failed";

export interface ServerSummary {
  id: string;
  name: string;
  description: string;
  software: ServerSoftware;
  mcVersion: string;
  build: string | null;
  port: number;
  networkMode: NetworkMode;
  status: ServerStatus;
  installState: InstallState;
  installError: string | null;
  eulaAccepted: boolean;
  autoStart: boolean;
  memoryMb: number;
  playersOnline: number;
  maxPlayers: number;
  startedAt: number | null;
  createdAt: number;
  restartRequired: boolean;
  /** Changes whenever the server's icon (`server-icon.png`) does; null when it has none. Append it to the icon URL. */
  iconVersion: number | null;
}

export interface ServerDetail extends ServerSummary {
  directory: string;
  /** In-game info command override: null follows the global setting. */
  infoCommand: boolean | null;
  javaMajor: number;
  javaPath: string | null;
  jvmArgs: string;
  bindAddress: string;
  /** Log4Shell protection CraftPanel applies on start (Minecraft 1.7–1.18), or null when none is needed. */
  log4shell: string | null;
  pid: number | null;
  exitCode: number | null;
  lastError: string | null;
  players: OnlinePlayer[];
}

export interface OnlinePlayer {
  name: string;
  uuid: string | null;
  joinedAt: number;
}

export type LogLevel = "INFO" | "WARN" | "ERROR" | "DEBUG" | "FATAL" | "UNKNOWN";

export interface ConsoleLine {
  seq: number;
  ts: number;
  stream: "stdout" | "stderr" | "system" | "command";
  level: LogLevel;
  text: string;
}

/** A metric that is null is unavailable and must be displayed as such. */
export interface ServerMetrics {
  ts: number;
  cpuPercent: number | null;
  memoryBytes: number | null;
  tps: number | null;
  mspt: number | null;
  uptimeMs: number | null;
  playersOnline: number;
}

export interface InstallProgress {
  serverId: string;
  stage: string;
  percent: number | null;
  message: string;
  done?: boolean;
  error?: string;
}

/** Messages pushed from API to browser over the WebSocket. */
export type WsServerMessage =
  | { type: "hello"; user: { id: string; username: string; role: Role } }
  | { type: "console"; serverId: string; lines: ConsoleLine[]; replay?: boolean }
  | { type: "status"; serverId: string; status: ServerStatus; detail?: string }
  | { type: "metrics"; serverId: string; metrics: ServerMetrics }
  | { type: "players"; serverId: string; players: OnlinePlayer[] }
  | { type: "install"; progress: InstallProgress }
  | { type: "backup"; serverId: string; backupId: string; status: string; percent?: number | null; message?: string }
  | { type: "event"; event: ActivityEvent }
  | { type: "error"; message: string }
  /** A conversation with the AI assistant changed (sent only to the user it belongs to). */
  | { type: "assistant"; conversation: AssistantConversationView };

/** Messages sent from browser to API over the WebSocket. */
export type WsClientMessage =
  | { type: "subscribe"; serverId: string }
  | { type: "unsubscribe"; serverId: string }
  | { type: "command"; serverId: string; command: string }
  | { type: "ping" };

export interface ActivityEvent {
  id: number;
  serverId: string | null;
  serverName?: string | null;
  kind: string;
  level: "info" | "warn" | "error";
  message: string;
  actor: string | null;
  createdAt: number;
}

export interface BackupInfo {
  id: string;
  serverId: string;
  serverName?: string;
  filename: string;
  size: number;
  sha256: string | null;
  kind: "manual" | "scheduled" | "pre-restore" | "pre-update" | "pre-migration" | "pre-delete";
  status: "pending" | "running" | "completed" | "failed";
  error: string | null;
  note: string | null;
  createdAt: number;
  completedAt: number | null;
}

export interface FileEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  size: number;
  modifiedAt: number;
}

export interface UserInfo {
  id: string;
  username: string;
  role: Role;
  disabled: boolean;
  createdAt: number;
  lastLoginAt: number | null;
  serverScope: ServerScope;
  /** Per-server roles (server id → role). */
  serverRoles: Record<string, ServerRole>;
  twoFactorEnabled: boolean;
}

/** A signed-in browser or device. */
export interface SessionInfo {
  /** Short public id (not the session token or its full hash). */
  id: string;
  current: boolean;
  createdAt: number;
  lastSeenAt: number;
  ip: string | null;
  userAgent: string | null;
}

/** The signed-in user as the dashboard sees it. */
export interface CurrentUser extends Access {
  id: string;
  username: string;
  twoFactorEnabled: boolean;
  twoFactorSetupRequired: boolean;
}

export interface McVersion {
  id: string;
  type: "release" | "snapshot" | "old_beta" | "old_alpha";
  releaseTime: string;
}

export interface JavaRuntimeInfo {
  path: string;
  major: number;
  version: string;
  vendor: string | null;
  managed: boolean;
}

export interface GameRuleInfo {
  name: string;
  type: "boolean" | "integer";
  value: string | null;
}

export interface PluginInfo {
  file: string;
  enabled: boolean;
  name: string | null;
  version: string | null;
  description: string | null;
  authors: string[];
  apiVersion: string | null;
  depend: string[];
  softDepend: string[];
  main: string | null;
  size: number;
  sha1: string;
  missingDependencies: string[];
  /** Another jar in the same directory that provides the same plugin or mod. */
  duplicateOf?: string | null;
  /** Marketplace project id or slug when installed through CraftPanel. */
  projectId?: string | null;
  source?: "modrinth" | "hangar" | null;
}

export interface WorldInfo {
  name: string;
  active: boolean;
  size: number;
  modifiedAt: number;
  dimensions: string[];
}

export interface ScheduleInfo {
  id: string;
  serverId: string | null;
  name: string;
  cron: string;
  action: ScheduleAction;
  payload: Record<string, unknown>;
  enabled: boolean;
  lastRunAt: number | null;
  lastStatus: string | null;
  nextRunAt: number | null;
  createdAt: number;
}

export type ScheduleAction = "start" | "restart" | "stop" | "backup" | "announce" | "command" | "prune-backups" | "cleanup-logs";

/** What can trigger a notification (Discord / e-mail). */
export const NOTIFICATION_CATEGORIES = ["server", "backup", "schedule", "update"] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

/** What kind of network adapter an address belongs to: this machine, the real LAN, a VPN overlay or a VM/container adapter. */
export type NetworkAddressKind = "local" | "lan" | "vpn" | "virtual";

/** An address players or users can connect to, with a label such as "Local network" or "Virtual adapter (WSL)". */
export interface ConnectAddress {
  /** Host or host:port, ready to copy. */
  address: string;
  kind: NetworkAddressKind;
  label: string;
  interface?: string;
}
