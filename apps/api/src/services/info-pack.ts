import fsp from "node:fs/promises";
import path from "node:path";
import { PropertiesDocument } from "@craftpanel/config";
import { CRAFTPANEL_REPO_URL, CRAFTPANEL_VERSION } from "@craftpanel/shared";

/**
 * A tiny datapack that adds `/trigger craftpanel` to every managed world: any player
 * (no operator rights needed) gets a short info/credits message about CraftPanel.
 * Datapacks work the same on Vanilla and Paper, so no plugin is required.
 */
export const INFO_PACK_DIR = "craftpanel-info";
export const INFO_TRIGGER = "craftpanel";
const MARKER = ".craftpanel-managed";

/** What the info card says about the server it runs on. */
export interface InfoPackDetails {
  software: string;
  mcVersion: string;
}

const SOFTWARE_LABEL: Record<string, string> = { vanilla: "Vanilla", paper: "Paper" };

function text(t: string, extra: Record<string, unknown> = {}) {
  return { text: t, ...extra };
}

function hover(label: string) {
  // Both spellings: `hover_event`/`value` (1.21.5+) and `hoverEvent`/`contents` (older); each version ignores the other.
  return { hover_event: { action: "show_text", value: label }, hoverEvent: { action: "show_text", contents: label } };
}

function link(label: string, url: string, tip: string) {
  return text(label, {
    color: "aqua",
    bold: true,
    click_event: { action: "open_url", url },
    clickEvent: { action: "open_url", value: url },
    ...hover(tip),
  });
}

const rule = (width: number) => text(" ".repeat(width), { color: "dark_gray", strikethrough: true });
const bullet = (label: string, value: unknown[]) => ["", text(" » ", { color: "gold" }), text(label, { color: "gray" }), ...value];

function infoFunction(details: InfoPackDetails): string {
  const software = `${SOFTWARE_LABEL[details.software] ?? details.software} ${details.mcVersion}`;
  const lines: unknown[] = [
    ["", rule(14), text(" ✦ ", { color: "gold" }), text("CraftPanel", { color: "gold", bold: true }), text(" ✦ ", { color: "gold" }), rule(14)],
    ["", text("Hey ", { color: "white" }), { selector: "@s", color: "yellow" }, text("! This server is powered by ", { color: "white" }), text("CraftPanel", { color: "gold" }), text(` v${CRAFTPANEL_VERSION}`, { color: "dark_gray" })],
    bullet("Running ", [text(software, { color: "green" })]),
    bullet("Self-hosted on a ", [text("PC", { color: "aqua" }), text(", ", { color: "gray" }), text("Raspberry Pi", { color: "light_purple" }), text(" or ", { color: "gray" }), text("VPS", { color: "aqua" })]),
    bullet("One-click servers, live console, backups & plugins", []),
    bullet("Free & open source ", [text("(AGPL-3.0)", { color: "dark_gray" })]),
    ["", text(" "), link("[ Get CraftPanel ]", CRAFTPANEL_REPO_URL, "Open the project page"), text("  Made with ", { color: "gray" }), text("❤", { color: "red" }), text(" by vctrchappot", { color: "gray" })],
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
  const load = [`scoreboard objectives add ${INFO_TRIGGER} trigger`, `schedule function craftpanel:poll 10t replace`, ""].join("\n");
  // Re-enable the trigger for everyone (triggers lock after each use) and answer pending requests.
  const poll = [
    `scoreboard players enable @a ${INFO_TRIGGER}`,
    `execute as @a[scores={${INFO_TRIGGER}=1..}] run function craftpanel:info`,
    `schedule function craftpanel:poll 10t replace`,
    "",
  ].join("\n");
  const functions = { "load.mcfunction": load, "poll.mcfunction": poll, "info.mcfunction": infoFunction(details) };
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
