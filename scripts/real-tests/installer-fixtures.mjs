// Generate real release archives with controlled startup failures. Never edits an installed instance.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const [outputArg, instance = "craftpanel", legacySourceArg] = process.argv.slice(2);
if (!outputArg || !/^(craftpanel|craftpanel-ops-[a-z0-9-]+)$/.test(instance)) throw new Error("Usage: installer-fixtures.mjs OUTPUT [craftpanel-ops-NAME]");
const output = path.resolve(outputArg);
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.mkdir(output); // Refuse to overwrite an existing fixture set.
const rewrite = (text) => instance === "craftpanel" ? text : text.replace(/\bcraftpanel\b/g, () => instance).replaceAll(`${instance}-recovery-v1`, "craftpanel-recovery-v1").replaceAll(`${instance}-runtime-v1`, "craftpanel-runtime-v1");
await fs.writeFile(path.join(output, "install.sh"), rewrite(await fs.readFile(path.join(root, "deploy/install.sh"), "utf8")));
await fs.copyFile(path.join(root, "deploy/install.ps1"), path.join(output, "install.ps1"));
const archives = {};
for (const [kind, version] of [["good", "99.0.0"], ["unsupported", "98.0.0"], ["migration", "99.0.1"], ["unit", "99.0.2"], ["hang", "99.0.3"], ["runtime", "99.0.4"], ["runtime-migration", "99.0.5"]]) {
  const name = `${instance}-v${version}`;
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
  const name = `${instance}-v97.0.0`;
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
await fs.writeFile(path.join(output, "fixtures.json"), JSON.stringify({ instance, archives, ...(legacy ? { legacy } : {}) }, null, 2));
console.log(output);
