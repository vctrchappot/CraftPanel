import type { ActivityEvent } from "@craftpanel/shared";

/** Colour of an activity icon: the server status palette, plus neutral for everything that isn't a lifecycle state. */
export type EventTone = "running" | "starting" | "stopped" | "crashed" | "warning" | "neutral";

/** Icon names, resolved to lucide components in the activity list (kept as strings so this stays pure and testable). */
export type EventIcon =
  | "online"
  | "start"
  | "restart"
  | "stop"
  | "stopped"
  | "kill"
  | "lost"
  | "crashed"
  | "error"
  | "warning"
  | "created"
  | "deleted"
  | "install"
  | "software"
  | "update"
  | "backup"
  | "restore"
  | "config"
  | "performance"
  | "player"
  | "world"
  | "pregen"
  | "plugin"
  | "proxy"
  | "secret"
  | "schedule"
  | "network"
  | "java"
  | "info";

export interface EventStyle {
  tone: EventTone;
  icon: EventIcon;
}

/** Exact event kinds (see ActivityService.event calls in apps/api). */
const BY_KIND: Record<string, EventStyle> = {
  "server.running": { tone: "running", icon: "online" },
  "server.start": { tone: "starting", icon: "start" },
  "server.restart": { tone: "starting", icon: "restart" },
  "server.stop": { tone: "stopped", icon: "stop" },
  "server.stopped": { tone: "stopped", icon: "stopped" },
  "server.kill": { tone: "stopped", icon: "kill" },
  "server.orphan_stopped": { tone: "stopped", icon: "kill" },
  "server.lost": { tone: "stopped", icon: "lost" },
  "runtime.stop_all": { tone: "stopped", icon: "stop" },
  "server.crashed": { tone: "crashed", icon: "crashed" },
  "server.error": { tone: "crashed", icon: "error" },
  "server.orphaned": { tone: "warning", icon: "warning" },
  "server.created": { tone: "neutral", icon: "created" },
  "server.deleted": { tone: "neutral", icon: "deleted" },
  "server.installed": { tone: "neutral", icon: "install" },
  "server.modpack_installed": { tone: "neutral", icon: "install" },
  "server.software_changed": { tone: "neutral", icon: "software" },
  "server.performance_preset": { tone: "neutral", icon: "performance" },
  "backup.restored": { tone: "neutral", icon: "restore" },
  "world.deleted": { tone: "neutral", icon: "deleted" },
  "world.pregen_started": { tone: "neutral", icon: "pregen" },
  "plugin.removed": { tone: "neutral", icon: "deleted" },
  "proxy.secret_regenerated": { tone: "neutral", icon: "secret" },
  "java.installed": { tone: "neutral", icon: "java" },
};

/** Icon per kind prefix ("backup.completed" → backup) for the neutral events. */
const BY_PREFIX: Record<string, EventIcon> = {
  backup: "backup",
  config: "config",
  gamerule: "config",
  player: "player",
  world: "world",
  plugin: "plugin",
  proxy: "proxy",
  schedule: "schedule",
  ddns: "network",
  craftpanel: "update",
  java: "java",
};

/**
 * How an activity event is drawn: lifecycle events use the server status colours (online = Signal, starting =
 * Amber, stopped = Ash, crashed/error = Ember); updates, installs, backups, configuration and the rest are neutral.
 * Unlisted errors are Ember and failures or warnings Amber, so they never look harmless.
 */
export function eventStyle(e: Pick<ActivityEvent, "kind" | "level">): EventStyle {
  const exact = BY_KIND[e.kind];
  if (exact) return exact;
  if (e.level === "error") return { tone: "crashed", icon: "error" };
  if (/(_failed|\.failed|\.error)$/.test(e.kind)) return { tone: "warning", icon: "warning" };
  const icon = BY_PREFIX[e.kind.split(".")[0]];
  if (icon) return { tone: "neutral", icon };
  return e.level === "warn" ? { tone: "warning", icon: "warning" } : { tone: "neutral", icon: "info" };
}
