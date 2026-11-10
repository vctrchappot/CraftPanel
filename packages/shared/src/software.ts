import type { PluginInfo } from "./types";

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
  /** The server list can show smooth (hex) colours in the message of the day; vanilla clients get garbled colours. */
  hexMotd: boolean;
  /** Name of a provider build in the UI ("Build", "Loader"). */
  buildLabel: string | null;
  /** A proxy (Velocity): no world, players or server.properties; it forwards players to other servers. */
  proxy: boolean;
}

export const SOFTWARE_INFO: Record<ServerSoftware, SoftwareInfo> = {
  paper: { label: "Paper", addons: "plugins", modLoader: null, paperCommands: true, hexMotd: true, buildLabel: "Build", proxy: false },
  purpur: { label: "Purpur", addons: "plugins", modLoader: null, paperCommands: true, hexMotd: true, buildLabel: "Build", proxy: false },
  fabric: { label: "Fabric", addons: "mods", modLoader: "fabric", paperCommands: false, hexMotd: false, buildLabel: "Loader", proxy: false },
  neoforge: { label: "NeoForge", addons: "mods", modLoader: "neoforge", paperCommands: false, hexMotd: false, buildLabel: "Version", proxy: false },
  vanilla: { label: "Vanilla", addons: null, modLoader: null, paperCommands: false, hexMotd: false, buildLabel: null, proxy: false },
  // Velocity plugins, not Bukkit plugins; its "version" is the Velocity version, not a Minecraft version.
  velocity: { label: "Velocity", addons: "plugins", modLoader: null, paperCommands: false, hexMotd: false, buildLabel: "Build", proxy: true },
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

/** Canonical alphanumeric key for matching an add-on's name, id or slug across sources. */
export function normalizeAddonKey(value: string | null | undefined): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Find an already-installed plugin or mod matching a marketplace entry (by project id, slug, name, mod id or jar stem). */
export function findInstalledAddon<T extends Pick<PluginInfo, "file" | "name" | "main" | "projectId"> & { source?: PluginInfo["source"] }>(
  project: { id: string; slug: string; title: string; source?: "modrinth" | "hangar" },
  plugins: T[],
): T | undefined {
  const idLower = project.id.trim().toLowerCase();
  const slugLower = project.slug.trim().toLowerCase();
  const titleKey = normalizeAddonKey(project.title);
  const slugKey = normalizeAddonKey(project.slug);
  return plugins.find((p) => {
    const pid = p.projectId?.trim().toLowerCase();
    if (pid && (pid === idLower || pid === slugLower)) return true;
    // A jar CraftPanel installed from this very source belongs to another project: a similar name is a coincidence.
    if (pid && p.source && p.source === project.source) return false;
    const nameKey = normalizeAddonKey(p.name);
    if (nameKey && (nameKey === titleKey || nameKey === slugKey)) return true;
    if (p.main && !p.main.includes(".")) {
      const mainKey = normalizeAddonKey(p.main);
      if (mainKey && (mainKey === titleKey || mainKey === slugKey)) return true;
    }
    const fileStemKey = normalizeAddonKey(p.file.replace(/\.jar(\.disabled)?$/i, ""));
    return Boolean(fileStemKey && (fileStemKey === slugKey || fileStemKey === titleKey));
  });
}
