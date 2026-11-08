import fsp from "node:fs/promises";
import path from "node:path";
import type { ServerSoftware } from "@craftpanel/shared";
import { extractZip, listZip, readZipEntry } from "@craftpanel/backup";
import { download, fetchJson } from "./download";

const MODRINTH = "https://api.modrinth.com/v2";

/** Hosts the .mrpack format allows for file downloads (https://support.modrinth.com/en/articles/8802351). */
const PACK_HOSTS = ["cdn.modrinth.com", "github.com", "raw.githubusercontent.com", "gitlab.com"];
/** Directories a pack may put downloaded files into; anything else (e.g. a server jar at the root) is refused. */
const PACK_DIRS = /^(mods|config|resourcepacks|datapacks|shaderpacks|plugins|kubejs|scripts|defaultconfigs|global_packs)\//;
const MAX_PACK_FILES = 2000;
const MAX_PACK_BYTES = 8 * 1024 ** 3;

export interface MrpackFile {
  path: string;
  hashes: { sha1?: string; sha512?: string };
  env?: { client?: string; server?: string };
  downloads: string[];
  fileSize: number;
}

export interface MrpackIndex {
  formatVersion: number;
  game: string;
  versionId: string;
  name: string;
  summary?: string;
  files: MrpackFile[];
  dependencies: Record<string, string>;
}

export interface ModpackInfo {
  name: string;
  version: string;
  summary: string;
  mcVersion: string;
  software: ServerSoftware;
  /** Fabric Loader version, null for vanilla packs. */
  loader: string | null;
  /** Files the server downloads (client-only ones are skipped). */
  serverFiles: number;
  clientOnlyFiles: number;
  downloadBytes: number;
}

/** Validate a parsed modrinth.index.json and describe what a server built from it needs. */
export function describeModpack(raw: unknown): { index: MrpackIndex; info: ModpackInfo } {
  const index = raw as MrpackIndex;
  if (!index || typeof index !== "object" || index.formatVersion !== 1 || index.game !== "minecraft" || !Array.isArray(index.files) || !index.dependencies)
    throw new Error("This is not a Modrinth modpack (.mrpack) for Minecraft");
  const deps = index.dependencies;
  const mcVersion = deps.minecraft;
  if (!mcVersion || !/^[A-Za-z0-9._+-]{1,64}$/.test(mcVersion)) throw new Error("The modpack does not name a Minecraft version");
  const other = Object.keys(deps).filter((d) => d !== "minecraft" && d !== "fabric-loader");
  if (other.length) {
    const names: Record<string, string> = { forge: "Forge", neoforge: "NeoForge", "quilt-loader": "Quilt" };
    throw new Error(`This modpack needs ${other.map((d) => names[d] ?? d).join(", ")}, which CraftPanel does not support yet. Fabric and vanilla packs work.`);
  }
  const loader = deps["fabric-loader"] ?? null;
  if (loader && !/^[A-Za-z0-9._+-]{1,64}$/.test(loader)) throw new Error("Invalid Fabric Loader version in the modpack");
  if (index.files.length > MAX_PACK_FILES) throw new Error(`The modpack lists too many files (${index.files.length})`);
  const server = index.files.filter((f) => f.env?.server !== "unsupported");
  for (const f of server) checkPackFile(f);
  const downloadBytes = server.reduce((n, f) => n + (f.fileSize || 0), 0);
  if (downloadBytes > MAX_PACK_BYTES) throw new Error("The modpack is too large");
  return {
    index,
    info: {
      name: String(index.name ?? "Modpack").slice(0, 100),
      version: String(index.versionId ?? "").slice(0, 64),
      summary: String(index.summary ?? "").slice(0, 500),
      mcVersion,
      software: loader ? "fabric" : "vanilla",
      loader,
      serverFiles: server.length,
      clientOnlyFiles: index.files.length - server.length,
      downloadBytes,
    },
  };
}

function checkPackFile(f: MrpackFile) {
  if (typeof f.path !== "string" || !PACK_DIRS.test(f.path) || f.path.includes("\\") || f.path.split("/").some((s) => s === ".." || s === "." || s === ""))
    throw new Error(`The modpack wants to write an unexpected file (${String(f.path).slice(0, 100)})`);
  if (!f.hashes?.sha512 || !/^[0-9a-f]{128}$/i.test(f.hashes.sha512)) throw new Error(`${f.path} has no SHA-512 checksum`);
  if (!Array.isArray(f.downloads) || !f.downloads.some(isPackUrl)) throw new Error(`${f.path} is not downloadable from a host Modrinth allows`);
}

function isPackUrl(url: unknown): url is string {
  try {
    const u = new URL(String(url));
    return u.protocol === "https:" && PACK_HOSTS.includes(u.hostname);
  } catch {
    return false;
  }
}

/** Read and validate modrinth.index.json from a .mrpack file. */
export async function readModpack(file: string): Promise<{ index: MrpackIndex; info: ModpackInfo }> {
  let buf: Buffer | null;
  try {
    buf = await readZipEntry(file, "modrinth.index.json", 16 * 1024 * 1024);
  } catch {
    throw new Error("The file is not a valid .mrpack (zip) archive");
  }
  if (!buf) throw new Error("modrinth.index.json is missing; this is not a Modrinth modpack");
  let raw: unknown;
  try {
    raw = JSON.parse(buf.toString("utf8").replace(/^﻿/, ""));
  } catch {
    throw new Error("modrinth.index.json is not valid JSON");
  }
  return describeModpack(raw);
}

