import path from "node:path";
import fsp from "node:fs/promises";
import type { ServerSoftware } from "@craftpanel/shared";
import { download, hashFile, type DownloadProgress } from "./download";
import { getVersionDetail, listVanillaVersions } from "./mojang";
import { listPaperBuilds, listPaperVersions, paperJavaRequirement, resolvePaperBuild } from "./paper";

export interface ProviderVersion {
  id: string;
  stable: boolean;
  releaseTime?: string;
}
export interface ProviderBuild {
  id: string;
  channel: string;
  time: string;
  changes: string[];
}
export interface InstallResult {
  jarFile: string;
  sha: string;
  build: string | null;
}
export type ProgressFn = (stage: string, p: DownloadProgress | null) => void;

/**
 * Adapter for one kind of server software. Fabric, NeoForge and Bedrock
 * Dedicated Server would add implementations here; Bedrock additionally
 * needs a different runtime (native binary, UDP 19132, no Java).
 */
export interface ServerProvider {
  id: ServerSoftware;
  label: string;
  description: string;
  supportsPlugins: boolean;
  listVersions(): Promise<ProviderVersion[]>;
  listBuilds(version: string): Promise<ProviderBuild[]>;
  javaRequirement(version: string): Promise<{ major: number; recommendedFlags: string[] }>;
  install(opts: { directory: string; version: string; build?: string | null; onProgress?: ProgressFn; signal?: AbortSignal }): Promise<InstallResult>;
}

export const vanillaProvider: ServerProvider = {
  id: "vanilla",
  label: "Vanilla",
  description: "The official Minecraft server from Mojang. No plugin support.",
  supportsPlugins: false,
  async listVersions() {
    const { versions } = await listVanillaVersions(false);
    return versions.map((v) => ({ id: v.id, stable: v.type === "release", releaseTime: v.releaseTime }));
  },
  async listBuilds() {
    return [];
  },
  async javaRequirement(version) {
    const d = await getVersionDetail(version);
    return { major: d.javaMajor, recommendedFlags: [] };
  },
  async install({ directory, version, onProgress, signal }) {
    const d = await getVersionDetail(version);
    if (!d.server) throw new Error(`Mojang does not publish a dedicated server for ${version}`);
    const jarFile = "server.jar";
    onProgress?.(`Downloading Minecraft ${version} server`, null);
    await download({
      url: d.server.url,
      destination: path.join(directory, jarFile),
      checksum: { algorithm: "sha1", value: d.server.sha1 },
      onProgress: (p) => onProgress?.(`Downloading Minecraft ${version} server`, p),
      signal,
    });
    return { jarFile, sha: d.server.sha1, build: null };
  },
};

export const paperProvider: ServerProvider = {
  id: "paper",
  label: "Paper",
  description: "High-performance fork of Spigot with Bukkit/Paper plugin support.",
  supportsPlugins: true,
  async listVersions() {
    const versions = await listPaperVersions();
    return versions.map((id) => ({ id, stable: true }));
  },
  async listBuilds(version) {
    const builds = await listPaperBuilds(version);
    return builds
      .sort((a, b) => b.id - a.id)
      .map((b) => ({ id: String(b.id), channel: b.channel, time: b.time, changes: b.changes }));
  },
  async javaRequirement(version) {
    const [paper, mojang] = await Promise.all([paperJavaRequirement(version).catch(() => null), getVersionDetail(version).catch(() => null)]);
    const major = Math.max(paper?.minimum ?? 0, mojang?.javaMajor ?? 0) || 21;
    return { major, recommendedFlags: paper?.flags ?? [] };
  },
  async install({ directory, version, build, onProgress, signal }) {
    const b = await resolvePaperBuild(version, build);
    if (!b.download) throw new Error(`Paper build ${b.id} has no server download`);
    const jarFile = b.download.name.replace(/[^A-Za-z0-9._-]/g, "_");
    onProgress?.(`Downloading Paper ${version} build ${b.id}`, null);
    await download({
      url: b.download.url,
      destination: path.join(directory, jarFile),
      checksum: { algorithm: "sha256", value: b.download.sha256 },
      onProgress: (p) => onProgress?.(`Downloading Paper ${version} build ${b.id}`, p),
      signal,
    });
    return { jarFile, sha: b.download.sha256, build: String(b.id) };
  },
};

export const PROVIDERS: Record<ServerSoftware, ServerProvider> = { vanilla: vanillaProvider, paper: paperProvider };

export function getProvider(id: string): ServerProvider {
  const p = PROVIDERS[id as ServerSoftware];
  if (!p) throw new Error(`Unsupported server software: ${id}`);
  return p;
}

/** Re-verify an installed jar against the recorded checksum. */
export async function verifyInstalledJar(directory: string, jarFile: string, sha: string): Promise<boolean> {
  const algo = sha.length === 40 ? "sha1" : "sha256";
  try {
    await fsp.access(path.join(directory, jarFile));
    return (await hashFile(path.join(directory, jarFile), algo)) === sha;
  } catch {
    return false;
  }
}
