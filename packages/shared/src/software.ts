/** Server software CraftPanel can install. The order is the order shown in the dashboard. */
export const SERVER_SOFTWARE = ["paper", "purpur", "fabric", "vanilla"] as const;
export type ServerSoftware = (typeof SERVER_SOFTWARE)[number];

/** What a server loads from its add-on folder: Bukkit/Paper plugins, Fabric mods, or nothing. */
export type AddonKind = "plugins" | "mods";

export interface SoftwareInfo {
  label: string;
  addons: AddonKind | null;
  /** Paper and its forks answer /tps and /mspt. */
  paperCommands: boolean;
  /** Name of a provider build in the UI ("Build", "Loader"). */
  buildLabel: string | null;
}

export const SOFTWARE_INFO: Record<ServerSoftware, SoftwareInfo> = {
  paper: { label: "Paper", addons: "plugins", paperCommands: true, buildLabel: "Build" },
  purpur: { label: "Purpur", addons: "plugins", paperCommands: true, buildLabel: "Build" },
  fabric: { label: "Fabric", addons: "mods", paperCommands: false, buildLabel: "Loader" },
  vanilla: { label: "Vanilla", addons: null, paperCommands: false, buildLabel: null },
};

export function softwareLabel(software: string): string {
  return SOFTWARE_INFO[software as ServerSoftware]?.label ?? software;
}

/** Folder inside the server directory that holds add-ons, or null when the software has none. */
export function addonDirectory(software: ServerSoftware): string | null {
  return SOFTWARE_INFO[software].addons;
}
