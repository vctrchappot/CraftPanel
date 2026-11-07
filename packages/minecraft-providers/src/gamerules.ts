import fsp from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { download } from "./download";
import { getVersionDetail } from "./mojang";

const execFileAsync = promisify(execFile);

export interface GameRuleDefinition {
  name: string;
  type: "boolean" | "integer";
}

interface CommandNode {
  type: string;
  parser?: string;
  children?: Record<string, CommandNode>;
}

/** Extract gamerules and their value types from a Brigadier `commands.json` report. */
export function gamerulesFromCommandTree(tree: CommandNode): GameRuleDefinition[] {
  const gamerule = tree.children?.gamerule;
  if (!gamerule?.children) return [];
  const out: GameRuleDefinition[] = [];
  for (const [name, node] of Object.entries(gamerule.children)) {
    if (node.type !== "literal") continue;
    const arg = Object.values(node.children ?? {}).find((c) => c.type === "argument");
    const parser = arg?.parser ?? "";
    const type = parser === "brigadier:bool" ? "boolean" : parser === "brigadier:integer" ? "integer" : null;
    if (type) out.push({ name, type });
  }
  // Newer versions accept both `name` and `minecraft:name`; keep the short form.
  const names = new Set(out.map((r) => r.name));
  return out.filter((r) => !(r.name.startsWith("minecraft:") && names.has(r.name.slice(10)))).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Determine the gamerules that exist in a specific Minecraft version by
 * running Mojang's built-in data generator (`--reports`) on the official
 * server jar, then reading its command tree. Results are cached per version.
 */
export async function detectGamerules(opts: { mcVersion: string; javaPath: string; cacheDir: string }): Promise<GameRuleDefinition[]> {
  const safeVersion = opts.mcVersion.replace(/[^A-Za-z0-9._-]/g, "_");
  const cacheFile = path.join(opts.cacheDir, "gamerules", `${safeVersion}.json`);
  try {
    return JSON.parse(await fsp.readFile(cacheFile, "utf8")) as GameRuleDefinition[];
  } catch {
    /* not cached */
  }

  const detail = await getVersionDetail(opts.mcVersion);
  if (!detail.server) throw new Error(`No official server jar for ${opts.mcVersion}`);
  const jar = path.join(opts.cacheDir, "jars", `vanilla-${safeVersion}.jar`);
  try {
    await fsp.access(jar);
  } catch {
    await download({ url: detail.server.url, destination: jar, checksum: { algorithm: "sha1", value: detail.server.sha1 } });
  }

  const work = await fsp.mkdtemp(path.join(opts.cacheDir, "datagen-"));
  try {
    const out = path.join(work, "generated");
    // 1.18+ jars are bundlers; older ones (1.13–1.17) expose the generator on the classpath.
    const attempts: string[][] = [
      ["-DbundlerMainClass=net.minecraft.data.Main", "-jar", jar, "--reports", "--output", out],
      ["-cp", jar, "net.minecraft.data.Main", "--reports", "--output", out],
    ];
    let tree: CommandNode | null = null;
    for (const args of attempts) {
      try {
        await execFileAsync(opts.javaPath, ["-Xmx1G", ...args], { cwd: work, timeout: 180_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
        tree = JSON.parse(await fsp.readFile(path.join(out, "reports", "commands.json"), "utf8"));
        break;
      } catch {
        /* try next */
      }
    }
    if (!tree) throw new Error("This Minecraft version does not provide a command report (versions before 1.13 are not supported for gamerule detection)");
    const rules = gamerulesFromCommandTree(tree);
    await fsp.mkdir(path.dirname(cacheFile), { recursive: true });
    await fsp.writeFile(cacheFile, JSON.stringify(rules));
    return rules;
  } finally {
    await fsp.rm(work, { recursive: true, force: true });
  }
}
