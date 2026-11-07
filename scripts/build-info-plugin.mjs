// Builds plugins/craftpanel-info into apps/api/assets/CraftPanelInfo.jar.
//
// The jar is committed so that building CraftPanel needs no JDK. Rebuild it after changing
// the plugin (needs a JDK 17+; uses JAVA_HOME, or javac/jar on PATH):
//   node scripts/build-info-plugin.mjs           build the jar
//   node scripts/build-info-plugin.mjs --check   fail if the committed jar is out of date
// Output is reproducible (fixed timestamps), so --check can run in CI.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginDir = path.join(root, "plugins", "craftpanel-info");
const out = path.join(root, "apps", "api", "assets", "CraftPanelInfo.jar");
const check = process.argv.includes("--check");

const exe = (name) => {
  const file = process.platform === "win32" ? `${name}.exe` : name;
  return process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", file) : file;
};
const javaFiles = (dir) =>
  fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith(".java")).map((e) => path.join(e.parentPath, e.name));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cp-plugin-"));
try {
  const classes = path.join(tmp, "classes");
  const stubClasses = path.join(tmp, "stubs");
  // Stubs are compiled separately and only put on the classpath, so they never end up in the jar.
  execFileSync(exe("javac"), ["--release", "8", "-nowarn", "-d", stubClasses, ...javaFiles(path.join(pluginDir, "stubs"))], { stdio: "inherit" });
  execFileSync(exe("javac"), ["--release", "8", "-Xlint:-options", "-cp", stubClasses, "-d", classes, ...javaFiles(path.join(pluginDir, "src"))], { stdio: "inherit" });
  fs.copyFileSync(path.join(pluginDir, "resources", "plugin.yml"), path.join(classes, "plugin.yml"));

  const target = check ? path.join(tmp, "CraftPanelInfo.jar") : out;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.rmSync(target, { force: true });
  execFileSync(exe("jar"), ["--create", "--file", target, "--date", "2026-01-01T00:00:00Z", "--no-manifest", "-C", classes, "."], { stdio: "inherit" });

  if (check) {
    const same = fs.existsSync(out) && Buffer.compare(fs.readFileSync(out), fs.readFileSync(target)) === 0;
    if (!same) {
      console.error("apps/api/assets/CraftPanelInfo.jar is out of date. Run: node scripts/build-info-plugin.mjs");
      process.exit(1);
    }
    console.log("CraftPanelInfo.jar is up to date.");
  } else {
    console.log(`Built ${path.relative(root, out)} (${fs.statSync(out).size} bytes)`);
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
