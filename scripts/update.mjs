// Updates a CraftPanel checkout to the newest version:  update.cmd (Windows) or ./update.sh
//
// 1. Keeps local edits (git stash) and your own commits (backup branch), so nothing is lost.
// 2. Fetches the latest version, also when the published history was rewritten.
// 3. Installs dependencies and rebuilds.
// 4. Linux service installs (deploy/install-linux.sh): reinstalls and restarts the service.
//    Otherwise: tells you whether CraftPanel is running and needs a restart.
// Your servers, worlds, backups and settings live in the data directory, outside this folder,
// and are not touched. Database changes are applied automatically when CraftPanel starts.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (tty ? `\u001b[${code}m${s}\u001b[0m` : s);
const bold = c("1");
const dim = c("2");
const green = c("32");
const yellow = c("33");
const red = c("31");

const step = (msg) => console.log(`\n${bold("›")} ${msg}`);
const info = (msg) => console.log(`  ${msg}`);
const fail = (msg, hint) => {
  console.error(`\n${red("✖")} ${msg}`);
  if (hint) console.error(`  ${hint}`);
  process.exit(1);
};

const git = (...args) => {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (err) {
    fail(`git ${args[0]} failed: ${String(err.stderr || err.message).trim()}`, "Nothing was deleted. Fix the problem above (or ask for help in a GitHub issue) and run the update again.");
  }
};
const gitOk = (...args) => spawnSync("git", args, { cwd: root, stdio: "ignore" }).status === 0;
const version = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  } catch {
    return "?";
  }
};
const run = (cmd, args, opts = {}) => {
  // Windows: pnpm/npm are .cmd shims and need a shell; arguments here are fixed, never user input.
  const r = spawnSync(cmd, args, { cwd: root, stdio: "inherit", shell: process.platform === "win32", ...opts });
  return r.status === 0;
};

console.log(`\n${bold("CraftPanel update")} ${dim(root)}`);

// ---- preconditions ---------------------------------------------------------------
if (!gitOk("rev-parse", "--is-inside-work-tree")) fail("This folder is not a git checkout of CraftPanel.", "Download a fresh copy: git clone https://github.com/vctrchappot/CraftPanel.git");
const remote = "origin";
if (!gitOk("remote", "get-url", remote)) fail('No "origin" remote is configured.', "Add it: git remote add origin https://github.com/vctrchappot/CraftPanel.git");
const branch = git("rev-parse", "--abbrev-ref", "HEAD");
if (branch !== "main") fail(`You are on branch "${branch}", not "main".`, "Switch with: git checkout main   (then run the update again)");
if (!run("pnpm", ["--version"], { stdio: "ignore" }))
  fail("pnpm is not installed.", "Install it with: npm install -g pnpm   (or: corepack enable)");

const before = git("rev-parse", "HEAD");
const versionBefore = version();

// ---- fetch ------------------------------------------------------------------------
step("Checking for a newer version…");
if (!gitOk("fetch", "--quiet", remote, "main")) fail("Could not reach GitHub.", "Check your internet connection and try again.");
const target = git("rev-parse", `${remote}/main`);
if (target === before) {
  info(green(`Already up to date (v${versionBefore}).`));
  process.exit(0);
}

// ---- keep local work --------------------------------------------------------------
const dirty = git("status", "--porcelain", "--untracked-files=no");
if (dirty) {
  const label = `craftpanel-update ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
  git("stash", "push", "--message", label);
  info(yellow(`Your local changes were saved (git stash: "${label}"). Restore them later with: git stash pop`));
}

// ---- move to the new version ------------------------------------------------------
// Untracked files where the new version brings a file would block the update: drop identical
// copies, keep differing ones as <file>.before-update.
const incoming = new Set(git("ls-tree", "-r", "--name-only", target).split("\n"));
for (const file of git("ls-files", "--others", "--exclude-standard").split("\n").filter((f) => f && incoming.has(f))) {
  const abs = path.join(root, file);
  const same = execFileSync("git", ["hash-object", abs], { cwd: root, encoding: "utf8" }).trim() === git("rev-parse", `${target}:${file}`);
  if (same) fs.rmSync(abs);
  else {
    fs.renameSync(abs, `${abs}.before-update`);
    info(yellow(`Your file ${file} was kept as ${file}.before-update (the new version brings its own).`));
  }
}

if (gitOk("merge-base", "--is-ancestor", "HEAD", target)) {
  git("merge", "--ff-only", "--quiet", target);
} else {
  // History diverged: either local commits, or the published history was rewritten.
  // `git cherry` compares by content, so rewritten-but-identical commits don't count as yours.
  const own = git("cherry", target, "HEAD")
    .split("\n")
    .filter((l) => l.startsWith("+"));
  if (own.length) {
    const backup = `backup/before-update-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "")}`;
    git("branch", backup, "HEAD");
    info(yellow(`${own.length} commit(s) of your own were kept on branch "${backup}".`));
  } else {
    info(dim("The published history was reorganised; switching to it (nothing of yours is lost)."));
  }
  git("reset", "--hard", "--quiet", target);
}

const versionAfter = version();
step(`Updated ${versionBefore === versionAfter ? `v${versionAfter}` : `v${versionBefore} → v${versionAfter}`}. What's new:`);
const log = gitOk("merge-base", "--is-ancestor", before, target) ? git("log", "--format=%s", "--no-merges", `${before}..${target}`) : git("log", "--format=%s", "--no-merges", "-15", target);
for (const line of log.split("\n").filter(Boolean).slice(0, 15)) info(`• ${line}`);

// ---- rebuild ----------------------------------------------------------------------
step("Installing dependencies…");
if (!run("pnpm", ["install", "--frozen-lockfile"])) fail("Installing dependencies failed.", "Fix the error above and run the update again; your previous build is unchanged until the build step.");
step("Building…");
if (!run("pnpm", ["build"])) fail("The build failed.", `Report it at https://github.com/vctrchappot/CraftPanel/issues. To go back: git reset --hard ${before.slice(0, 12)} && pnpm install && pnpm build`);

// ---- apply ------------------------------------------------------------------------
const serviceInstall = process.platform === "linux" && fs.existsSync("/etc/systemd/system/craftpanel.service") && fs.existsSync("/opt/craftpanel");
if (serviceInstall) {
  step("Updating the CraftPanel service (asks for your password)…");
  const asRoot = process.getuid?.() === 0;
  const ok = asRoot ? run("bash", ["deploy/install-linux.sh"]) : run("sudo", ["bash", "deploy/install-linux.sh"]);
  if (!ok) fail("Reinstalling the service failed.", "Run it yourself: sudo ./deploy/install-linux.sh");
  console.log(`\n${green("✔")} CraftPanel v${versionAfter} is installed and running. Running Minecraft servers were stopped gracefully; start them again from the dashboard (or enable "Start with CraftPanel").`);
} else {
  const port = Number(process.env.CRAFTPANEL_PORT ?? 8080);
  const running = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) })
    .then((r) => r.ok)
    .catch(() => false);
  console.log(`\n${green("✔")} CraftPanel v${versionAfter} is ready.`);
  if (running) info(yellow(`CraftPanel is running on port ${port} with the old version. Restart it to switch: stop it with Ctrl+C (servers shut down cleanly), then start it again, e.g. pnpm start.`));
  else info("Start it with: pnpm start   (or pnpm start:lan to reach the dashboard from other devices)");
}
