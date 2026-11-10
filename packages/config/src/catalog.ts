/**
 * Catalog of documented server.properties keys. Keys not in this catalog are
 * still preserved and editable in the raw editor.
 */

export type SettingGroup =
  | "general"
  | "gameplay"
  | "players"
  | "world"
  | "network"
  | "performance"
  | "security"
  | "advanced";

export const SETTING_GROUPS: { id: SettingGroup; label: string; description: string }[] = [
  { id: "general", label: "General", description: "Identity and presentation of the server." },
  { id: "gameplay", label: "Gameplay", description: "Game mode, difficulty and core rules." },
  { id: "players", label: "Players", description: "Capacity, access lists and idle behaviour." },
  { id: "world", label: "World generation", description: "Applied when a new world is generated." },
  { id: "network", label: "Network", description: "Binding, ports and query protocols." },
  { id: "performance", label: "Performance", description: "View distance, ticking and compression." },
  { id: "security", label: "Security", description: "Authentication, chat signing and remote access." },
  { id: "advanced", label: "Advanced", description: "Rarely changed settings. Edit with care." },
];

export type SettingType =
  | { kind: "boolean" }
  | { kind: "integer"; min?: number; max?: number }
  | { kind: "string"; maxLength?: number; pattern?: string }
  | { kind: "enum"; options: { value: string; label: string }[] };

export interface SettingDefinition {
  key: string;
  label: string;
  group: SettingGroup;
  type: SettingType;
  default: string;
  help: string;
  /** Changes take effect only after a restart. */
  restart: boolean;
  /** Settings CraftPanel manages itself (e.g. ports are set via Network). */
  managed?: boolean;
  /** The value may span up to two lines (the message of the day); every other setting is a single line. */
  multiline?: boolean;
  /** Minecraft version range this key exists in, when known. */
  since?: string;
  sensitive?: boolean;
}

const bool = { kind: "boolean" } as const;
const int = (min?: number, max?: number) => ({ kind: "integer", min, max }) as const;
const str = (maxLength = 256) => ({ kind: "string", maxLength }) as const;
const opts = (...o: [string, string][]) => ({ kind: "enum", options: o.map(([value, label]) => ({ value, label })) }) as const;

