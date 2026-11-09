import { describe, expect, it } from "vitest";
import { shownRelease } from "../src/lib/github";

const latest = (tag: string) => ({ tag, date: "2026-11-09T00:00:00Z", url: `https://github.com/vctrchappot/CraftPanel/releases/tag/${tag}` });

describe("release shown on the website", () => {
  it("uses GitHub's latest release when it matches this build", () => {
    expect(shownRelease(latest("v1.0.0"), "1.0.0")).toEqual(latest("v1.0.0"));
  });

  it("does not show the previous release while the new one is still being published", () => {
    const r = shownRelease(latest("v1.0.0"), "1.0.1");
    expect(r.tag).toBe("v1.0.1");
    expect(r.date).toBe("");
    expect(r.url).toContain("/releases/tag/v1.0.1");
  });

  it("compares numerically, not as text", () => {
    expect(shownRelease(latest("v1.9.0"), "1.10.0").tag).toBe("v1.10.0");
    expect(shownRelease(latest("v1.10.0"), "1.9.0").tag).toBe("v1.10.0");
  });

  it("falls back to this build's version when GitHub could not be reached", () => {
    expect(shownRelease(null, "2.3.4").tag).toBe("v2.3.4");
  });
});
