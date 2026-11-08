import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { AddonKind, PluginInfo } from "@craftpanel/shared";
import { readZipEntry } from "@craftpanel/backup";
import { download, fetchJson, USER_AGENT } from "./download";

const MODRINTH = "https://api.modrinth.com/v2";

/** Minimal YAML reader for the flat structure of plugin.yml / paper-plugin.yml. */
export function parsePluginYaml(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lines = text.replace(/\r/g, "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, key, rest] = m;
    const v = rest.replace(/\s+#.*$/, "").trim();
    if (v === "" || v === "|" || v === ">") {
      // Block list ("- a") or nested map; collect list items only.
      const items: string[] = [];
      while (i + 1 < lines.length && /^\s+/.test(lines[i + 1])) {
        const li = /^\s+-\s*(.+)$/.exec(lines[++i]);
        if (li) items.push(unquote(li[1]));
      }
      out[key] = items.length ? items : v === "" ? null : "";
    } else if (v.startsWith("[")) {
      out[key] = v
        .replace(/^\[|\]$/g, "")
        .split(",")
        .map((s) => unquote(s.trim()))
        .filter(Boolean);
    } else out[key] = unquote(v);
  }
  return out;
}

function unquote(s: string): string {
  return s.replace(/^(['"])(.*)\1$/, "$2");
}

const asList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === "string" && v ? [v] : []);

type AddonMeta = Omit<PluginInfo, "missingDependencies"> & { provides: string[] };

export async function inspectPluginJar(file: string): Promise<AddonMeta> {
  const st = await fsp.stat(file);
  const buf = await fsp.readFile(file);
  const sha1 = crypto.createHash("sha1").update(buf).digest("hex");
  let meta: Record<string, unknown> = {};
  try {
    const yml = (await readZipEntry(file, "paper-plugin.yml")) ?? (await readZipEntry(file, "plugin.yml"));
    if (yml) meta = parsePluginYaml(yml.toString("utf8"));
  } catch {
    /* not a valid jar */
  }
  const base = path.basename(file);
  return {
    file: base,
    enabled: base.endsWith(".jar"),
    name: (meta.name as string) ?? null,
    version: meta.version != null ? String(meta.version) : null,
    description: (meta.description as string) ?? null,
    authors: [...asList(meta.author), ...asList(meta.authors)],
    apiVersion: meta["api-version"] != null ? String(meta["api-version"]) : null,
    depend: asList(meta.depend),
    softDepend: asList(meta.softdepend),
    main: (meta.main as string) ?? null,
    provides: asList(meta.provides),
    size: st.size,
    sha1,
  };
}

/** Dependencies every Fabric server provides itself. */
const FABRIC_BUILTINS = new Set(["minecraft", "java", "fabricloader", "fabric-loader"]);

const authorName = (a: unknown) => (typeof a === "string" ? a : a && typeof a === "object" && "name" in a ? String(a.name) : null);
const keysOf = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? Object.keys(v) : []);

/** Read a Fabric mod's fabric.mod.json. */
export async function inspectModJar(file: string): Promise<AddonMeta> {
  const st = await fsp.stat(file);
  const buf = await fsp.readFile(file);
  const sha1 = crypto.createHash("sha1").update(buf).digest("hex");
  let meta: Record<string, unknown> = {};
  try {
    const json = await readZipEntry(file, "fabric.mod.json");
    // Some mods have raw line breaks inside strings, which JSON.parse rejects.
    if (json) meta = JSON.parse(json.toString("utf8").replace(/[\r\n\t]+/g, " "));
  } catch {
    /* not a Fabric mod */
  }
  const id = typeof meta.id === "string" ? meta.id : null;
  const base = path.basename(file);
  return {
    file: base,
    enabled: base.endsWith(".jar"),
    name: typeof meta.name === "string" ? meta.name : id,
    version: meta.version != null ? String(meta.version) : null,
    description: typeof meta.description === "string" ? meta.description : null,
    authors: (Array.isArray(meta.authors) ? meta.authors : []).map(authorName).filter((a): a is string => !!a),
    apiVersion: null,
    depend: keysOf(meta.depends).filter((d) => !FABRIC_BUILTINS.has(d)),
    softDepend: [...keysOf(meta.recommends), ...keysOf(meta.suggests)],
    main: id,
    provides: [...(id ? [id] : []), ...asList(meta.provides)],
    size: st.size,
    sha1,
  };
}

/**
 * List plugins or mods (enabled *.jar and disabled *.jar.disabled) and resolve
 * dependencies. Plugins depend on plugin names, mods on mod ids.
 */
export async function listPlugins(dir: string, kind: AddonKind = "plugins"): Promise<PluginInfo[]> {
  let files: string[] = [];
  try {
    files = (await fsp.readdir(dir)).filter((f) => f.endsWith(".jar") || f.endsWith(".jar.disabled"));
  } catch {
    return [];
  }
  const inspect = kind === "mods" ? inspectModJar : inspectPluginJar;
  const infos = await Promise.all(files.map((f) => inspect(path.join(dir, f))));
  const available = new Set(
    infos
      .filter((p) => p.enabled)
      .flatMap((p) => (kind === "mods" ? p.provides : p.name ? [p.name] : []))
      .map((n) => n.toLowerCase()),
  );
  // Fabric API bundles its modules (fabric-networking-api-v1, …) as nested jars.
  const fabricApi = kind === "mods" && available.has("fabric-api");
  const satisfied = (d: string) => available.has(d.toLowerCase()) || (fabricApi && (d === "fabric" || d.startsWith("fabric-")));
  return infos
    .map(({ provides: _, ...p }) => ({ ...p, missingDependencies: p.depend.filter((d) => !satisfied(d)) }))
    .sort((a, b) => (a.name ?? a.file).localeCompare(b.name ?? b.file));
}

// ---- Modrinth ------------------------------------------------------------

export interface MarketplaceProject {
  id: string;
  slug: string;
  title: string;
  description: string;
  author: string;
  downloads: number;
  iconUrl: string | null;
  categories: string[];
  versions: string[];
  compatible: boolean;
  source: "modrinth" | "hangar";
}

/** Modrinth loaders whose files a server of this kind can load. */
const LOADERS: Record<AddonKind, string[]> = { plugins: ["paper", "spigot", "bukkit", "purpur", "folia"], mods: ["fabric"] };
/** Loaders to ask Modrinth for. */
const QUERY_LOADERS: Record<AddonKind, string[]> = { plugins: ["paper", "spigot", "bukkit"], mods: ["fabric"] };

export async function searchModrinthPlugins(query: string, mcVersion: string, offset = 0, kind: AddonKind = "plugins"): Promise<{ hits: MarketplaceProject[]; total: number }> {
  const facets = JSON.stringify([
    [kind === "mods" ? "project_type:mod" : "project_type:plugin"],
    QUERY_LOADERS[kind].map((l) => `categories:${l}`),
    ["server_side:required", "server_side:optional"],
  ]);
  const url = `${MODRINTH}/search?query=${encodeURIComponent(query)}&limit=20&offset=${offset}&index=${query ? "relevance" : "downloads"}&facets=${encodeURIComponent(facets)}`;
  const d = await fetchJson<{ hits: { project_id: string; slug: string; title: string; description: string; author: string; downloads: number; icon_url: string | null; categories: string[]; versions: string[] }[]; total_hits: number }>(url);
  return {
    total: d.total_hits,
    hits: d.hits.map((h) => ({
      id: h.project_id,
      slug: h.slug,
      title: h.title,
      description: h.description,
      author: h.author,
      downloads: h.downloads,
      iconUrl: h.icon_url,
      categories: h.categories,
      versions: h.versions,
      compatible: h.versions.includes(mcVersion),
      source: "modrinth",
    })),
  };
}

interface ModrinthVersion {
  id: string;
  project_id: string;
  name: string;
  version_number: string;
  game_versions: string[];
  loaders: string[];
  version_type: string;
  date_published: string;
  dependencies: { project_id: string | null; dependency_type: string }[];
  files: { url: string; filename: string; primary: boolean; size: number; hashes: { sha1: string; sha512: string } }[];
}

/** Versions of a project verified compatible with this Minecraft version and the server's loader. */
export async function compatibleModrinthVersions(projectId: string, mcVersion: string, kind: AddonKind = "plugins"): Promise<ModrinthVersion[]> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(projectId)) throw new Error("Invalid project id");
  const url = `${MODRINTH}/project/${projectId}/version?game_versions=${encodeURIComponent(JSON.stringify([mcVersion]))}&loaders=${encodeURIComponent(JSON.stringify(QUERY_LOADERS[kind]))}`;
  const versions = await fetchJson<ModrinthVersion[]>(url);
  return versions.filter((v) => v.game_versions.includes(mcVersion) && v.loaders.some((l) => LOADERS[kind].includes(l)));
}

