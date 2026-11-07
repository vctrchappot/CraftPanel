import { fetchJson, TtlCache } from "./download";

const API = "https://fill.papermc.io/v3/projects/paper";

export interface PaperBuild {
  id: number;
  channel: "STABLE" | "BETA" | "ALPHA" | "RECOMMENDED" | string;
  time: string;
  download: { name: string; url: string; sha256: string; size: number } | null;
  changes: string[];
}

const versionsCache = new TtlCache<string[]>(10 * 60 * 1000);
const buildsCache = new TtlCache<PaperBuild[]>(5 * 60 * 1000);
const javaCache = new TtlCache<{ minimum: number | null; flags: string[] }>(60 * 60 * 1000);

export function listPaperVersions(): Promise<string[]> {
  return versionsCache.get("v", async () => {
    const d = await fetchJson<{ versions: Record<string, string[]> }>(API);
    // Flatten groups, newest first, and keep only final releases (no -rc/-pre).
    return Object.values(d.versions)
      .flat()
      .filter((v) => /^\d+(\.\d+)*$/.test(v));
  });
}

export function listPaperBuilds(version: string): Promise<PaperBuild[]> {
  return buildsCache.get(version, async () => {
    const raw = await fetchJson<
      { id: number; channel: string; time: string; commits?: { message: string }[]; downloads: Record<string, { name: string; url: string; size: number; checksums: { sha256: string } }> }[]
    >(`${API}/versions/${encodeURIComponent(version)}/builds`);
    return raw.map((b) => {
      const d = b.downloads["server:default"];
      return {
        id: b.id,
        channel: b.channel,
        time: b.time,
        download: d ? { name: d.name, url: d.url, sha256: d.checksums.sha256, size: d.size } : null,
        changes: (b.commits ?? []).map((c) => c.message.split("\n")[0]).slice(0, 5),
      };
    });
  });
}

export function paperJavaRequirement(version: string) {
  return javaCache.get(version, async () => {
    const d = await fetchJson<{ version: { java?: { version?: { minimum?: number }; flags?: { recommended?: string[] } } } }>(
      `${API}/versions/${encodeURIComponent(version)}`,
    );
    return { minimum: d.version.java?.version?.minimum ?? null, flags: d.version.java?.flags?.recommended ?? [] };
  });
}

/** Pick the requested build, or the newest stable build when none is given. */
export async function resolvePaperBuild(version: string, build?: string | null): Promise<PaperBuild> {
  const builds = await listPaperBuilds(version);
  if (!builds.length) throw new Error(`Paper has no builds for ${version}`);
  if (build) {
    const b = builds.find((x) => String(x.id) === String(build));
    if (!b) throw new Error(`Paper build ${build} not found for ${version}`);
    return b;
  }
  const stable = builds.filter((b) => b.channel === "STABLE" || b.channel === "RECOMMENDED");
  return (stable.length ? stable : builds).reduce((a, b) => (b.id > a.id ? b : a));
}
