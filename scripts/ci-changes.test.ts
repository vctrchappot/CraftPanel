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
    only(["apps/api/src/index.ts"], "app", "install", "service");
    only(["packages/database/src/schema.ts"], "app", "install", "service");
    only(["deploy/install-linux.sh"], "app", "install", "service");
    only(["scripts/release.mjs"], "app", "install", "service");
  });

  it("checks the plugin jar when the plugin or the jar changes", () => {
    only(["plugins/craftpanel-info/src/Main.java"], "app", "plugin");
    only(["apps/api/assets/CraftPanelInfo.jar"], "app", "install", "service", "plugin");
  });

  it("runs every area when dependencies or CI itself change", () => {
    const all = ["app", "install", "plugin", "service", "site"];
    only(["pnpm-lock.yaml"], ...all.filter((a) => a !== "plugin"));
    only([".github/workflows/ci.yml"], ...all);
    only(["scripts/ci-changes.mjs"], ...all);
  });

  it("runs the Linux service scenarios when they or what they test change, not for other scenarios", () => {
    only(["scripts/real-tests/isolation.mjs"], "app", "service");
    only(["scripts/real-tests/app-migration-service.mjs"], "app", "install", "service");
    only(["scripts/real-tests/neoforge.mjs"], "app");
  });

  it("runs the areas a manual run picked, whatever changed", () => {
    expect(classify(["docs/ROADMAP.md"], { only: ["service", "site"] })).toEqual({ app: false, install: false, plugin: false, service: true, site: true });
    expect(Object.values(classify([], { only: [] }))).toEqual([false, false, false, false, false]);
  });

  it("combines areas and runs everything when asked", () => {
    only(["apps/site/src/pages/index.astro", "apps/web/src/app/page.tsx"], "app", "site");
    expect(Object.values(classify([], { all: true }))).toEqual([true, true, true, true, true]);
  });
});
