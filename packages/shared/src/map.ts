import { z } from "zod";

/**
 * The live map (BlueMap, installed and configured by CraftPanel). Every setting is a limit or a switch that
 * keeps the map cheap to render, small on disk and safe to share.
 */

export const MAP_SPEEDS = ["gentle", "balanced", "fast"] as const;
export type MapSpeed = (typeof MAP_SPEEDS)[number];

export const MAP_ACCESS = ["login", "public"] as const;
export type MapAccess = (typeof MAP_ACCESS)[number];

/** Radii offered in the dashboard; 0 renders everything that was ever generated. */
export const MAP_RADIUS_PRESETS = [1000, 3000, 5000, 10000, 0] as const;

export interface MapSettings {
  /** Who may open the map: signed-in CraftPanel users with access to the server, or anyone who can reach CraftPanel. */
  access: MapAccess;
  /** Blocks around the centre that are rendered; 0 = the whole world. */
  radius: number;
  centerX: number;
  centerZ: number;
  overworld: boolean;
  nether: boolean;
  end: boolean;
  /** "3d": flat and 3D views with every block; "2d": a flat top-down map, far smaller and quicker to render. */
  detail: "3d" | "2d";
  /** Render the caves too (much more data) instead of just the surface. */
  caves: boolean;
  /** Only areas where players have spent time; keeps pre-generated wilderness off the map. */
  visitedOnly: boolean;
  speed: MapSpeed;
  /** Pause rendering when this many players are online; 0 disables the threshold. */
  pauseAtPlayers: number;
  /** Show where players are, live. */
  players: boolean;
  hideSneaking: boolean;
  /** Rendering pauses when the map data reaches this size (MB); 0 = no limit. */
  maxDiskMb: number;
}

export const DEFAULT_MAP_SETTINGS: MapSettings = {
  access: "login",
  radius: 3000,
  centerX: 0,
  centerZ: 0,
  overworld: true,
  nether: true,
  end: true,
  detail: "3d",
  caves: false,
  visitedOnly: false,
  speed: "gentle",
  pauseAtPlayers: 10,
  players: true,
  hideSneaking: true,
  maxDiskMb: 5120,
};

const coordinate = z.number().int().min(-30_000_000).max(30_000_000);

export const mapSettingsSchema = z
  .object({
    access: z.enum(MAP_ACCESS),
    radius: z.number().int().min(0).max(30_000_000),
    centerX: coordinate,
    centerZ: coordinate,
    overworld: z.boolean(),
    nether: z.boolean(),
    end: z.boolean(),
    detail: z.enum(["3d", "2d"]),
    caves: z.boolean(),
    visitedOnly: z.boolean(),
    speed: z.enum(MAP_SPEEDS),
    pauseAtPlayers: z.number().int().min(0).max(100_000),
    players: z.boolean(),
    hideSneaking: z.boolean(),
    maxDiskMb: z.number().int().min(0).max(10_000_000),
    /** A new password for the public map; "" removes it, undefined keeps what is set. */
    password: z.string().max(128).optional(),
  })
  .refine((s) => s.overworld || s.nether || s.end, { message: "Show at least one dimension", path: ["overworld"] })
  .refine((s) => s.radius === 0 || s.radius >= 100, { message: "Use a radius of at least 100 blocks, or 0 for the whole world", path: ["radius"] });

export type MapSettingsInput = z.infer<typeof mapSettingsSchema>;

export const mapInstallSchema = z.object({
  /** BlueMap downloads Minecraft's client files from Mojang, which needs the owner's agreement to Mojang's EULA. */
  acceptMojangEula: z.literal(true, { message: "Accept Mojang's EULA to let the map download Minecraft's textures" }),
});

export interface MapStatus {
  /** False for servers BlueMap cannot run on (Vanilla, proxies); `reason` says why. */
  supported: boolean;
  reason: string | null;
  installed: boolean;
  /** The map navigation is revealed only after BlueMap has served a working viewer once. */
  pageReady: boolean;
  setupStage: "installing" | "starting" | "preparing" | null;
  setupError: string | null;
  /** The BlueMap jar's file name, e.g. "bluemap-5.16-spigot.jar". */
  file: string | null;
  settings: MapSettings;
  passwordSet: boolean;
  /** BlueMap has started once and written its own configuration, so area, quality and dimension settings can apply. */
  configReady: boolean;
  /** The server must restart for BlueMap to load, or to notice a change. */
  restartRequired: boolean;
  serverRunning: boolean;
  /** Whether BlueMap's web server answers on its local port right now. */
  webserver: boolean;
  diskBytes: number;
  /** Rendering was stopped because the map data reached `settings.maxDiskMb`. */
  diskLimitHit: boolean;
  paused: boolean;
  rerenderRequired: boolean;
  /** Path of the map viewer on this CraftPanel ("/map/<id>/"), or null when it cannot be opened. */
  url: string | null;
  /** Who can reach CraftPanel at all, which bounds who can open a public map. */
  reach: "this computer" | "private networks and VPNs" | "anywhere";
  /** Render threads the chosen speed means on this machine. */
  threads: number;
  cores: number;
  memoryMb: number;
  warnings: string[];
}
