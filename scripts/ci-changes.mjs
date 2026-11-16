// Decides which CI jobs a change needs, from the files it touches. Used by the "Changes" job in
// .github/workflows/ci.yml, which writes the result to $GITHUB_OUTPUT.
//
//   node scripts/ci-changes.mjs --base <sha> --head <sha>   files changed on the head since the merge base
//   node scripts/ci-changes.mjs --all                       everything (scheduled runs, manual runs without a choice)
//   node scripts/ci-changes.mjs --areas service,site        only these areas (a manual run that picked some)
//   node scripts/ci-changes.mjs --files a/b.ts c.md         a given list (to try the rules)
//
// When in doubt it says "run it": if the diff can't be computed, or a file that CI itself depends on changed,
// every area is on. Areas never turn off for files that merely look unrelated: add a prefix here when a new
// part of the repository belongs to one.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Files whose change can alter every build: dependencies, workspace and compiler setup. */
const ROOT_BUILD = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.base.json", ".npmrc", ".gitattributes"];
/** Files that define CI itself: changing them runs everything, so a broken workflow shows up in its own PR. */
const CI_ITSELF = [".github/workflows/ci.yml", "scripts/ci-changes.mjs", "scripts/ci-changes.test.ts"];

/**
 * Each area lists what belongs to it (`prefix/` matches a directory, anything else one file) and what is excluded
 * from it again. A job runs when at least one changed file belongs to its area.
 */
export const AREAS = {
  // Typecheck, unit tests, production build on three systems, and the browser flow with a real server.
  app: {
    include: ["apps/api/", "apps/web/", "packages/", "plugins/", "deploy/", "scripts/", "tests/", "playwright.config.ts", "vitest.config.ts", ...ROOT_BUILD],
    exclude: ["scripts/measure.mjs"],
  },
  // What a packaged install depends on: the API bundle and its packages, the installers, the pack script.
  // Dashboard-only changes (apps/web, packages/ui) can't break an install, so they stay out.
  install: {
    include: ["apps/api/", "packages/", "deploy/", "scripts/release.mjs", "scripts/start.mjs", "scripts/update.mjs",
      "scripts/real-tests/runtime-continuity-windows.mjs", "scripts/real-tests/installer-fixtures.mjs", "scripts/real-tests/client.mjs", ...ROOT_BUILD],
    exclude: ["packages/ui/"],
  },
  // The installed Linux service with real Paper servers (isolation, limits, player continuity): what the packaged
  // service depends on, plus the scenarios themselves.
  service: {
    include: [
      "apps/api/", "packages/", "deploy/", "scripts/release.mjs", "scripts/start.mjs", "scripts/update.mjs",
      "scripts/real-tests/isolation.mjs", "scripts/real-tests/limits.mjs", "scripts/real-tests/upgrade-isolation.mjs", "scripts/real-tests/runtime-continuity.mjs",
      "scripts/real-tests/installer-fixtures.mjs", "scripts/real-tests/client.mjs", ...ROOT_BUILD,
    ],
    exclude: ["packages/ui/"],
  },
  // The website builds from its own folder and the shared UI package.
  site: {
    include: ["apps/site/", "packages/ui/", "vitest.config.ts", ...ROOT_BUILD],
    exclude: [],
  },
  // The committed plugin jar must match its source.
  plugin: {
    include: ["plugins/craftpanel-info/", "apps/api/assets/CraftPanelInfo.jar", "scripts/build-info-plugin.mjs"],
    exclude: [],
  },
};

const matches = (file, rule) => (rule.endsWith("/") ? file.startsWith(rule) : file === rule);

/** @param {string[]} files @param {{ all?: boolean }} [options] @returns {Record<string, boolean>} */
export function classify(files, { all = false, only } = {}) {
  if (only) return Object.fromEntries(Object.keys(AREAS).map((name) => [name, only.includes(name)]));
  const everything = all || files.some((f) => CI_ITSELF.includes(f));
  return Object.fromEntries(
    Object.entries(AREAS).map(([name, { include, exclude }]) => [
      name,
      everything || files.some((f) => include.some((r) => matches(f, r)) && !exclude.some((r) => matches(f, r))),
    ]),
  );
}

function changedFiles(base, head) {
  // Three dots: what the head added since it forked from the base, not what the base gained meanwhile.
  const out = execFileSync("git", ["diff", "--name-only", "-z", `${base}...${head}`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return out.split("\0").filter(Boolean);
}

function main(argv) {
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  let result;
  let note;
  if (argv.includes("--all")) {
    result = classify([], { all: true });
    note = "all areas (requested)";
  } else if (argv.includes("--areas")) {
    const only = (arg("--areas") ?? "").split(",").map((a) => a.trim()).filter(Boolean);
    const unknown = only.filter((a) => !(a in AREAS));
    if (unknown.length) throw new Error(`Unknown area(s): ${unknown.join(", ")}. Known: ${Object.keys(AREAS).join(", ")}`);
    result = classify([], { only });
    note = `areas ${only.join(", ") || "(none)"} (chosen)`;
  } else if (argv.includes("--files")) {
    const files = argv.slice(argv.indexOf("--files") + 1).filter((a) => !a.startsWith("--"));
    result = classify(files);
    note = `${files.length} file(s) given`;
  } else {
    const base = arg("--base");
    const head = arg("--head") ?? "HEAD";
    // No usable base (new branch, force push, first run): run everything rather than guess.
    if (!base || /^0+$/.test(base)) {
      result = classify([], { all: true });
      note = "all areas (no base to compare with)";
    } else {
      try {
        const files = changedFiles(base, head);
        result = classify(files);
        note = `${files.length} changed file(s)`;
      } catch (error) {
        result = classify([], { all: true });
        note = `all areas (diff failed: ${String(error.message).split("\n")[0]})`;
      }
    }
  }
  const lines = Object.entries(result).map(([name, on]) => `${name}=${on}`);
  console.log(`${note}\n${lines.join("\n")}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main(process.argv.slice(2));
