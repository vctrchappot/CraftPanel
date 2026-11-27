import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error plain JavaScript module used by the release workflow
import { compare, parseVersion } from "./release.mjs";

const script = path.join(__dirname, "release.mjs");
const CHANGELOG = "# Changelog\n\n## Unreleased\n\n## 1.1.0 – 2026-11-23\n\n### Added\n- Two.\n\n## 1.0.0 – 2026-11-09\n\n### Fixed\n- One.\n";
const repos: string[] = [];

/** A throwaway repository shaped like this one: root and workspace manifests, a changelog, tags and the script. */
function repo(opts: { version?: string; mirror?: string; changelog?: string; tags?: string[] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-release-"));
  repos.push(dir);
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  const version = opts.version ?? "1.1.0";
  write("package.json", JSON.stringify({ name: "craftpanel", version }, null, 2));
  write("apps/api/package.json", JSON.stringify({ name: "@craftpanel/api", version: opts.mirror ?? version }, null, 2));
  write("packages/shared/package.json", JSON.stringify({ name: "@craftpanel/shared", version }, null, 2));
  write("CHANGELOG.md", opts.changelog ?? CHANGELOG);
  write("scripts/release.mjs", fs.readFileSync(script, "utf8"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("-c", "user.email=t@example.com", "-c", "user.name=t", "add", "-A");
  git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "init");
  for (const tag of opts.tags ?? ["v1.0.0", "v1.1.0"]) git("tag", tag);
  return dir;
}
const run = (dir: string, ...args: string[]) => {
  const r = spawnSync(process.execPath, [path.join(dir, "scripts/release.mjs"), ...args], { cwd: dir, encoding: "utf8" });
  return { code: r.status, out: r.stdout + r.stderr };
};

afterEach(() => {
  for (const dir of repos.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("release versions", () => {
  it("accepts stable versions and release candidates only", () => {
    expect(parseVersion("1.2.0")).toEqual({ major: 1, minor: 2, patch: 0, rc: null });
    expect(parseVersion("v1.2.0-rc.2")).toEqual({ major: 1, minor: 2, patch: 0, rc: 2 });
    for (const bad of ["1.2", "01.2.0", "1.2.0-beta.1", "1.2.0-rc", "1.2.0-rc.0", "1.2.0+build"]) expect(parseVersion(bad)).toBeNull();
  });

  it("orders by SemVer precedence, release candidates before their release and numerically", () => {
    expect(compare("1.10.0", "1.9.9")).toBe(1);
    expect(compare("1.2.0-rc.1", "1.2.0")).toBe(-1);
    expect(compare("1.2.0-rc.10", "1.2.0-rc.2")).toBe(1);
    expect(compare("v1.1.0", "1.1.0")).toBe(0);
  });
});

describe("release.mjs check", () => {
  it("passes for a consistent repository", () => {
    const r = run(repo(), "check");
    expect(r.out).toContain("1.1.0 is consistent");
    expect(r.code).toBe(0);
  });

  it("finds a workspace manifest whose version was changed by hand", () => {
    const r = run(repo({ mirror: "1.2.0" }), "check");
    expect(r.code).toBe(1);
    expect(r.out).toContain("apps/api/package.json has version 1.2.0");
  });

  it("finds a version without its changelog section and without its tag", () => {
    const r = run(repo({ version: "1.2.0" }), "check");
    expect(r.code).toBe(1);
    expect(r.out).toContain('no "## 1.2.0 – date" section');
    expect(r.out).toContain("has no tag v1.2.0");
  });

  it("finds malformed, misordered and missing changelog sections", () => {
    const swapped = "# Changelog\n\n## Unreleased\n\n## 1.0.0 – 2026-11-09\n\n- One.\n\n## 1.1.0 – 2026-11-23\n\n- Two.\n\n## 0.9 – yesterday\n";
    const r = run(repo({ changelog: swapped, tags: ["v0.8.0", "v1.0.0", "v1.1.0"] }), "check");
    expect(r.code).toBe(1);
    expect(r.out).toContain("lists 1.0.0 above 1.1.0");
    expect(r.out).toContain('"## 0.9 – yesterday" is not');
    expect(r.out).toContain("tag v0.8.0 has no section");
    expect(run(repo({ changelog: "# Changelog\n\n## 1.1.0 – 2026-11-23\n" }), "check").out).toContain('start its sections with "## Unreleased"');
  });

  it("lets a release candidate take its notes from Unreleased", () => {
    const pending = CHANGELOG.replace("## Unreleased\n", "## Unreleased\n\n### Added\n- Three.\n");
    const dir = repo({ version: "1.2.0-rc.1", changelog: pending, tags: ["v1.0.0", "v1.1.0", "v1.2.0-rc.1"] });
    expect(run(dir, "check").code).toBe(0);
    const notes = run(dir, "notes");
    expect(notes.out).toContain("Release candidate 1 for 1.2.0");
    expect(notes.out).toContain("- Three.");
    expect(run(repo({ version: "1.2.0-rc.1", tags: ["v1.0.0", "v1.1.0", "v1.2.0-rc.1"] }), "check").out).toContain('"## Unreleased", which is empty');
  });

  it("bump refuses an older version, a non-release branch and an unpushed commit", () => {
    const dir = repo();
    expect(run(dir, "bump", "1.0.5").out).toContain("not newer than the current version 1.1.0");
    expect(run(dir, "bump", "1.1.0").out).toContain("tag v1.1.0 already exists");
    expect(run(dir, "bump", "1.2.0-beta.1").out).toContain("usage");
    // No origin to compare with: only what was pushed (and passed the full CI) can be released.
    expect(run(dir, "bump", "1.2.0").code).toBe(1);
    execFileSync("git", ["switch", "-qc", "feature"], { cwd: dir });
    expect(run(dir, "bump", "1.2.0").out).toContain("release from main or a release/x.y.x branch");
  });

  it("refuses to publish a tag that doesn't match, isn't newer or isn't on main", () => {
    const dir = repo();
    expect(run(dir, "check", "--tag", "v1.0.0").out).toContain("does not match package.json version 1.1.0");
    // In a clone, released commits are on origin/main; a fresh repository without a remote has none.
    expect(run(dir, "check", "--tag", "v1.1.0").out).toContain("is not on main or a release/x.y.x branch");
  });
});
