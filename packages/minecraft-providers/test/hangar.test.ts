import { describe, expect, it } from "vitest";
import { assertTrustedUrl } from "../src/download";
import { compatibleHangarVersions, hangarPaperFile, mapHangarProject, toHangarVersion, type HangarVersionRaw } from "../src/hangar";

const sha256 = "5d0ee19b454ba1484a6f877e4028211ac397bc45b45b1d599aabb7a0703395fc";
const version = (over: Partial<HangarVersionRaw> = {}): HangarVersionRaw => ({
  id: 32762,
  projectId: 31,
  name: "5.12.2",
  createdAt: "2026-10-27T19:47:24Z",
  channel: { name: "Release" },
  downloads: {
    PAPER: {
      fileInfo: { name: "ViaVersion-5.12.2.jar", sizeBytes: 6508809, sha256Hash: sha256 },
      externalUrl: null,
      downloadUrl: "https://hangarcdn.papermc.io/plugins/ViaVersion/ViaVersion/versions/5.12.2/PAPER/ViaVersion-5.12.2.jar",
    },
  },
  pluginDependencies: { PAPER: [{ name: "ViaBackwards", projectId: 12, required: false, externalUrl: null }] },
  platformDependencies: { PAPER: ["1.21.10", "1.21.11", "26.3"] },
  ...over,
});

describe("Hangar", () => {
  it("maps projects to marketplace entries with Paper compatibility", () => {
    const p = { id: 31, name: "ViaVersion", namespace: { owner: "ViaVersion", slug: "ViaVersion" }, stats: { downloads: 527637 }, description: "Newer clients on older servers", supportedPlatforms: { PAPER: ["1.21.11"], VELOCITY: ["3.4"] } };
    expect(mapHangarProject(p, "1.21.11")).toMatchObject({ id: "ViaVersion", author: "ViaVersion", downloads: 527637, compatible: true, source: "hangar", iconUrl: null });
    expect(mapHangarProject(p, "1.20.4").compatible).toBe(false);
    expect(mapHangarProject({ ...p, supportedPlatforms: { VELOCITY: ["3.4"] } }, "1.21.11").compatible).toBe(false);
  });

  it("prefers release-channel versions that list the server's Minecraft version", () => {
    const snapshot = version({ id: 33541, name: "5.12.3-SNAPSHOT", createdAt: "2026-11-07T09:00:00Z", channel: { name: "Snapshot" } });
    const old = version({ id: 30000, name: "5.0.0", createdAt: "2025-01-01T00:00:00Z", platformDependencies: { PAPER: ["1.21.4"] } });
    const velocityOnly = version({ id: 31000, downloads: {}, platformDependencies: { VELOCITY: ["3.4"] } });
    const out = compatibleHangarVersions([snapshot, old, velocityOnly, version()], "1.21.11");
    expect(out.map((v) => v.id)).toEqual([32762, 33541]);
    expect(toHangarVersion(out[0])).toEqual({ id: "32762", name: "5.12.2", channel: "Release", published: "2026-10-27T19:47:24Z", mcVersions: ["1.21.10", "1.21.11", "26.3"] });
  });

  it("returns the Paper jar with its SHA-256 from a trusted host", () => {
    const f = hangarPaperFile(version());
    expect(f).toEqual({ url: expect.stringContaining("hangarcdn.papermc.io"), name: "ViaVersion-5.12.2.jar", sha256, size: 6508809 });
    expect(() => assertTrustedUrl(f.url)).not.toThrow();
    expect(() => assertTrustedUrl("https://hangar.papermc.io/api/v1/projects")).not.toThrow();
  });

  it("refuses external-only downloads, odd file names and missing checksums", () => {
    const external = version({ downloads: { PAPER: { fileInfo: null, externalUrl: "https://www.spigotmc.org/resources/luckperms.28140/", downloadUrl: null } } });
    expect(() => hangarPaperFile(external)).toThrow(/external download \(www\.spigotmc\.org\)/);
    const evil = version({ downloads: { PAPER: { fileInfo: { name: "../evil.jar", sizeBytes: 1, sha256Hash: sha256 }, externalUrl: null, downloadUrl: "https://hangarcdn.papermc.io/x.jar" } } });
    expect(() => hangarPaperFile(evil)).toThrow(/file name/);
    const noHash = version({ downloads: { PAPER: { fileInfo: { name: "a.jar", sizeBytes: 1, sha256Hash: "" }, externalUrl: null, downloadUrl: "https://hangarcdn.papermc.io/a.jar" } } });
    expect(() => hangarPaperFile(noHash)).toThrow(/SHA-256/);
    expect(() => hangarPaperFile(version({ downloads: {} }))).toThrow(/no Paper download/);
  });
});
