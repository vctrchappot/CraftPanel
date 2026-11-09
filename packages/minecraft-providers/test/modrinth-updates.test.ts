import { afterEach, describe, expect, it, vi } from "vitest";
import { checkModrinthUpdates } from "../src/plugins";

const version = (id: string, type: string, date: string, sha1 = `sha-${id}`) => ({
  id, project_id: "proj", name: id, version_number: id, game_versions: ["1.21.4"], loaders: ["paper"], version_type: type,
  date_published: date, dependencies: [], files: [{ url: "", filename: `${id}.jar`, primary: true, size: 1, hashes: { sha1, sha512: "" } }],
});

function modrinth(routes: { update: object; installed?: object; project?: object[] }) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const body = url.endsWith("/version_files/update") ? routes.update : url.endsWith("/version_files") ? routes.installed : url.includes("/project/proj/version") ? routes.project : null;
    if (body === null || body === undefined) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }));
}

afterEach(() => vi.unstubAllGlobals());

describe("Modrinth update checks", () => {
  it("offers a newer stable release for a stable install, not the suggested beta", async () => {
    modrinth({
      update: { "sha-1.0": version("2.0-beta", "beta", "2026-11-05T00:00:00Z") },
      installed: { "sha-1.0": version("1.0", "release", "2026-10-01T00:00:00Z") },
      project: [version("2.0-beta", "beta", "2026-11-05T00:00:00Z"), version("1.1", "release", "2026-10-20T00:00:00Z"), version("1.0", "release", "2026-10-01T00:00:00Z")],
    });
    expect(await checkModrinthUpdates(["sha-1.0"], "1.21.4")).toEqual({ "sha-1.0": { versionId: "1.1", versionNumber: "1.1", projectId: "proj" } });
  });

  it("offers nothing when only prereleases are newer than the stable install", async () => {
    modrinth({
      update: { "sha-1.0": version("2.0-alpha", "alpha", "2026-11-05T00:00:00Z") },
      installed: { "sha-1.0": version("1.0", "release", "2026-10-01T00:00:00Z") },
      project: [version("2.0-alpha", "alpha", "2026-11-05T00:00:00Z"), version("1.0", "release", "2026-10-01T00:00:00Z")],
    });
    expect(await checkModrinthUpdates(["sha-1.0"], "1.21.4")).toEqual({});
  });

  it("keeps offering newer prereleases to an install that already runs one", async () => {
    modrinth({
      update: { "sha-2.0-beta": version("2.0-beta.2", "beta", "2026-11-06T00:00:00Z") },
      installed: { "sha-2.0-beta": version("2.0-beta", "beta", "2026-11-05T00:00:00Z") },
    });
    expect(await checkModrinthUpdates(["sha-2.0-beta"], "1.21.4")).toEqual({ "sha-2.0-beta": { versionId: "2.0-beta.2", versionNumber: "2.0-beta.2", projectId: "proj" } });
  });

  it("offers stable updates directly and nothing for an up-to-date file", async () => {
    modrinth({ update: { "sha-1.0": version("1.1", "release", "2026-10-20T00:00:00Z"), "sha-3.0": version("3.0", "release", "2026-10-20T00:00:00Z", "sha-3.0") } });
    expect(await checkModrinthUpdates(["sha-1.0", "sha-3.0"], "1.21.4")).toEqual({ "sha-1.0": { versionId: "1.1", versionNumber: "1.1", projectId: "proj" } });
  });
});
