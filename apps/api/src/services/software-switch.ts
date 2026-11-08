import fsp from "node:fs/promises";
import path from "node:path";
import { SOFTWARE_INFO, softwareLabel, type ServerSoftware } from "@craftpanel/shared";
import { getProvider } from "@craftpanel/minecraft-providers";
import type { ServerSandbox } from "@craftpanel/server-runtime";

/**
 * Paper and Purpur up to Minecraft 1.21 keep the Nether and the End in separate folders
 * (world_nether/DIM-1, world_the_end/DIM1); Vanilla and Fabric read them from world/DIM-1 and
 * world/DIM1. Paper converts Vanilla worlds by itself on first start, but nothing converts back,
 * so a switch to Vanilla or Fabric would silently start with an empty Nether and End.
 * From 26.1 on, Paper uses the Vanilla layout (world/dimensions/minecraft/…) and nothing moves.
 */
const SPLIT_DIMENSIONS = [
  { suffix: "_nether", dim: "DIM-1", label: "Nether" },
  { suffix: "_the_end", dim: "DIM1", label: "End" },
] as const;

export interface DimensionMove {
  world: string;
  label: string;
  from: string;
  to: string;
  /** The target already has data, so the move is skipped and the Paper copy kept. */
  conflict: boolean;
}

export const separateDimensionLayout = (software: ServerSoftware) => SOFTWARE_INFO[software].paperCommands;

/** Paper dimension folders that need to move into their world for Vanilla/Fabric. */
export async function findSplitDimensions(sb: ServerSandbox): Promise<DimensionMove[]> {
  const moves: DimensionMove[] = [];
  for (const e of await fsp.readdir(sb.root, { withFileTypes: true }).catch(() => [])) {
    if (!e.isDirectory()) continue;
    for (const d of SPLIT_DIMENSIONS) {
      if (!e.name.endsWith(d.suffix)) continue;
      const world = e.name.slice(0, -d.suffix.length);
      const from = path.posix.join(e.name, d.dim);
      if (!world || !(await sb.exists(path.posix.join(world, "level.dat"))) || !(await sb.exists(from))) continue;
      const to = path.posix.join(world, d.dim);
      moves.push({ world, label: d.label, from, to, conflict: await hasEntries(sb, to) });
    }
  }
  return moves;
}

/** Move Paper's dimension folders back into their worlds; the emptied Paper folder is removed so Paper converts again cleanly later. */
export async function mergeSplitDimensions(sb: ServerSandbox): Promise<DimensionMove[]> {
  const moves = await findSplitDimensions(sb);
  for (const m of moves) {
    if (m.conflict) continue;
    if (await sb.exists(m.to)) await sb.remove(m.to); // an empty placeholder
    await sb.rename(m.from, m.to);
    await sb.remove(path.posix.dirname(m.from));
  }
  return moves;
}

async function hasEntries(sb: ServerSandbox, rel: string) {
  try {
    return (await fsp.readdir(await sb.resolve(rel))).length > 0;
  } catch {
    return false;
  }
}

/** Mojang's version manifest is ordered newest first; Paper, Purpur and Fabric use the same ids. Unknown ids compare numerically. */
export async function isDowngrade(from: string, to: string, known?: string[]): Promise<boolean> {
  if (from === to) return false;
  const order = known ?? (await getProvider("vanilla").listVersions().catch(() => [])).map((v) => v.id);
  const a = order.indexOf(from);
  const b = order.indexOf(to);
  if (a >= 0 && b >= 0) return b > a;
  const nums = (v: string) => v.split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [nums(from), nums(to)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((y[i] ?? 0) !== (x[i] ?? 0)) return (y[i] ?? 0) < (x[i] ?? 0);
  return false;
}

export interface SwitchNote {
  level: "info" | "warn" | "danger";
  text: string;
}

export interface SwitchPreview {
  downgrade: boolean;
  javaMajor: number;
  notes: SwitchNote[];
}

async function countJars(sb: ServerSandbox, dir: string) {
  try {
    return (await fsp.readdir(await sb.resolve(dir))).filter((f) => f.endsWith(".jar") && f !== "CraftPanelInfo.jar").length;
  } catch {
    return 0;
  }
}

/** What a switch from the current software/version to another one does, in words for the dashboard. */
export async function previewSwitch(sb: ServerSandbox, from: { software: ServerSoftware; version: string; javaMajor: number }, to: { software: ServerSoftware; version: string }): Promise<SwitchPreview> {
  const notes: SwitchNote[] = [];
  const [downgrade, java] = await Promise.all([isDowngrade(from.version, to.version), getProvider(to.software).javaRequirement(to.version)]);
  const fromInfo = SOFTWARE_INFO[from.software];
  const toInfo = SOFTWARE_INFO[to.software];
  notes.push({ level: "info", text: "A backup of the whole server is created first. To undo the change, restore it." });
  if (downgrade) notes.push({ level: "danger", text: `Minecraft cannot load worlds saved by a newer version. Going back from ${from.version} to ${to.version} can corrupt or reset chunks; restore a backup from ${to.version} instead if you have one.` });
  else if (to.version !== from.version) notes.push({ level: "info", text: `Worlds are upgraded to ${to.version} on the first start. This can take a while and cannot be undone without the backup.` });
  if (fromInfo.addons && fromInfo.addons !== toInfo.addons) {
    const count = await countJars(sb, fromInfo.addons);
    if (count) notes.push({ level: "warn", text: `${count} ${fromInfo.addons === "mods" ? "mod" : "plugin"}${count === 1 ? "" : "s"} in ${fromInfo.addons}/ won't load on ${toInfo.label}. They stay in the folder.` });
  }
  if (fromInfo.addons && fromInfo.addons === toInfo.addons && to.version !== from.version) {
    const count = await countJars(sb, fromInfo.addons);
    if (count) notes.push({ level: "warn", text: `Check that your ${count} ${fromInfo.addons === "mods" ? "mod" : "plugin"}${count === 1 ? "" : "s"} support Minecraft ${to.version}; the ${fromInfo.addons === "mods" ? "Mods" : "Plugins"} tab shows available updates.` });
  }
  if (separateDimensionLayout(from.software) && !separateDimensionLayout(to.software)) {
    for (const m of await findSplitDimensions(sb)) {
      notes.push(
        m.conflict
          ? { level: "warn", text: `"${m.world}" has a ${m.label} in both ${m.from} and ${m.to}; CraftPanel leaves both alone and ${toInfo.label} uses ${m.to}.` }
          : { level: "info", text: `The ${m.label} of "${m.world}" is moved from ${m.from} back to ${m.to}, where ${toInfo.label} reads it.` },
      );
    }
  }
  if (!separateDimensionLayout(from.software) && separateDimensionLayout(to.software) && !to.version.match(/^(2[6-9]|[3-9]\d)\./))
    notes.push({ level: "info", text: `${toInfo.label} moves the Nether and the End into separate folders (world_nether, world_the_end) on the first start.` });
  if (java.major !== from.javaMajor) notes.push({ level: "info", text: `Needs Java ${java.major} instead of Java ${from.javaMajor}; CraftPanel downloads it if it isn't installed.` });
  if (from.software === "vanilla" && to.software !== "vanilla") notes.push({ level: "info", text: `Worlds, settings and player lists are kept. ${softwareLabel(to.software)} plays like Vanilla with ${toInfo.addons === "mods" ? "mod" : "plugin"} support.` });
  return { downgrade, javaMajor: java.major, notes };
}
