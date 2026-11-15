import { describe, expect, it } from "vitest";
// @ts-expect-error plain JavaScript module used by the CI workflow
import { classify } from "./ci-changes.mjs";

const only = (files: string[], ...on: string[]) => {
  const r = classify(files) as Record<string, boolean>;
  expect(Object.keys(r).filter((k) => r[k]).sort()).toEqual(on.sort());
};

describe("CI change areas", () => {
  it("runs nothing for docs and other text", () => {
    only(["docs/ROADMAP.md", "CHANGELOG.md", "README.md", "CLAUDE.md", "LICENSE"]);
  });

  it("runs only the website checks for website changes", () => {
    only(["apps/site/src/styles/landing.css", "apps/site/src/content/docs/docs/index.mdx"], "site");
  });

  it("runs the dashboard checks, not the installers, for dashboard-only changes", () => {
    only(["apps/web/src/app/page.tsx"], "app");
    only(["packages/ui/src/button.tsx"], "app", "site");
  });

  it("runs the installers when the API, its packages or the installers change", () => {
    only(["apps/api/src/index.ts"], "app", "install");
    only(["packages/database/src/schema.ts"], "app", "install");
    only(["deploy/install-linux.sh"], "app", "install");
    only(["scripts/release.mjs"], "app", "install");
  });

  it("checks the plugin jar when the plugin or the jar changes", () => {
    only(["plugins/craftpanel-info/src/Main.java"], "app", "plugin");
    only(["apps/api/assets/CraftPanelInfo.jar"], "app", "install", "plugin");
  });

  it("runs every area when dependencies or CI itself change", () => {
    const all = ["app", "install", "plugin", "site"];
    only(["pnpm-lock.yaml"], ...all.filter((a) => a !== "plugin"));
    only([".github/workflows/ci.yml"], ...all);
    only(["scripts/ci-changes.mjs"], ...all);
  });

  it("combines areas and runs everything when asked", () => {
    only(["apps/site/src/pages/index.astro", "apps/web/src/app/page.tsx"], "app", "site");
    expect(Object.values(classify([], { all: true }))).toEqual([true, true, true, true]);
  });
});
