// Generate real release archives with controlled startup failures. Never edits an installed instance.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const argv = process.argv.slice(2);
// --previous ARCHIVE: a real earlier release (craftpanel-vX.Y.Z.tar.gz), renamed for the instance like the others, to test upgrades.
const previousAt = argv.indexOf("--previous");
const previousArchive = previousAt >= 0 ? argv.splice(previousAt, 2)[1] : undefined;
const [outputArg, instance = "craftpanel", legacySourceArg] = argv;
if (!outputArg || !/^(craftpanel|craftpanel-ops-[a-z0-9-]+)$/.test(instance)) throw new Error("Usage: installer-fixtures.mjs OUTPUT [craftpanel-ops-NAME]");
// The installer creates game accounts named <instance>-game-NN, and Linux accepts at most 32 characters.
if (`${instance}-game-00`.length > 32) throw new Error(`The instance name "${instance}" is too long: its game accounts (${instance}-game-00) would exceed 32 characters.`);
const output = path.resolve(outputArg);
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.mkdir(output); // Refuse to overwrite an existing fixture set.
// Isolate service, user and path names, but keep release archives named craftpanel-vX.Y.Z like real
// releases: the dashboard reads craftpanel-vX.Y.Z/release.json from them.
const rewrite = (text) => instance === "craftpanel" ? text : text.replace(/\bcraftpanel\b(?!-v)/g, () => instance).replaceAll(`${instance}-recovery-v1`, "craftpanel-recovery-v1").replaceAll(`${instance}-runtime-v1`, "craftpanel-runtime-v1");
await fs.writeFile(path.join(output, "install.sh"), rewrite(await fs.readFile(path.join(root, "deploy/install.sh"), "utf8")));
await fs.copyFile(path.join(root, "deploy/install.ps1"), path.join(output, "install.ps1"));
const archives = {};
for (const [kind, version] of [["good", "99.0.0"], ["unsupported", "98.0.0"], ["migration", "99.0.1"], ["unit", "99.0.2"], ["hang", "99.0.3"], ["runtime", "99.0.4"], ["runtime-migration", "99.0.5"]]) {
  const name = `craftpanel-v${version}`;
  const stage = path.join(output, name);
  const dist = path.join(stage, "apps/api/dist");
  await fs.mkdir(path.dirname(dist), { recursive: true });
  await fs.cp(path.join(root, "apps/api/dist"), dist, { recursive: true, filter: (p) => !p.endsWith(".js.map") });
  await fs.mkdir(path.join(stage, "deploy"));
  for (const file of ["README.md", "LICENSE", "CHANGELOG.md"]) await fs.copyFile(path.join(root, file), path.join(stage, file));
  for (const file of ["install.sh", "craftpanel.service", "craftpanel-runtime.service"])
    await fs.writeFile(path.join(stage, "deploy", rewrite(file)), rewrite(await fs.readFile(path.join(root, "deploy", file), "utf8")));
  await fs.copyFile(path.join(root, "deploy/install.ps1"), path.join(stage, "deploy/install.ps1"));
  if (kind === "unsupported") await fs.rm(path.join(dist, "recovery.js"));
  if (kind === "unit") {
    const file = path.join(stage, "deploy", rewrite("craftpanel.service"));
    await fs.writeFile(file, (await fs.readFile(file, "utf8")).replace(/^ExecStart=.*$/m, () => "ExecStart=/does-not-exist/craftpanel-test-failure"));
    const dashboard = path.join(dist, "index.js");
    await fs.writeFile(dashboard, "if (process.platform === 'win32') throw new Error('Intentional dashboard fixture failure');\n" + await fs.readFile(dashboard, "utf8"));
  }
  if (kind === "migration" || kind === "hang" || kind === "runtime-migration") {
    await fs.writeFile(path.join(dist, "index.js"), `import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
const db = new DatabaseSync(path.join(process.env.CRAFTPANEL_DATA_DIR, 'craftpanel.db'));
db.exec("ALTER TABLE users RENAME COLUMN username TO broken_username; CREATE TABLE failed_update_probe (id INTEGER);");
db.close();
${kind === "hang" ? `const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
fs.writeFileSync(path.join(process.env.CRAFTPANEL_DATA_DIR, 'failed-child-pid.txt'), String(child.pid));
setInterval(() => {}, 1000);` : "process.exit(1);"}
`);
  }
  if (kind.startsWith("runtime")) await fs.appendFile(path.join(dist, "runtime.js"), `\n// Runtime update acceptance fixture ${version}\n`);
  // Keep identity honest, including renamed systemd templates in isolated fixtures.
  const bundle = await fs.readFile(path.join(dist, "runtime.js"));
  const runtime = { protocol: 1, bundleSha256: crypto.createHash("sha256").update(bundle).digest("hex"),
    sha256: crypto.createHash("sha256").update(bundle)
      .update(await fs.readFile(path.join(dist, "windows-job.ps1")))
      .update(await fs.readFile(path.join(dist, "windows-runtime-service.cs")))
      .update(await fs.readFile(path.join(stage, "deploy", rewrite("craftpanel-runtime.service")))).digest("hex") };
  await fs.writeFile(path.join(dist, "runtime-manifest.json"), JSON.stringify(runtime));
  await fs.writeFile(path.join(stage, "release.json"), JSON.stringify({ version, fixture: kind, recoveryProtocol: 1, runtime }));
  const archive = path.join(output, name + ".tar.gz");
  execFileSync("tar", ["-czf", archive, name], { cwd: output, windowsHide: true });
  archives[kind] = archive;
  await fs.rm(stage, { recursive: true }); // Only the staging directory just created above.
}
let legacy;
if (legacySourceArg) {
  const source = path.resolve(legacySourceArg);
  const name = "craftpanel-v97.0.0";
  const stage = path.join(output, name);
  await fs.mkdir(path.join(stage, "apps", "api"), { recursive: true });
  await fs.cp(path.join(source, "apps", "api", "dist"), path.join(stage, "apps", "api", "dist"), { recursive: true, filter: (p) => !p.endsWith(".js.map") });
  await fs.mkdir(path.join(stage, "deploy"));
  for (const file of ["README.md", "LICENSE", "CHANGELOG.md"]) await fs.copyFile(path.join(source, file), path.join(stage, file));
  for (const file of ["install.sh", "craftpanel.service"])
    await fs.writeFile(path.join(stage, "deploy", rewrite(file)), rewrite(await fs.readFile(path.join(source, "deploy", file), "utf8")));
  const installer = path.join(output, "legacy-install.sh");
  await fs.writeFile(installer, rewrite(await fs.readFile(path.join(source, "deploy", "install.sh"), "utf8")));
  await fs.writeFile(path.join(stage, "release.json"), JSON.stringify({ version: "97.0.0", recoveryProtocol: 1, fixture: "legacy" }));
  const archive = path.join(output, name + ".tar.gz");
  execFileSync("tar", ["-czf", archive, name], { cwd: output, windowsHide: true });
  await fs.rm(stage, { recursive: true });
  legacy = { archive, installer };
}
let previous;
if (previousArchive) {
  // The published archive, unpacked, with its service files and installer renamed for this instance (as for the
  // archives above) and its runtime identity recomputed, then packed again.
  const parent = path.join(output, "previous-stage");
  await fs.mkdir(parent);
  execFileSync("tar", ["-xzf", path.resolve(previousArchive), "-C", parent], { windowsHide: true });
  const [name] = await fs.readdir(parent);
  const stage = path.join(parent, name);
  const dist = path.join(stage, "apps/api/dist");
  const unit = (file) => path.join(stage, "deploy", file);
  for (const file of ["install.sh", "craftpanel.service", "craftpanel-runtime.service"]) {
    const text = rewrite(await fs.readFile(unit(file), "utf8"));
    if (rewrite(file) !== file) await fs.rm(unit(file));
    await fs.writeFile(unit(rewrite(file)), text, { mode: 0o755 });
  }
  const installer = path.join(output, "previous-install.sh");
  await fs.copyFile(unit("install.sh"), installer);
  const optional = async (file) => fs.readFile(path.join(dist, file)).catch(() => Buffer.alloc(0));
  const hash = crypto.createHash("sha256").update(await fs.readFile(path.join(dist, "runtime.js"))).update(await optional("windows-job.ps1")).update(await optional("windows-runtime-service.cs"))
    .update(await fs.readFile(unit(rewrite("craftpanel-runtime.service")))).digest("hex");
  const manifestFile = path.join(dist, "runtime-manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestFile, "utf8"));
  await fs.writeFile(manifestFile, JSON.stringify({ ...manifest, sha256: hash }));
  const release = JSON.parse(await fs.readFile(path.join(stage, "release.json"), "utf8"));
  await fs.writeFile(path.join(stage, "release.json"), JSON.stringify({ ...release, runtime: { ...release.runtime, sha256: hash } }));
  const archive = path.join(output, `${name}.tar.gz`);
  execFileSync("tar", ["-czf", archive, name], { cwd: parent, windowsHide: true });
  await fs.rm(parent, { recursive: true }); // The staging directory just created above.
  previous = { archive, installer, version: release.version };
}
await fs.writeFile(path.join(output, "fixtures.json"), JSON.stringify({ instance, archives, ...(legacy ? { legacy } : {}), ...(previous ? { previous } : {}) }, null, 2));
console.log(output);
