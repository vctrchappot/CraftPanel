// Release helper. The policy behind it is docs/RELEASING.md.
//   node scripts/release.mjs check [--tag vX.Y.Z]   validate versions, changelog and tags (CI runs it; the release
//                                                  workflow adds --tag for the tag it publishes)
//   node scripts/release.mjs bump <x.y.z[-rc.n]>    set the version everywhere, date the changelog, commit and tag
//   node scripts/release.mjs notes [x.y.z|unreleased]  print the release notes of a version (default: current)
//   node scripts/release.mjs pack                   package the built app (pnpm build first) into release/
//
// Publishing happens in GitHub Actions (.github/workflows/release.yml) when the tag is pushed:
//   node scripts/release.mjs bump 1.2.0 && git push --follow-tags
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** Stable x.y.z, or a release candidate x.y.z-rc.n (the only pre-release channel, see docs/RELEASING.md). */
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-rc\.([1-9]\d*))?$/;
/** A released section of CHANGELOG.md: "## 1.1.0 – 2026-11-23" (en dash). */
const RELEASE_HEADING = /^## (\d+\.\d+\.\d+) – (\d{4}-\d{2}-\d{2})$/;
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const currentVersion = () => readJson(path.join(root, "package.json")).version;
const changelogPath = path.join(root, "CHANGELOG.md");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function fail(msg) {
  console.error(`release: ${msg}`);
  process.exit(1);
}

/** Parsed version, or null when it isn't one this project releases. */
export function parseVersion(v) {
  const m = VERSION.exec(String(v).replace(/^v/, ""));
  return m ? { major: +m[1], minor: +m[2], patch: +m[3], rc: m[4] ? +m[4] : null } : null;
}

/** SemVer precedence for the versions above: a release candidate sorts before its release. */
export function compare(a, b) {
  const x = typeof a === "string" ? parseVersion(a) : a;
  const y = typeof b === "string" ? parseVersion(b) : b;
  for (const k of ["major", "minor", "patch"]) if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  if (x.rc === y.rc) return 0;
  if (x.rc === null) return 1;
  if (y.rc === null) return -1;
  return x.rc < y.rc ? -1 : 1;
}

/** The text below "## <heading…>" up to the next "## " heading. */
function changelogSection(text, matches) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith("## ") && matches(l.slice(3).trim()));
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  if (end < 0) end = lines.length;
  return { start, end, body: lines.slice(start + 1, end).join("\n").trim() };
}

function workspacePackageFiles() {
  const files = [path.join(root, "package.json")];
  for (const dir of ["apps", "packages"]) {
    for (const name of fs.readdirSync(path.join(root, dir))) {
      const file = path.join(root, dir, name, "package.json");
      if (fs.existsSync(file)) files.push(file);
    }
  }
  return files;
}

/** Version tags in the repository (v-prefixed releases only; other tags such as archive/… are ignored). */
function versionTags() {
  try {
    return git("tag", "--list", "v*").split("\n").filter(Boolean).filter((t) => parseVersion(t));
  } catch {
    return null; // not a git checkout (a release archive)
  }
}

/**
 * Everything that must hold on every commit: one product version, mirrored unchanged into every workspace manifest;
 * a well-formed changelog with "Unreleased" on top and released sections newest first; a section for the current
 * version (or, for a release candidate, entries under Unreleased); a section for every published stable tag.
 */
function problems() {
  const out = [];
  const version = currentVersion();
  const parsed = parseVersion(version);
  if (!parsed) out.push(`package.json version "${version}" is not x.y.z or x.y.z-rc.n`);
  for (const file of workspacePackageFiles().slice(1)) {
    const v = readJson(file).version;
    if (v !== version) out.push(`${path.relative(root, file).split(path.sep).join("/")} has version ${v}, package.json has ${version} (only scripts/release.mjs bump changes versions)`);
  }

  const text = fs.readFileSync(changelogPath, "utf8");
  const headings = text.split("\n").filter((l) => l.startsWith("## "));
  if (headings[0] !== "## Unreleased") out.push('CHANGELOG.md must start its sections with "## Unreleased"');
  if (headings.filter((h) => h === "## Unreleased").length > 1) out.push('CHANGELOG.md has more than one "## Unreleased"');
  const released = [];
  for (const h of headings.slice(1)) {
    const m = RELEASE_HEADING.exec(h);
    if (!m) out.push(`CHANGELOG.md heading "${h}" is not "## x.y.z – YYYY-MM-DD"`);
    else released.push({ version: m[1], date: m[2] });
  }
  for (let i = 1; i < released.length; i++) {
    const [newer, older] = [released[i - 1], released[i]];
    if (compare(newer.version, older.version) <= 0) out.push(`CHANGELOG.md lists ${newer.version} above ${older.version}; newest first, no duplicates`);
    if (newer.date < older.date) out.push(`CHANGELOG.md dates ${newer.version} (${newer.date}) before ${older.version} (${older.date})`);
  }
  if (parsed) {
    const unreleased = changelogSection(text, (h) => h === "Unreleased");
    if (parsed.rc !== null) {
      if (!unreleased?.body) out.push(`${version} is a release candidate: its notes are the entries under "## Unreleased", which is empty`);
      if (released.some((r) => r.version === `${parsed.major}.${parsed.minor}.${parsed.patch}`)) out.push(`${version} is a candidate for a version that is already released`);
    } else if (!released.some((r) => r.version === version)) out.push(`CHANGELOG.md has no "## ${version} – date" section for the current version`);
  }

  const tags = versionTags();
  if (tags) {
    for (const tag of tags) {
      const v = tag.slice(1);
      if (parseVersion(v).rc === null && !released.some((r) => r.version === v)) out.push(`tag ${tag} has no section in CHANGELOG.md`);
    }
    if (parsed && !tags.includes(`v${version}`)) out.push(`the current version ${version} has no tag v${version}: push it with "git push --follow-tags", or undo a version change made by hand`);
  }
  return out;
}

