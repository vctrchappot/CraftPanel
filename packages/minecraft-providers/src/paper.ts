import { fetchJson, TtlCache } from "./download";

/** PaperMC's Fill API; Paper and Velocity share it. */
export type FillProject = "paper" | "velocity";
const api = (project: FillProject) => `https://fill.papermc.io/v3/projects/${project}`;

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

export function listPaperVersions(project: FillProject = "paper"): Promise<string[]> {
  return versionsCache.get(project, async () => {
    const d = await fetchJson<{ versions: Record<string, string[]> }>(api(project));
    // Flatten groups, newest first, and keep only final releases (no -rc/-pre).
    return Object.values(d.versions)
      .flat()
      .filter((v) => /^\d+(\.\d+)*$/.test(v));
  });
}

export function listPaperBuilds(version: string, project: FillProject = "paper"): Promise<PaperBuild[]> {
  return buildsCache.get(`${project}/${version}`, async () => {
    const raw = await fetchJson<
      { id: number; channel: string; time: string; commits?: { message: string }[]; downloads: Record<string, { name: string; url: string; size: number; checksums: { sha256: string } }> }[]
    >(`${api(project)}/versions/${encodeURIComponent(version)}/builds`);
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

export function paperJavaRequirement(version: string, project: FillProject = "paper") {
  return javaCache.get(`${project}/${version}`, async () => {
    const d = await fetchJson<{ version: { java?: { version?: { minimum?: number }; flags?: { recommended?: string[] } } } }>(
      `${api(project)}/versions/${encodeURIComponent(version)}`,
    );
    return { minimum: d.version.java?.version?.minimum ?? null, flags: d.version.java?.flags?.recommended ?? [] };
  });
}

/** Pick the requested build, or the newest stable build when none is given. */
export async function resolvePaperBuild(version: string, build?: string | null, project: FillProject = "paper"): Promise<PaperBuild> {
  const label = project === "velocity" ? "Velocity" : "Paper";
  const builds = await listPaperBuilds(version, project);
  if (!builds.length) throw new Error(`${label} has no builds for ${version}`);
  if (build) {
    const b = builds.find((x) => String(x.id) === String(build));
    if (!b) throw new Error(`${label} build ${build} not found for ${version}`);
    return b;
  }
  const stable = builds.filter((b) => b.channel === "STABLE" || b.channel === "RECOMMENDED");
  return (stable.length ? stable : builds).reduce((a, b) => (b.id > a.id ? b : a));
}