export const SETTINGS: SettingDefinition[] = [
  // General
  { key: "motd", label: "Message of the day", group: "general", type: str(2048), default: "A Minecraft Server", help: "Shown below the server name in the multiplayer list, two lines at most. Supports § colour codes; Appearance has buttons for them.", restart: true, multiline: true },
  { key: "enable-status", label: "Show in server list", group: "general", type: bool, default: "true", help: "When disabled the server appears offline in the multiplayer list but players can still join.", restart: true },
  { key: "hide-online-players", label: "Hide online players", group: "general", type: bool, default: "false", help: "Hide the player sample in the server list.", restart: true },
  { key: "server-name", label: "Server name (legacy)", group: "general", type: str(64), default: "", help: "Not used by modern clients; kept for compatibility with some tools.", restart: true },

  // Gameplay
  { key: "gamemode", label: "Default game mode", group: "gameplay", type: opts(["survival", "Survival"], ["creative", "Creative"], ["adventure", "Adventure"], ["spectator", "Spectator"]), default: "survival", help: "Game mode for new players. Use 'Force game mode' to apply it to everyone on join.", restart: true },
  { key: "force-gamemode", label: "Force game mode", group: "gameplay", type: bool, default: "false", help: "Players are switched to the default game mode every time they join.", restart: true },
  { key: "difficulty", label: "Difficulty", group: "gameplay", type: opts(["peaceful", "Peaceful"], ["easy", "Easy"], ["normal", "Normal"], ["hard", "Hard"]), default: "easy", help: "Can be changed live with /difficulty; this value applies on restart.", restart: true },
  { key: "hardcore", label: "Hardcore", group: "gameplay", type: bool, default: "false", help: "Difficulty is locked to hard and players become spectators when they die.", restart: true },
  { key: "pvp", label: "Player vs player", group: "gameplay", type: bool, default: "true", help: "Allow players to damage each other. Moved to a game rule in recent versions.", restart: true },
  { key: "allow-flight", label: "Allow flight", group: "gameplay", type: bool, default: "false", help: "Prevents survival players using fly mods from being kicked. Enable for flight plugins.", restart: true },
  { key: "spawn-protection", label: "Spawn protection radius", group: "gameplay", type: int(0, 1000), default: "16", help: "Radius around spawn where non-operators cannot build. 0 disables it.", restart: true },
  { key: "allow-nether", label: "Allow the Nether", group: "gameplay", type: bool, default: "true", help: "Allow travel to the Nether dimension.", restart: true },
  { key: "spawn-monsters", label: "Spawn monsters", group: "gameplay", type: bool, default: "true", help: "Removed in recent versions in favour of game rules.", restart: true },
  { key: "generate-structures", label: "Generate structures", group: "world", type: bool, default: "true", help: "Villages, temples and other structures in newly generated chunks.", restart: true },

  // Players
  { key: "max-players", label: "Maximum players", group: "players", type: int(1, 1000), default: "20", help: "Maximum concurrent players. Operators may bypass this if configured.", restart: true },
  { key: "white-list", label: "Whitelist", group: "players", type: bool, default: "false", help: "Only players on the whitelist can join. Toggled live from the Players page.", restart: true },
  { key: "enforce-whitelist", label: "Enforce whitelist", group: "players", type: bool, default: "false", help: "Kick online players who are not on the whitelist when it is reloaded.", restart: true },
  { key: "player-idle-timeout", label: "Idle timeout (minutes)", group: "players", type: int(0, 100000), default: "0", help: "Kick players idle for this many minutes. 0 disables it.", restart: true },
  { key: "op-permission-level", label: "Operator permission level", group: "players", type: opts(["1", "1 — bypass spawn protection"], ["2", "2 — cheat commands"], ["3", "3 — player management"], ["4", "4 — all commands"]), default: "4", help: "Default Minecraft permission level for operators. This is not a CraftPanel permission.", restart: true },
  { key: "function-permission-level", label: "Function permission level", group: "players", type: int(1, 4), default: "2", help: "Permission level for datapack functions.", restart: true },

  // World
  { key: "level-name", label: "Active world", group: "world", type: str(64), default: "world", help: "Folder name of the world to load. Manage worlds from the Worlds page.", restart: true, managed: true },
  { key: "level-seed", label: "Seed", group: "world", type: str(64), default: "", help: "Seed for new worlds. Empty picks a random seed. Has no effect on existing worlds.", restart: true },
  { key: "level-type", label: "World type", group: "world", type: opts(["minecraft:normal", "Default"], ["minecraft:flat", "Superflat"], ["minecraft:large_biomes", "Large biomes"], ["minecraft:amplified", "Amplified"], ["minecraft:single_biome_surface", "Single biome"]), default: "minecraft:normal", help: "Generator for new worlds only.", restart: true },
  { key: "generator-settings", label: "Generator settings", group: "world", type: str(4096), default: "{}", help: "JSON settings for superflat or custom generators.", restart: true },
  { key: "max-world-size", label: "Max world radius", group: "world", type: int(1, 29999984), default: "29999984", help: "Maximum world border radius in blocks.", restart: true },
  { key: "initial-enabled-packs", label: "Enabled datapacks", group: "world", type: str(1024), default: "vanilla", help: "Comma-separated datapacks enabled on world creation.", restart: true },
  { key: "initial-disabled-packs", label: "Disabled datapacks", group: "world", type: str(1024), default: "", help: "Comma-separated datapacks disabled on world creation.", restart: true },

  // Network
  { key: "server-port", label: "Server port", group: "network", type: int(1024, 65535), default: "25565", help: "TCP port Minecraft listens on. Managed from the Network page.", restart: true, managed: true },
  { key: "server-ip", label: "Bind address", group: "network", type: str(64), default: "", help: "Interface to bind to. Empty binds all interfaces. Managed from the Network page.", restart: true, managed: true },
  { key: "network-compression-threshold", label: "Compression threshold", group: "network", type: int(-1, 65535), default: "256", help: "Packets larger than this (bytes) are compressed. -1 disables compression.", restart: true },
  { key: "rate-limit", label: "Packet rate limit", group: "network", type: int(0, 100000), default: "0", help: "Kick clients sending more packets per second. 0 disables it.", restart: true },
  { key: "prevent-proxy-connections", label: "Prevent proxy connections", group: "network", type: bool, default: "false", help: "Kick players whose IP differs from the one Mojang saw at login.", restart: true },
  { key: "enable-query", label: "Enable GameSpy query", group: "network", type: bool, default: "false", help: "UDP query protocol used by some server lists.", restart: true },
  { key: "query.port", label: "Query port", group: "network", type: int(1024, 65535), default: "25565", help: "UDP port for the query protocol.", restart: true },
  { key: "use-native-transport", label: "Native transport", group: "network", type: bool, default: "true", help: "Use optimised Linux networking (epoll) when available.", restart: true },

  // Performance
  { key: "view-distance", label: "View distance", group: "performance", type: int(3, 32), default: "10", help: "Chunks sent to clients. Lower values greatly reduce CPU and RAM.", restart: true },
  { key: "simulation-distance", label: "Simulation distance", group: "performance", type: int(3, 32), default: "10", help: "Chunks around players that are ticked.", restart: true },
  { key: "max-tick-time", label: "Watchdog timeout (ms)", group: "performance", type: int(-1, 600000), default: "60000", help: "Stop the server if a single tick takes longer. -1 disables the watchdog.", restart: true },
  { key: "entity-broadcast-range-percentage", label: "Entity broadcast range %", group: "performance", type: int(10, 1000), default: "100", help: "How far away entities are sent to clients.", restart: true },
  { key: "sync-chunk-writes", label: "Synchronous chunk writes", group: "performance", type: bool, default: "true", help: "Safer but slower chunk saving.", restart: true },
  { key: "max-chained-neighbor-updates", label: "Max chained neighbour updates", group: "performance", type: int(-1, 100000000), default: "1000000", help: "Limit consecutive block updates.", restart: true },
  { key: "region-file-compression", label: "Region file compression", group: "performance", type: opts(["deflate", "Deflate"], ["lz4", "LZ4"], ["none", "None"]), default: "deflate", help: "Compression algorithm for region files (1.20.5+).", restart: true },

  // Security
  { key: "online-mode", label: "Online mode", group: "security", type: bool, default: "true", help: "Verify players with Mojang. Disabling allows impersonation of any player and is strongly discouraged.", restart: true },
  { key: "enforce-secure-profile", label: "Enforce secure profile", group: "security", type: bool, default: "true", help: "Require Mojang-signed public keys for chat.", restart: true },
  { key: "enable-rcon", label: "Enable RCON", group: "security", type: bool, default: "false", help: "Remote console protocol. CraftPanel does not need it. Exposes administrative access if reachable.", restart: true },
  { key: "rcon.port", label: "RCON port", group: "security", type: int(1024, 65535), default: "25575", help: "TCP port for RCON.", restart: true },
  { key: "rcon.password", label: "RCON password", group: "security", type: str(128), default: "", help: "Use a long random password if RCON is enabled.", restart: true, sensitive: true },
  { key: "broadcast-rcon-to-ops", label: "Broadcast RCON to ops", group: "security", type: bool, default: "true", help: "Show RCON command output to online operators.", restart: true },
  { key: "broadcast-console-to-ops", label: "Broadcast console to ops", group: "security", type: bool, default: "true", help: "Show console command output to online operators.", restart: true },
  { key: "log-ips", label: "Log IP addresses", group: "security", type: bool, default: "true", help: "Write player IP addresses to the server log.", restart: true },

  // Advanced
  { key: "enable-command-block", label: "Command blocks", group: "advanced", type: bool, default: "false", help: "Allow command blocks to run.", restart: true },
  { key: "enable-jmx-monitoring", label: "JMX monitoring", group: "advanced", type: bool, default: "false", help: "Expose tick time MBeans via JMX.", restart: true },
  { key: "require-resource-pack", label: "Require resource pack", group: "advanced", type: bool, default: "false", help: "Disconnect players who decline the resource pack.", restart: true },
  { key: "resource-pack", label: "Resource pack URL", group: "advanced", type: str(1024), default: "", help: "Direct download URL to a resource pack zip.", restart: true },
  { key: "resource-pack-sha1", label: "Resource pack SHA-1", group: "advanced", type: str(40), default: "", help: "Lower-case hex SHA-1 of the resource pack.", restart: true },
  { key: "resource-pack-prompt", label: "Resource pack prompt", group: "advanced", type: str(512), default: "", help: "Custom message shown with the resource pack prompt (JSON text).", restart: true },
  { key: "text-filtering-config", label: "Text filtering config", group: "advanced", type: str(1024), default: "", help: "Chat filtering service configuration.", restart: true },
  { key: "pause-when-empty-seconds", label: "Pause when empty (s)", group: "advanced", type: int(-1, 100000), default: "60", help: "Stop ticking after the server has been empty for this many seconds (1.21.2+).", restart: true },
  { key: "accepts-transfers", label: "Accept transfers", group: "advanced", type: bool, default: "false", help: "Accept players transferred from other servers (1.20.5+).", restart: true },
  { key: "bug-report-link", label: "Bug report link", group: "advanced", type: str(512), default: "", help: "URL shown to players in the pause menu.", restart: true },
];

