/** Server software CraftPanel can install. The order is the order shown in the dashboard. */
export const SERVER_SOFTWARE = ["paper", "purpur", "fabric", "neoforge", "vanilla", "velocity"] as const;
export type ServerSoftware = (typeof SERVER_SOFTWARE)[number];

/** What a server loads from its add-on folder: Bukkit/Paper plugins, mods (Fabric or NeoForge), or nothing. */
export type AddonKind = "plugins" | "mods";

export interface SoftwareInfo {
  label: string;
  addons: AddonKind | null;
  /** Modrinth loader of the mods it runs (mods of one loader don't load on the other). */
  modLoader: "fabric" | "neoforge" | null;
  /** Paper and its forks answer /tps and /mspt. */
  paperCommands: boolean;
  /** Name of a provider build in the UI ("Build", "Loader"). */
  buildLabel: string | null;
  /** A proxy (Velocity): no world, players or server.properties; it forwards players to other servers. */
  proxy: boolean;
}

export const SOFTWARE_INFO: Record<ServerSoftware, SoftwareInfo> = {
  paper: { label: "Paper", addons: "plugins", modLoader: null, paperCommands: true, buildLabel: "Build", proxy: false },
  purpur: { label: "Purpur", addons: "plugins", modLoader: null, paperCommands: true, buildLabel: "Build", proxy: false },
  fabric: { label: "Fabric", addons: "mods", modLoader: "fabric", paperCommands: false, buildLabel: "Loader", proxy: false },
  neoforge: { label: "NeoForge", addons: "mods", modLoader: "neoforge", paperCommands: false, buildLabel: "Version", proxy: false },
  vanilla: { label: "Vanilla", addons: null, modLoader: null, paperCommands: false, buildLabel: null, proxy: false },
  // Velocity plugins, not Bukkit plugins; its "version" is the Velocity version, not a Minecraft version.
  velocity: { label: "Velocity", addons: "plugins", modLoader: null, paperCommands: false, buildLabel: "Build", proxy: true },
};

export function softwareLabel(software: string): string {
  return SOFTWARE_INFO[software as ServerSoftware]?.label ?? software;
}

/** Folder inside the server directory that holds add-ons, or null when the software has none. */
export function addonDirectory(software: ServerSoftware): string | null {
  return SOFTWARE_INFO[software].addons;
}

/** A build as the dashboard writes it: "#123" for Paper/Purpur builds, the plain version for loaders. */
export function buildName(software: ServerSoftware, build: string): string {
  return SOFTWARE_INFO[software].modLoader ? build : `#${build}`;
}

/** Label of the build choice: "Paper build", "Fabric Loader", "NeoForge version". */
export function buildFieldLabel(software: ServerSoftware): string {
  return software === "fabric" ? "Fabric Loader" : software === "neoforge" ? "NeoForge version" : `${SOFTWARE_INFO[software].label} build`;
}
