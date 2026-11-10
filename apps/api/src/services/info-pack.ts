import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readZipEntry } from "@craftpanel/backup";
import { PropertiesDocument } from "@craftpanel/config";
import { CRAFTPANEL_AUTHOR, CRAFTPANEL_REPO_URL, CRAFTPANEL_VERSION, ROTATION_INFO_OFF_FILE, softwareLabel } from "@craftpanel/shared";

/**
 * In-game info card about CraftPanel, enabled by default and removable globally or per server.
 *  - A tiny datapack adds `/trigger craftpanel` to every managed world (Vanilla and Paper,
 *    no operator rights needed). It holds the card itself.
 *  - On Paper, a ~2 KB plugin (plugins/craftpanel-info) adds the nicer `/craftpanel`, which
 *    simply runs the datapack's function for the player. Datapacks can't register commands.
 *
 * The card reads CraftPanel's version and the server software from command storage instead of having them
 * written into its text. A running server keeps the datapack it loaded at start, and servers outlive
 * CraftPanel updates, so CraftPanel pushes fresh values into the storage of running servers (see
 * infoStorageCommand) while load.mcfunction sets them again on every start and reload.
 */
export const INFO_PACK_DIR = "craftpanel-info";
export const INFO_TRIGGER = "craftpanel";
const MARKER = ".craftpanel-managed";
const INFO_STORAGE = "craftpanel:info";

/** What the info card says about the server it runs on. */
export interface InfoPackDetails {
  software: string;
  mcVersion: string;
}

function text(t: string, extra: Record<string, unknown> = {}) {
  return { text: t, ...extra };
}

function hover(label: string) {
  // Both spellings: `hover_event`/`value` (1.21.5+) and `hoverEvent`/`contents` (older); each version ignores the other.
  return { hover_event: { action: "show_text", value: label }, hoverEvent: { action: "show_text", contents: label } };
}

function link(label: string, url: string, tip: string, bold = true) {
  return text(label, {
    color: "aqua",
    bold,
    click_event: { action: "open_url", url },
    clickEvent: { action: "open_url", value: url },
    ...hover(tip),
  });
}

const rule = (width: number) => text(" ".repeat(width), { color: "dark_gray", strikethrough: true });
const bullet = (label: string, value: unknown[]) => ["", text(" » ", { color: "gold" }), text(label, { color: "gray" }), ...value];

/** Values the card shows, as the SNBT compound merged into the card's command storage. */
function infoStorageValue(details: InfoPackDetails): string {
  return `{version:${JSON.stringify(CRAFTPANEL_VERSION)},software:${JSON.stringify(`${softwareLabel(details.software)} ${details.mcVersion}`)}}`;
}

/** Console command that updates the card of a server that is already running. */
export function infoStorageCommand(details: InfoPackDetails): string {
  return `data merge storage ${INFO_STORAGE} ${infoStorageValue(details)}`;
}

const stored = (path: string, color: string) => ({ nbt: path, storage: INFO_STORAGE, color });

