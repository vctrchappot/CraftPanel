// Generate real release archives with controlled startup failures. Never edits an installed instance.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const [outputArg, instance = "craftpanel"] = process.argv.slice(2);
if (!outputArg || !/^(craftpanel|craftpanel-ops-[a-z0-9-]+)$/.test(instance)) throw new Error("Usage: installer-fixtures.mjs OUTPUT [craftpanel-ops-NAME]");
const output = path.resolve(outputArg);
await fs.mkdir(output); // Refuse to overwrite an existing fixture set.
const rewrite = (text) => instance === "craftpanel" ? text : text.replace(/\bcraftpanel\b/g, () => instance).replaceAll(`${instance}-recovery-v1`, "craftpanel-recovery-v1");
await fs.writeFile(path.join(output, "install.sh"), rewrite(await fs.readFile(path.join(root, "deploy/install.sh"), "utf8")));
await fs.copyFile(path.join(root, "deploy/install.ps1"), path.join(output, "install.ps1"));
const archives = {};
for (const [kind, version] of [["good", "99.0.0"], ["unsupported", "98.0.0"], ["migration", "99.0.1"], ["unit", "99.0.2"], ["hang", "99.0.3"]]) {
  const name = `${instance}-v${version}`;
  const stage = path.join(output, name);
  const dist = path.join(stage, "apps/api/dist");
  await fs.mkdir(path.dirname(dist), { recursive: true });
  await fs.cp(path.join(root, "apps/api/dist"), dist, { recursive: true, filter: (p) => !p.endsWith(".js.map") });
  await fs.mkdir(path.join(stage, "deploy"));
  for (const file of ["README.md", "LICENSE", "CHANGELOG.md"]) await fs.copyFile(path.join(root, file), path.join(stage, file));
  for (const file of ["install.sh", "craftpanel.service"])
    await fs.writeFile(path.join(stage, "deploy", rewrite(file)), rewrite(await fs.readFile(path.join(root, "deploy", file), "utf8")));
  await fs.copyFile(path.join(root, "deploy/install.ps1"), path.join(stage, "deploy/install.ps1"));
  await fs.writeFile(path.join(stage, "release.json"), JSON.stringify({ version, fixture: kind, recoveryProtocol: 1 }));
  if (kind === "unsupported") await fs.rm(path.join(dist, "recovery.js"));
  if (kind === "unit") {
    const file = path.join(stage, "deploy", rewrite("craftpanel.service"));
    await fs.writeFile(file, (await fs.readFile(file, "utf8")).replace(/^ExecStart=.*$/m, () => "ExecStart=/does-not-exist/craftpanel-test-failure"));
    await fs.appendFile(path.join(dist, "windows-job.ps1"), "\nthrow 'Intentional launcher fixture failure'\n");
  }
  if (kind === "migration" || kind === "hang") {
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
  const archive = path.join(output, name + ".tar.gz");
  execFileSync("tar", ["-czf", archive, name], { cwd: output, windowsHide: true });
  archives[kind] = archive;
  await fs.rm(stage, { recursive: true }); // Only the staging directory just created above.
}
await fs.writeFile(path.join(output, "fixtures.json"), JSON.stringify({ instance, archives }, null, 2));
console.log(output);
