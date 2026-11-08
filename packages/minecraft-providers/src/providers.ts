import path from "node:path";
import fsp from "node:fs/promises";
import type { ServerSoftware } from "@craftpanel/shared";
import { download, hashFile, type DownloadProgress } from "./download";
import { getVersionDetail, listVanillaVersions } from "./mojang";
import { listPaperBuilds, listPaperVersions, paperJavaRequirement, resolvePaperBuild } from "./paper";
import { getPurpurBuild, listPurpurBuildIds, listPurpurVersions, purpurDownloadUrl, resolvePurpurBuild } from "./purpur";
import { fabricLauncherUrl, listFabricGameVersions, listFabricLoaders, resolveFabricLaunch } from "./fabric";
import { argsFileForPlatform, installNeoForge, neoForgeBuilds, neoForgeGameVersions, resolveNeoForge } from "./neoforge";

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
 * Adapter for one kind of server software. Bedrock Dedicated Server would add
 * an implementation here; it additionally needs a different runtime (native
 * binary, UDP 19132, no Java).
 */
export interface ServerProvider {
  id: ServerSoftware;
  label: string;
  description: string;
  supportsPlugins: boolean;
  listVersions(): Promise<ProviderVersion[]>;
  listBuilds(version: string): Promise<ProviderBuild[]>;
  javaRequirement(version: string): Promise<{ major: number; recommendedFlags: string[] }>;
  /** `javaPath` is a runtime that suits the version; installers that run Java (NeoForge) need it. */
  install(opts: { directory: string; version: string; build?: string | null; javaPath?: string; onProgress?: ProgressFn; signal?: AbortSignal }): Promise<InstallResult>;
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
    const sha = await installVanillaJar(directory, version, onProgress, signal);
    return { jarFile: "server.jar", sha, build: null };
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
  javaRequirement: (version) => paperLikeJava(version),
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

/** Mojang's Java requirement plus Paper's recommended flags (shared by Paper forks). */
async function paperLikeJava(version: string) {
  const [paper, mojang] = await Promise.all([paperJavaRequirement(version).catch(() => null), getVersionDetail(version).catch(() => null)]);
  const major = Math.max(paper?.minimum ?? 0, mojang?.javaMajor ?? 0) || 21;
  return { major, recommendedFlags: paper?.flags ?? [] };
}

/** Download Mojang's server.jar (SHA-1 verified) as `server.jar`. */
async function installVanillaJar(directory: string, version: string, onProgress?: ProgressFn, signal?: AbortSignal) {
  const d = await getVersionDetail(version);
  if (!d.server) throw new Error(`Mojang does not publish a dedicated server for ${version}`);
  onProgress?.(`Downloading Minecraft ${version} server`, null);
  await download({
    url: d.server.url,
    destination: path.join(directory, "server.jar"),
    checksum: { algorithm: "sha1", value: d.server.sha1 },
    onProgress: (p) => onProgress?.(`Downloading Minecraft ${version} server`, p),
    signal,
  });
  return d.server.sha1;
}

export const purpurProvider: ServerProvider = {
  id: "purpur",
  label: "Purpur",
  description: "Paper fork with many extra gameplay options. Runs Bukkit/Paper plugins.",
  supportsPlugins: true,
  async listVersions() {
    const versions = await listPurpurVersions();
    return versions.map((id) => ({ id, stable: true }));
  },
  async listBuilds(version) {
    // Details for the newest builds only: each build is a separate request.
    const ids = (await listPurpurBuildIds(version)).slice(0, 15);
    const builds = await Promise.all(ids.map((id) => getPurpurBuild(version, id).catch(() => null)));
    return builds
      .filter((b) => b !== null)
      .map((b) => ({ id: b.id, channel: b.result === "SUCCESS" ? "STABLE" : b.result, time: b.time, changes: b.changes }));
  },
  javaRequirement: (version) => paperLikeJava(version),
  async install({ directory, version, build, onProgress, signal }) {
    const b = await resolvePurpurBuild(version, build);
    if (!b.md5) throw new Error(`Purpur build ${b.id} has no checksum`);
    const jarFile = `purpur-${version}-${b.id}.jar`.replace(/[^A-Za-z0-9._-]/g, "_");
    const stage = `Downloading Purpur ${version} build ${b.id}`;
    onProgress?.(stage, null);
    await download({ url: purpurDownloadUrl(version, b.id), destination: path.join(directory, jarFile), checksum: { algorithm: "md5", value: b.md5 }, onProgress: (p) => onProgress?.(stage, p), signal });
    return { jarFile, sha: await hashFile(path.join(directory, jarFile), "sha256"), build: b.id };
  },
};

export const fabricProvider: ServerProvider = {
  id: "fabric",
  label: "Fabric",
  description: "Lightweight mod loader. Runs Fabric mods (most also need Fabric API).",
  supportsPlugins: false,
  async listVersions() {
    const versions = await listFabricGameVersions();
    // Fabric also lists snapshots and versions without a dedicated server; offer releases.
    return versions.filter((v) => v.stable && /^\d+(\.\d+)+$/.test(v.version)).map((v) => ({ id: v.version, stable: true }));
  },
  async listBuilds() {
    const loaders = await listFabricLoaders();
    return loaders.slice(0, 30).map((l) => ({ id: l.version, channel: l.stable ? "STABLE" : "BETA", time: "", changes: [] }));
  },
  async javaRequirement(version) {
    const d = await getVersionDetail(version);
    return { major: d.javaMajor, recommendedFlags: [] };
  },
  async install({ directory, version, build, onProgress, signal }) {
    const { loader, installer } = await resolveFabricLaunch(build);
    // The launcher would fetch server.jar itself; downloading it here verifies it and makes the first start faster.
    await installVanillaJar(directory, version, onProgress, signal);
    const jarFile = "fabric-server-launch.jar";
    const stage = `Downloading Fabric Loader ${loader}`;
    onProgress?.(stage, null);
    // Fabric publishes no checksum for the launcher; it comes over HTTPS from Fabric's own meta server.
    await download({ url: fabricLauncherUrl(version, loader, installer), destination: path.join(directory, jarFile), onProgress: (p) => onProgress?.(stage, p), signal, maxBytes: 16 * 1024 * 1024 });
    return { jarFile, sha: await hashFile(path.join(directory, jarFile), "sha256"), build: loader };
  },
};

export const neoforgeProvider: ServerProvider = {
  id: "neoforge",
  label: "NeoForge",
  description: "Mod loader for NeoForge mods and most large modpacks.",
  supportsPlugins: false,
  async listVersions() {
    return (await neoForgeGameVersions()).map((id) => ({ id, stable: true }));
  },
  async listBuilds(version) {
    return (await neoForgeBuilds(version)).slice(0, 30).map((b) => ({ id: b.version, channel: b.stable ? "STABLE" : "BETA", time: "", changes: [] }));
  },
  async javaRequirement(version) {
    const d = await getVersionDetail(version);
    return { major: d.javaMajor, recommendedFlags: [] };
  },
  async install({ directory, version, build, javaPath, onProgress, signal }) {
    if (!javaPath) throw new Error("NeoForge needs Java to run its installer");
    const neoforge = await resolveNeoForge(version, build);
    const argsFile = await installNeoForge({ directory, version: neoforge, javaPath, onProgress, signal });
    // The launch "jar" is the installer's argument file; its hash marks the installed version.
    return { jarFile: argsFile, sha: await hashFile(path.join(directory, argsFileForPlatform(argsFile)), "sha256"), build: neoforge };
  },
};

export const PROVIDERS: Record<ServerSoftware, ServerProvider> = { paper: paperProvider, purpur: purpurProvider, fabric: fabricProvider, neoforge: neoforgeProvider, vanilla: vanillaProvider };

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