export async function installModrinthVersion(versionId: string, pluginsDir: string): Promise<{ file: string; requiredDependencies: string[] }> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(versionId)) throw new Error("Invalid version id");
  const v = await fetchJson<ModrinthVersion>(`${MODRINTH}/version/${versionId}`);
  const file = v.files.find((f) => f.primary) ?? v.files[0];
  if (!file) throw new Error("This version has no downloadable file");
  if (!/^[A-Za-z0-9 ._+()-]+\.jar$/.test(file.filename)) throw new Error("Unexpected plugin file name");
  await fsp.mkdir(pluginsDir, { recursive: true });
  await download({ url: file.url, destination: path.join(pluginsDir, file.filename), checksum: { algorithm: "sha512", value: file.hashes.sha512 }, maxBytes: 200 * 1024 * 1024 });
  return { file: file.filename, requiredDependencies: v.dependencies.filter((d) => d.dependency_type === "required" && d.project_id).map((d) => d.project_id!) };
}

/** Ask Modrinth for a newer compatible version of an installed file (identified by SHA-1). */
export async function checkModrinthUpdates(sha1s: string[], mcVersion: string, kind: AddonKind = "plugins"): Promise<Record<string, { versionId: string; versionNumber: string; projectId: string }>> {
  if (!sha1s.length) return {};
  const res = await fetch(`${MODRINTH}/version_files/update`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
    body: JSON.stringify({ hashes: sha1s, algorithm: "sha1", loaders: QUERY_LOADERS[kind], game_versions: [mcVersion] }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Modrinth update check failed (HTTP ${res.status})`);
  const body = (await res.json()) as Record<string, ModrinthVersion>;
  const out: Record<string, { versionId: string; versionNumber: string; projectId: string }> = {};
  for (const [hash, v] of Object.entries(body)) {
    const primary = v.files.find((f) => f.primary) ?? v.files[0];
    if (primary && primary.hashes.sha1 !== hash) out[hash] = { versionId: v.id, versionNumber: v.version_number, projectId: v.project_id };
  }
  return out;
}
