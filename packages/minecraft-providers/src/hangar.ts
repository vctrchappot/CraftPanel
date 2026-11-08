import fsp from "node:fs/promises";
import path from "node:path";
import { download, fetchJson } from "./download";
import type { MarketplaceProject } from "./plugins";

/** PaperMC's plugin repository (https://hangar.papermc.io/api-docs). */
const HANGAR = "https://hangar.papermc.io/api/v1";

/** Hangar project slugs (also accepted as project ids by the API). */
export const HANGAR_SLUG = /^[A-Za-z0-9_.-]{1,64}$/;
export const HANGAR_VERSION_ID = /^\d{1,12}$/;

export interface HangarProjectRaw {
  id: number;
  name: string;
  namespace: { owner: string; slug: string };
  stats: { downloads: number };
  description: string;
  avatarUrl?: string | null;
  supportedPlatforms: Record<string, string[]>;
}

interface HangarDownload {
  fileInfo: { name: string; sizeBytes: number; sha256Hash: string } | null;
  externalUrl: string | null;
  downloadUrl: string | null;
}

export interface HangarVersionRaw {
  id: number;
  projectId: number;
  name: string;
  createdAt: string;
  channel: { name: string };
  downloads: Record<string, HangarDownload>;
  pluginDependencies?: Record<string, { name: string; projectId: number | null; required: boolean; externalUrl: string | null }[]>;
  platformDependencies: Record<string, string[]>;
}

export interface HangarVersion {
  id: string;
  name: string;
  channel: string;
  published: string;
  mcVersions: string[];
}

export function mapHangarProject(p: HangarProjectRaw, mcVersion: string): MarketplaceProject {
  const versions = p.supportedPlatforms.PAPER ?? [];
  return {
    id: p.namespace.slug,
    slug: p.namespace.slug,
    title: p.name,
    description: p.description ?? "",
    author: p.namespace.owner,
    downloads: p.stats?.downloads ?? 0,
    iconUrl: null,
    categories: [],
    versions,
    compatible: versions.includes(mcVersion),
    source: "hangar",
  };
}

export async function searchHangarPlugins(query: string, mcVersion: string, offset = 0): Promise<{ hits: MarketplaceProject[]; total: number }> {
  const params = new URLSearchParams({ limit: "20", offset: String(Math.max(0, Math.floor(offset))), platform: "PAPER" });
  if (!query) params.set("sort", "-downloads");
  if (query) params.set("query", query);
  const d = await fetchJson<{ pagination: { count: number }; result: HangarProjectRaw[] }>(`${HANGAR}/projects?${params}`);
  return { total: d.pagination.count, hits: d.result.map((p) => mapHangarProject(p, mcVersion)) };
}

/** Release-channel versions first (newest first), then the rest; only those listing this Minecraft version for Paper. */
export function compatibleHangarVersions(versions: HangarVersionRaw[], mcVersion: string): HangarVersionRaw[] {
  const ok = versions.filter((v) => v.downloads.PAPER && (v.platformDependencies.PAPER ?? []).includes(mcVersion));
  const release = (v: HangarVersionRaw) => (v.channel?.name?.toLowerCase() === "release" ? 0 : 1);
  return [...ok].sort((a, b) => release(a) - release(b) || b.createdAt.localeCompare(a.createdAt));
}

export async function hangarVersions(slug: string, mcVersion: string): Promise<HangarVersionRaw[]> {
  if (!HANGAR_SLUG.test(slug)) throw new Error("Invalid Hangar project");
  const params = new URLSearchParams({ limit: "25", platform: "PAPER", platformVersion: mcVersion });
  const d = await fetchJson<{ result: HangarVersionRaw[] }>(`${HANGAR}/projects/${encodeURIComponent(slug)}/versions?${params}`);
  return compatibleHangarVersions(d.result, mcVersion);
}

export function toHangarVersion(v: HangarVersionRaw): HangarVersion {
  return { id: String(v.id), name: v.name, channel: v.channel?.name ?? "", published: v.createdAt, mcVersions: v.platformDependencies.PAPER ?? [] };
}

/** The Paper jar of a version, or a clear error when Hangar only links to another site. */
export function hangarPaperFile(v: HangarVersionRaw): { url: string; name: string; sha256: string; size: number } {
  const d = v.downloads.PAPER;
  if (!d) throw new Error(`Version ${v.name} has no Paper download`);
  if (!d.fileInfo || !d.downloadUrl) {
    const host = d.externalUrl ? ` (${safeHost(d.externalUrl)})` : "";
    throw new Error(`Version ${v.name} is only offered as an external download${host}. CraftPanel installs files hosted on Hangar only; download it yourself and upload the jar.`);
  }
  if (!/^[A-Za-z0-9 ._+()-]+\.jar$/.test(d.fileInfo.name)) throw new Error("Unexpected plugin file name");
  if (!/^[0-9a-f]{64}$/i.test(d.fileInfo.sha256Hash)) throw new Error(`Version ${v.name} has no SHA-256 checksum`);
  return { url: d.downloadUrl, name: d.fileInfo.name, sha256: d.fileInfo.sha256Hash, size: d.fileInfo.sizeBytes };
}

function safeHost(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return "another site";
  }
}

export async function installHangarVersion(versionId: string, pluginsDir: string): Promise<{ file: string; version: string; requiredDependencies: string[] }> {
  if (!HANGAR_VERSION_ID.test(versionId)) throw new Error("Invalid Hangar version id");
  const v = await fetchJson<HangarVersionRaw>(`${HANGAR}/versions/${versionId}`);
  const file = hangarPaperFile(v);
  await fsp.mkdir(pluginsDir, { recursive: true });
  await download({ url: file.url, destination: path.join(pluginsDir, file.name), checksum: { algorithm: "sha256", value: file.sha256 }, maxBytes: 200 * 1024 * 1024 });
  const deps = (v.pluginDependencies?.PAPER ?? []).filter((d) => d.required).map((d) => d.name);
  return { file: file.name, version: v.name, requiredDependencies: deps };
}