/** Commits that can be released: the tip of main or of a maintenance branch release/x.y.x. */
function releaseBranchContains(ref) {
  const branches = git("branch", "--remotes", "--contains", ref).split("\n").map((b) => b.trim());
  return branches.some((b) => b === "origin/main" || /^origin\/release\/\d+\.\d+\.x$/.test(b));
}

/** Extra conditions for publishing one tag (release workflow). */
function tagProblems(tag) {
  const out = [];
  const version = currentVersion();
  if (tag !== `v${version}`) out.push(`tag ${tag} does not match package.json version ${version}`);
  const parsed = parseVersion(tag);
  if (!parsed) return [...out, `tag ${tag} is not vX.Y.Z or vX.Y.Z-rc.N`];
  const others = (versionTags() ?? []).filter((t) => t !== tag).map((t) => ({ tag: t, v: parseVersion(t) }));
  // Newer than every earlier release of its own minor line; a patch of an older line (hotfix) is fine.
  const line = others.filter((o) => o.v.major === parsed.major && o.v.minor === parsed.minor);
  const newest = line.sort((a, b) => compare(b.v, a.v))[0];
  if (newest && compare(parsed, newest.v) <= 0) out.push(`${tag} is not newer than ${newest.tag}`);
  if (parsed.rc !== null && others.some((o) => o.v.rc === null && compare(o.v, { ...parsed, rc: null }) === 0)) out.push(`${tag} is a candidate for a version that is already released`);
  if (parsed.rc === null && parsed.patch === 0 && others.some((o) => o.v.rc === null && compare(o.v, parsed) > 0 && o.v.major === parsed.major)) out.push(`${tag} is older than a released version of the same major line`);
  try {
    if (!releaseBranchContains(`${tag}^{commit}`)) out.push(`${tag} is not on main or a release/x.y.x branch`);
  } catch (err) {
    out.push(`cannot check where ${tag} is: ${err.message.split("\n")[0]}`);
  }
  return out;
}

function check(args) {
  const i = args.indexOf("--tag");
  const tag = i >= 0 ? args[i + 1] : null;
  if (i >= 0 && !tag) fail("usage: release.mjs check [--tag vX.Y.Z]");
  const found = [...problems(), ...(tag ? tagProblems(tag) : [])];
  if (found.length) fail(`${found.length} problem(s):\n  - ${found.join("\n  - ")}`);
  console.log(`release: ${currentVersion()} is consistent${tag ? `; ${tag} can be published` : ""}`);
}

