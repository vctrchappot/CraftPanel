// Release helper.
//   node scripts/release.mjs bump <x.y.z>    set the version everywhere, date the changelog, commit and tag v<x.y.z>
//   node scripts/release.mjs notes [x.y.z]   print the changelog section of a version (default: current)
//   node scripts/release.mjs pack            package the built app (pnpm build first) into release/
//
// Publishing happens in GitHub Actions (.github/workflows/release.yml) when the tag is pushed:
//   node scripts/release.mjs bump 0.2.0 && git push --follow-tags
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const currentVersion = () => readJson(path.join(root, "package.json")).version;
const changelogPath = path.join(root, "CHANGELOG.md");

function fail(msg) {
  console.error(`release: ${msg}`);
  process.exit(1);
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

function bump(version) {
  if (!version || !SEMVER.test(version)) fail("usage: release.mjs bump <x.y.z>");
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  if (git("status", "--porcelain")) fail("the working tree has uncommitted changes; commit or stash them first");
  if (git("tag", "--list", `v${version}`)) fail(`tag v${version} already exists`);

  const text = fs.readFileSync(changelogPath, "utf8");
  const unreleased = changelogSection(text, (h) => h === "Unreleased");
  if (!unreleased || !unreleased.body) fail('CHANGELOG.md has no entries under "## Unreleased"');
  const lines = text.split("\n");
  const date = new Date().toISOString().slice(0, 10);
  lines.splice(unreleased.start, 1, "## Unreleased", "", `## ${version} – ${date}`);
  fs.writeFileSync(changelogPath, lines.join("\n"));

  // Only the "version" line changes, so formatting of the files stays as it is.
  for (const file of workspacePackageFiles()) {
    const src = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, src.replace(/("version"\s*:\s*")[^"]+(")/, `$1${version}$2`));
  }
  git("add", "-A");
  git("commit", "-m", `Release v${version}`);
  git("tag", "-a", `v${version}`, "-m", `CraftPanel v${version}`);
  console.log(`Committed and tagged v${version}. Publish it with: git push --follow-tags`);
}

function notes(version = currentVersion()) {
  const section = changelogSection(fs.readFileSync(changelogPath, "utf8"), (h) => h === version || h.startsWith(`${version} `));
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
  fs.cpSync(dist, path.join(stage, "apps/api/dist"), { recursive: true });
  fs.mkdirSync(path.join(stage, "deploy"));
  for (const file of ["craftpanel.service", "install.sh", "install.ps1"]) fs.copyFileSync(path.join(root, "deploy", file), path.join(stage, "deploy", file));
  fs.chmodSync(path.join(stage, "deploy/install.sh"), 0o755);
  for (const file of ["README.md", "LICENSE", "CHANGELOG.md"]) fs.copyFileSync(path.join(root, file), path.join(stage, file));
  let commit = null;
  try {
    commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    /* not a git checkout */
  }
  fs.writeFileSync(path.join(stage, "release.json"), JSON.stringify({ version, commit, builtAt: new Date().toISOString() }, null, 2) + "\n");

  // Relative paths only: GNU tar on Windows would read "C:\…" as a remote host.
  const archive = `${name}.tar.gz`;
  execFileSync("tar", ["-czf", archive, name], { cwd: out, stdio: "inherit" });
  fs.rmSync(stage, { recursive: true });
  // The installers are also published on their own so `…/releases/latest/download/install.sh` works.
  for (const file of ["install.sh", "install.ps1"]) fs.copyFileSync(path.join(root, "deploy", file), path.join(out, file));
  const sums = [archive, "install.sh", "install.ps1"].map((f) => `${crypto.createHash("sha256").update(fs.readFileSync(path.join(out, f))).digest("hex")}  ${f}`);
  fs.writeFileSync(path.join(out, "SHA256SUMS"), sums.join("\n") + "\n");
  console.log(`Packed ${path.join(out, archive)}`);
}

const [command, arg] = process.argv.slice(2);
if (command === "bump") bump(arg);
else if (command === "notes") notes(arg);
else if (command === "pack") pack();
else fail("usage: release.mjs bump <x.y.z> | notes [x.y.z] | pack");
