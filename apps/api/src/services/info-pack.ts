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

function text(t: string, extra: Record<string, unknown> = {}) {
  return { text: t, ...extra };
}

function link(label: string, url: string) {
  // Both spellings: `click_event`/`url` (1.21.5+) and `clickEvent`/`value` (older); each version ignores the other.
  return text(label, {
    color: "aqua",
    underlined: true,
    click_event: { action: "open_url", url },
    clickEvent: { action: "open_url", value: url },
  });
}

function infoFunction(): string {
  const lines: unknown[] = [
    ["", text("CraftPanel", { color: "gold", bold: true }), text(` v${CRAFTPANEL_VERSION}`, { color: "gray" })],
    text("This server is managed with CraftPanel, a free and open-source dashboard for running Minecraft servers on your own PC, Raspberry Pi or VPS.", { color: "white" }),
    ["", text("Get it: ", { color: "gray" }), link(CRAFTPANEL_REPO_URL.replace(/^https:\/\//, ""), CRAFTPANEL_REPO_URL)],
  ];
  return [...lines.map((l) => `tellraw @s ${JSON.stringify(l)}`), `scoreboard players set @s ${INFO_TRIGGER} 0`, ""].join("\n");
}

function packFiles(): Record<string, string> {
  const load = [`scoreboard objectives add ${INFO_TRIGGER} trigger`, `schedule function craftpanel:poll 10t replace`, ""].join("\n");
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
export async function syncInfoPack(serverDir: string, enabled: boolean): Promise<boolean> {
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
  for (const [rel, body] of Object.entries(packFiles())) {
    const file = path.join(packDir, rel);
    const current = await fsp.readFile(file, "utf8").catch(() => null);
    if (current === body) continue;
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, body);
    changed = true;
  }
  return changed;
}