function bump(version) {
  const next = parseVersion(version);
  if (!next || version.startsWith("v")) fail("usage: release.mjs bump <x.y.z | x.y.z-rc.n>");
  if (git("status", "--porcelain")) fail("the working tree has uncommitted changes; commit or stash them first");
  if (git("tag", "--list", `v${version}`)) fail(`tag v${version} already exists`);
  const before = problems();
  if (before.length) fail(`fix these first (node scripts/release.mjs check):\n  - ${before.join("\n  - ")}`);
  const current = parseVersion(currentVersion());
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  const hotfix = /^release\/\d+\.\d+\.x$/.test(branch);
  if (branch !== "main" && !hotfix) fail(`release from main or a release/x.y.x branch, not ${branch}`);
  if (!hotfix && compare(next, current) <= 0) fail(`${version} is not newer than the current version ${currentVersion()}`);
  // The release workflow requires a passed full CI run of exactly this commit, so it has to be pushed already.
  try {
    git("fetch", "--quiet", "origin", branch);
  } catch (err) {
    fail(`cannot fetch origin/${branch}: ${String(err.stderr ?? err.message).trim().split("\n")[0]}`);
  }
  if (git("rev-parse", "HEAD") !== git("rev-parse", `origin/${branch}`)) fail(`HEAD is not origin/${branch}; push or pull first, then run the full CI on it`);

  // A release candidate takes its notes from "Unreleased" and leaves them there for the final release.
  if (next.rc === null) {
    const text = fs.readFileSync(changelogPath, "utf8");
    const unreleased = changelogSection(text, (h) => h === "Unreleased");
    if (!unreleased?.body) fail('CHANGELOG.md has no entries under "## Unreleased"');
    const lines = text.split("\n");
    const date = new Date().toISOString().slice(0, 10);
    lines.splice(unreleased.start, 1, "## Unreleased", "", `## ${version} – ${date}`);
    fs.writeFileSync(changelogPath, lines.join("\n"));
  }

  // Only the "version" line changes, so formatting of the files stays as it is.
  for (const file of workspacePackageFiles()) {
    const src = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, src.replace(/("version"\s*:\s*")[^"]+(")/, `$1${version}$2`));
  }
  git("add", "-A");
  git("commit", "-m", `Release v${version}`);
  git("tag", "-a", `v${version}`, "-m", `CraftPanel v${version}`);
  console.log(`Committed and tagged v${version}. Publish it with: git push --follow-tags (needs the owner's go-ahead, see docs/RELEASING.md)`);
}

function notes(version = currentVersion()) {
  const text = fs.readFileSync(changelogPath, "utf8");
  if (version === "unreleased") {
    process.stdout.write((changelogSection(text, (h) => h === "Unreleased")?.body || "(nothing under Unreleased)") + "\n");
    return;
  }
  const parsed = parseVersion(version);
  if (parsed?.rc !== null && parsed) {
    const unreleased = changelogSection(text, (h) => h === "Unreleased");
    if (!unreleased?.body) fail("a release candidate needs entries under Unreleased");
    const target = `${parsed.major}.${parsed.minor}.${parsed.patch}`;
    process.stdout.write(`Release candidate ${parsed.rc} for ${target}: for testing before the stable release, not offered as an update.\n\n${unreleased.body}\n`);
    return;
  }
  const section = changelogSection(text, (h) => h === version || h.startsWith(`${version} `));
  if (!section) fail(`CHANGELOG.md has no section for ${version}`);
  process.stdout.write(section.body + "\n");
}

function pack() {
  const version = currentVersion();
  const dist = path.join(root, "apps/api/dist");
  if (!fs.existsSync(path.join(dist, "index.js")) || !fs.existsSync(path.join(dist, "web/index.html"))) fail("apps/api/dist is incomplete; run pnpm build first");

  const out = path.join(root, "release");
  const name = `craftpanel-v${version}`;
  const stage = path.join(out, name);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(path.join(stage, "apps/api"), { recursive: true });
  // The source map (~8 MB) only helps when debugging a local build; names in stack traces survive minification.
  fs.cpSync(dist, path.join(stage, "apps/api/dist"), { recursive: true, filter: (src) => !src.endsWith(".js.map") });
  fs.mkdirSync(path.join(stage, "deploy"));
  for (const file of ["craftpanel.service", "craftpanel-runtime.service", "install.sh", "install.ps1"]) fs.copyFileSync(path.join(root, "deploy", file), path.join(stage, "deploy", file));
  fs.chmodSync(path.join(stage, "deploy/install.sh"), 0o755);
  for (const file of ["README.md", "LICENSE", "CHANGELOG.md"]) fs.copyFileSync(path.join(root, file), path.join(stage, file));
  let commit = null;
  try {
    commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    /* not a git checkout */
  }
  const runtime = readJson(path.join(dist, "runtime-manifest.json"));
  const manifest = JSON.stringify({ version, commit, recoveryProtocol: 1, runtime, builtAt: new Date().toISOString() }, null, 2) + "\n";
  fs.writeFileSync(path.join(stage, "release.json"), manifest);
  fs.writeFileSync(path.join(out, "release.json"), manifest);

  // Relative paths only: GNU tar on Windows would read "C:\…" as a remote host.
  const archive = `${name}.tar.gz`;
  execFileSync("tar", ["-czf", archive, name], { cwd: out, stdio: "inherit" });
  fs.rmSync(stage, { recursive: true });
  // The installers are also published on their own so `…/releases/latest/download/install.sh` works.
  for (const file of ["install.sh", "install.ps1"]) fs.copyFileSync(path.join(root, "deploy", file), path.join(out, file));
  const sums = [archive, "install.sh", "install.ps1", "release.json"].map((f) => `${crypto.createHash("sha256").update(fs.readFileSync(path.join(out, f))).digest("hex")}  ${f}`);
  fs.writeFileSync(path.join(out, "SHA256SUMS"), sums.join("\n") + "\n");
  console.log(`Packed ${path.join(out, archive)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "check") check(args);
  else if (command === "bump") bump(args[0]);
  else if (command === "notes") notes(args[0]);
  else if (command === "pack") pack();
  else fail("usage: release.mjs check [--tag vX.Y.Z] | bump <x.y.z[-rc.n]> | notes [x.y.z|unreleased] | pack");
}
