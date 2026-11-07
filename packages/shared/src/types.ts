import type { Role } from "./roles";

export type ServerSoftware = "vanilla" | "paper";
export type Edition = "java";
export type NetworkMode = "lan" | "wan";

/**
 * Runtime state of a managed server. `orphaned` means a process from a
 * previous CraftPanel run is still alive but we no longer own its stdin.
 */
export type ServerStatus =
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
}

export interface ServerDetail extends ServerSummary {
  directory: string;
  /** In-game info command override: null follows the global setting. */
  infoCommand: boolean | null;
  javaMajor: number;
  javaPath: string | null;
  jvmArgs: string;
  bindAddress: string;
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
  | { type: "error"; message: string };

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