export interface ModpackInstallProgress {
  stage: string;
  done: number;
  total: number;
}

/**
 * Put a pack's server files into `directory`: every file not marked server-unsupported is
 * downloaded from an allowed host and checked against its SHA-512, then `overrides/` and
 * `server-overrides/` are extracted (safely; no absolute paths, `..` or symlinks). `resolve` maps a
 * pack path to a file inside `directory` (the server sandbox).
 */
export async function installModpack(
  file: string,
  directory: string,
  resolve: (rel: string) => Promise<string>,
  onProgress?: (p: ModpackInstallProgress) => void,
  signal?: AbortSignal,
): Promise<{ files: number; overrides: number }> {
  const { index } = await readModpack(file);
  const server = index.files.filter((f) => f.env?.server !== "unsupported");
  let done = 0;
  const stage = "Downloading modpack files";
  onProgress?.({ stage, done, total: server.length });
  const queue = [...server];
  const worker = async () => {
    for (let f = queue.shift(); f; f = queue.shift()) {
      const destination = await resolve(f.path);
      const urls = f.downloads.filter(isPackUrl);
      let lastError: unknown;
      for (const url of urls) {
        try {
          await download({ url, destination, checksum: { algorithm: "sha512", value: f.hashes.sha512! }, maxBytes: Math.max(f.fileSize * 2, 1024 * 1024), signal });
          lastError = null;
          break;
        } catch (err) {
          lastError = err;
          if (signal?.aborted) throw err;
        }
      }
      if (lastError) throw new Error(`${f.path}: ${(lastError as Error).message}`);
      onProgress?.({ stage, done: ++done, total: server.length });
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, server.length) }, worker));

  const names = (await listZip(file)).map((e) => e.name);
  let overrides = 0;
  for (const prefix of ["overrides/", "server-overrides/"]) {
    if (!names.some((n) => n.startsWith(prefix) && n.length > prefix.length)) continue;
    onProgress?.({ stage: `Extracting ${prefix.slice(0, -1)}`, done, total: server.length });
    overrides += (await extractZip({ file, destination: directory, stripPrefix: prefix })).files;
  }
  return { files: server.length, overrides };
}

// ---- Modrinth catalogue ------------------------------------------------------------------

export interface ModpackProject {
  id: string;
  slug: string;
  title: string;
  description: string;
  author: string;
  downloads: number;
  iconUrl: string | null;
  versions: string[];
}

export interface ModpackVersion {
  projectId: string;
  id: string;
  name: string;
  versionNumber: string;
  mcVersions: string[];
  loaders: string[];
  published: string;
  fileUrl: string;
  fileSize: number;
  sha512: string;
}

/** Fabric (and vanilla) modpacks on Modrinth that can run on a server. */
export async function searchModpacks(query: string, offset = 0): Promise<{ hits: ModpackProject[]; total: number }> {
  const facets = JSON.stringify([["project_type:modpack"], ["categories:fabric"], ["server_side:required", "server_side:optional"]]);
  const url = `${MODRINTH}/search?query=${encodeURIComponent(query)}&limit=20&offset=${Math.max(0, Math.floor(offset))}&index=${query ? "relevance" : "downloads"}&facets=${encodeURIComponent(facets)}`;
  const d = await fetchJson<{ hits: { project_id: string; slug: string; title: string; description: string; author: string; downloads: number; icon_url: string | null; versions: string[] }[]; total_hits: number }>(url);
  return {
    total: d.total_hits,
    hits: d.hits.map((h) => ({ id: h.project_id, slug: h.slug, title: h.title, description: h.description, author: h.author, downloads: h.downloads, iconUrl: h.icon_url, versions: h.versions })),
  };
}

interface RawVersion {
  project_id: string;
  id: string;
  name: string;
  version_number: string;
  game_versions: string[];
  loaders: string[];
  date_published: string;
  files: { url: string; filename: string; primary: boolean; size: number; hashes: { sha512: string } }[];
}

function toModpackVersion(v: RawVersion): ModpackVersion | null {
  const file = v.files.find((f) => f.primary && f.filename.endsWith(".mrpack")) ?? v.files.find((f) => f.filename.endsWith(".mrpack"));
  if (!file) return null;
  return { projectId: v.project_id, id: v.id, name: v.name, versionNumber: v.version_number, mcVersions: v.game_versions, loaders: v.loaders, published: v.date_published, fileUrl: file.url, fileSize: file.size, sha512: file.hashes.sha512 };
}

/** Fabric versions of a modpack, newest first. */
export async function listModpackVersions(projectId: string): Promise<ModpackVersion[]> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(projectId)) throw new Error("Invalid project id");
  const versions = await fetchJson<RawVersion[]>(`${MODRINTH}/project/${projectId}/version?loaders=${encodeURIComponent(JSON.stringify(["fabric"]))}`);
  return versions.map(toModpackVersion).filter((v): v is ModpackVersion => !!v);
}

/** Download a modpack version's .mrpack (checked against Modrinth's SHA-512) to `destination`. */
export async function downloadModpack(versionId: string, destination: string, signal?: AbortSignal): Promise<ModpackVersion> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(versionId)) throw new Error("Invalid version id");
  const v = toModpackVersion(await fetchJson<RawVersion>(`${MODRINTH}/version/${versionId}`));
  if (!v) throw new Error("This version has no .mrpack file");
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  await download({ url: v.fileUrl, destination, checksum: { algorithm: "sha512", value: v.sha512 }, maxBytes: 1024 ** 3, signal });
  return v;
}