function infoFunction(): string {
  const lines: unknown[] = [
    ["", rule(14), text(" ✦ ", { color: "gold" }), text("CraftPanel", { color: "gold", bold: true }), text(" ✦ ", { color: "gold" }), rule(14)],
    ["", text("Hey ", { color: "white" }), { selector: "@s", color: "yellow" }, text("! This server is powered by ", { color: "white" }), text("CraftPanel", { color: "gold" }), text(" v", { color: "dark_gray" }), stored("version", "dark_gray")],
    bullet("Running ", [stored("software", "green")]),
    bullet("Self-hosted on a ", [text("PC", { color: "aqua" }), text(", ", { color: "gray" }), text("Raspberry Pi", { color: "light_purple" }), text(" or ", { color: "gray" }), text("VPS", { color: "aqua" })]),
    bullet("One-click servers, live console, backups & plugins", []),
    bullet("Free to use and modify ", [text("(FSL-1.1-ALv2)", { color: "dark_gray" })]),
    ["", text(" "), link("[ Get CraftPanel ]", CRAFTPANEL_REPO_URL, "Open the project on GitHub")],
    [
      "",
      text(" Made with ", { color: "gray" }),
      text("❤", { color: "red" }),
      text(" by ", { color: "gray" }),
      link(`${CRAFTPANEL_AUTHOR.name} (@${CRAFTPANEL_AUTHOR.handle})`, CRAFTPANEL_AUTHOR.github, "Developer on GitHub", false),
      text(" · ", { color: "dark_gray" }),
      link(CRAFTPANEL_AUTHOR.website.replace(/^https:\/\//, ""), CRAFTPANEL_AUTHOR.website, "Developer's website", false),
    ],
    ["", rule(42)],
  ];
  return [
    ...lines.map((l) => `tellraw @s ${JSON.stringify(l)}`),
    `playsound minecraft:entity.experience_orb.pickup master @s ~ ~ ~ 0.6 1.4`,
    `scoreboard players set @s ${INFO_TRIGGER} 0`,
    "",
  ].join("\n");
}

function packFiles(details: InfoPackDetails): Record<string, string> {
  const load = [`data merge storage ${INFO_STORAGE} ${infoStorageValue(details)}`, `scoreboard objectives add ${INFO_TRIGGER} trigger`, `schedule function craftpanel:poll 10t replace`, ""].join("\n");
  // Re-enable the trigger for everyone (triggers lock after each use) and answer pending requests.
  const poll = [
    `scoreboard players enable @a ${INFO_TRIGGER}`,
    `execute as @a[scores={${INFO_TRIGGER}=1..}] run function craftpanel:info`,
    `schedule function craftpanel:poll 10t replace`,
    "",
  ].join("\n");
  const functions = { "load.mcfunction": load, "poll.mcfunction": poll, "info.mcfunction": infoFunction() };
  const loadTag = JSON.stringify({ values: ["craftpanel:load"] });

  const files: Record<string, string> = {
    "pack.mcmeta": JSON.stringify(
      {
        pack: {
          description: `CraftPanel info command: /trigger ${INFO_TRIGGER}`,
          // 1.20.x reads pack_format/supported_formats, 1.21.9+ reads min_format/max_format.
          pack_format: 15,
          supported_formats: { min_inclusive: 15, max_inclusive: 999 },
          min_format: 15,
          max_format: 999,
        },
      },
      null,
      2,
    ),
    [MARKER]: "Managed by CraftPanel. Disable the in-game info command in CraftPanel's settings to remove this pack.\n",
  };
  // Folder names were singularised in 1.21 (`functions` → `function`); ship both layouts.
  for (const dir of ["function", "functions"]) {
    for (const [name, body] of Object.entries(functions)) files[`data/craftpanel/${dir}/${name}`] = body;
    files[`data/minecraft/tags/${dir}/load.json`] = loadTag;
  }
  return files;
}

async function levelName(serverDir: string): Promise<string> {
  try {
    const doc = PropertiesDocument.parse(await fsp.readFile(path.join(serverDir, "server.properties"), "utf8"));
    return doc.get("level-name") || "world";
  } catch {
    return "world";
  }
}

/** Install, update or remove the info datapack in the server's active world. Returns true if anything changed. */
export async function syncInfoPack(serverDir: string, enabled: boolean, details: InfoPackDetails): Promise<boolean> {
  const level = await levelName(serverDir);
  // level-name may point anywhere; only touch a world directory inside the server directory.
  const worldDir = path.resolve(serverDir, level);
  if (path.relative(serverDir, worldDir).startsWith("..") || path.isAbsolute(path.relative(serverDir, worldDir))) return false;
  const packDir = path.join(worldDir, "datapacks", INFO_PACK_DIR);

  if (!enabled) {
    try {
      await fsp.access(path.join(packDir, MARKER));
    } catch {
      return false; // not ours or not installed
    }
    await fsp.rm(packDir, { recursive: true, force: true });
    return true;
  }

  let changed = false;
  for (const [rel, body] of Object.entries(packFiles(details))) {
    const file = path.join(packDir, rel);
    const current = await fsp.readFile(file, "utf8").catch(() => null);
    if (current === body) continue;
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, body);
    changed = true;
  }
  return changed;
}

// ---- Paper plugin: /craftpanel ---------------------------------------------------

export const INFO_PLUGIN_FILE = "CraftPanelInfo.jar";
const INFO_PLUGIN_MAIN = "site.vctr.craftpanel.CraftPanelInfo";

/** Bundled jar: dist/assets next to the bundle, or apps/api/assets when running from source. */
function bundledPluginPath(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [path.join(here, "assets", INFO_PLUGIN_FILE), path.resolve(here, "../../assets", INFO_PLUGIN_FILE)]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** True when a plugins/ file is CraftPanel's own info plugin (checked by its main class, not just the name). */
export async function isInfoPlugin(file: string): Promise<boolean> {
  const yml = await readZipEntry(file, "plugin.yml").catch(() => null);
  return !!yml && yml.toString("utf8").includes(`main: ${INFO_PLUGIN_MAIN}`);
}

/**
 * Install/update or remove the CraftPanel plugin in a Paper server's plugins/ folder. It is wanted while the in-game
 * info command is on or the server has rotating messages; with `infoCommand` off it stays only for the messages and
 * a marker file tells it to hide /craftpanel. A copy the user disabled in the Plugins tab (.jar.disabled) is left alone.
 */
export async function syncInfoPlugin(serverDir: string, enabled: boolean, source = bundledPluginPath(), infoCommand = true): Promise<boolean> {
  const pluginsDir = path.join(serverDir, "plugins");
  const target = path.join(pluginsDir, INFO_PLUGIN_FILE);
  const marker = path.join(serverDir, ...ROTATION_INFO_OFF_FILE.split("/"));
  if (!enabled || infoCommand) await fsp.rm(marker, { force: true });
  if (!enabled) {
    if (!(await exists(target)) || !(await isInfoPlugin(target))) return false;
    await fsp.rm(target);
    return true;
  }
  if (!infoCommand) {
    await fsp.mkdir(path.dirname(marker), { recursive: true });
    await fsp.writeFile(marker, "CraftPanel keeps this plugin for the rotating server list messages only; /craftpanel is switched off.\n");
  }
  if (!source || (await exists(`${target}.disabled`))) return false;
  const wanted = await fsp.readFile(source);
  const current = await fsp.readFile(target).catch(() => null);
  if (current && Buffer.compare(current, wanted) === 0) return false;
  if (current && !(await isInfoPlugin(target))) return false; // someone else's jar with the same name
  await fsp.mkdir(pluginsDir, { recursive: true });
  await fsp.writeFile(target, wanted);
  return true;
}

const exists = (p: string) => fsp.access(p).then(() => true, () => false);
