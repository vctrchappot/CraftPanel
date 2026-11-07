import type { McVersion } from "@craftpanel/shared";
import { fetchJson, TtlCache } from "./download";

const MANIFEST_URL = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";

interface Manifest {
  latest: { release: string; snapshot: string };
  versions: (McVersion & { url: string; sha1: string })[];
}

export interface VersionDetail {
  id: string;
  javaMajor: number;
  server: { url: string; sha1: string; size: number } | null;
}

const manifestCache = new TtlCache<Manifest>(10 * 60 * 1000);
const detailCache = new TtlCache<VersionDetail>(60 * 60 * 1000);

export function getManifest(): Promise<Manifest> {
  return manifestCache.get("manifest", () => fetchJson<Manifest>(MANIFEST_URL));
}

export async function listVanillaVersions(includeSnapshots = false): Promise<{ latest: string; versions: McVersion[] }> {
  const m = await getManifest();
  return {
    latest: m.latest.release,
    versions: m.versions
      .filter((v) => v.type === "release" || (includeSnapshots && v.type === "snapshot"))
      .map(({ id, type, releaseTime }) => ({ id, type, releaseTime })),
  };
}

export function getVersionDetail(id: string): Promise<VersionDetail> {
  return detailCache.get(id, async () => {
    const m = await getManifest();
    const v = m.versions.find((x) => x.id === id);
    if (!v) throw new Error(`Unknown Minecraft version ${id}`);
    const d = await fetchJson<{ javaVersion?: { majorVersion: number }; downloads?: { server?: { url: string; sha1: string; size: number } } }>(v.url);
    return {
      id,
      // Versions predating the javaVersion field run on Java 8.
      javaMajor: d.javaVersion?.majorVersion ?? 8,
      server: d.downloads?.server ?? null,
    };
  });
}