export const SETTINGS_BY_KEY = new Map(SETTINGS.map((s) => [s.key, s]));

/** Validate a value for a key. Returns an error string, or null when valid. */
export function validateSetting(key: string, value: string): string | null {
  const def = SETTINGS_BY_KEY.get(key);
  if (/[\r\n]/.test(value)) {
    if (!def?.multiline) return "Value must be a single line";
    if (/\r/.test(value) || value.split("\n").length > 2) return "At most two lines";
  }
  if (!def) return value.length > 4096 ? "Value too long" : null;
  const t = def.type;
  switch (t.kind) {
    case "boolean":
      return value === "true" || value === "false" ? null : "Must be true or false";
    case "integer": {
      if (!/^-?\d+$/.test(value)) return "Must be a whole number";
      const n = Number(value);
      if (t.min !== undefined && n < t.min) return `Must be at least ${t.min}`;
      if (t.max !== undefined && n > t.max) return `Must be at most ${t.max}`;
      return null;
    }
    case "enum":
      // Allow unknown enum values that already exist (newer versions); UI restricts choice.
      return t.options.some((o) => o.value === value) ? null : `Must be one of ${t.options.map((o) => o.value).join(", ")}`;
    case "string":
      if (t.maxLength !== undefined && value.length > t.maxLength) return `Must be at most ${t.maxLength} characters`;
      return null;
  }
}
