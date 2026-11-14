// Runs a command as root in a fresh, throwaway WSL 2 distro (Ubuntu 24.04, systemd, Node) and deletes it afterwards.
// node scripts/real-tests/wsl-sandbox.mjs [--keep] -- <bash command>
// The repository is reachable under /mnt/c/... as usual. The first run builds a base image once
// (%LOCALAPPDATA%\craftpanel-sandbox\base.tar); delete that file to rebuild it.
// Everything runs inside one `wsl` call: WSL stops a distro's processes when the call that started them returns.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

if (process.platform !== "win32") throw new Error("Run from Windows");
const split = process.argv.indexOf("--");
const keep = process.argv.slice(2, split < 0 ? undefined : split).includes("--keep");
const command = split < 0 ? "" : process.argv.slice(split + 1).join(" ");
if (!command) throw new Error("Usage: wsl-sandbox.mjs [--keep] -- <bash command>");

const NODE = "22.20.0";
const cache = path.join(process.env.LOCALAPPDATA, "craftpanel-sandbox");
const base = path.join(cache, "base.tar");
fs.mkdirSync(cache, { recursive: true });
const wsl = (args, options = {}) => {
  const result = spawnSync("wsl.exe", args, { stdio: "inherit", env: { ...process.env, WSL_UTF8: "1" }, ...options });
  if (result.status !== 0 && !options.allowFailure) throw new Error(`wsl ${args.slice(0, 3).join(" ")} failed (${result.status})`);
  return result.status;
};

if (!fs.existsSync(base)) {
  const name = "craftpanel-sandbox-base";
  console.error("Building the sandbox base image (once)…");
  wsl(["--unregister", name], { allowFailure: true, stdio: "ignore" });
  wsl(["--install", "Ubuntu-24.04", "--name", name, "--location", path.join(cache, "base"), "--no-launch"]);
  try {
    wsl(["-d", name, "-u", "root", "--", "bash", "-euc", [
      "printf '[boot]\\nsystemd=true\\n[user]\\ndefault=root\\n' > /etc/wsl.conf",
      "apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl ca-certificates xz-utils >/dev/null",
      `curl -fsSL https://nodejs.org/dist/v${NODE}/node-v${NODE}-linux-x64.tar.xz | tar -xJ -C /usr/local --strip-components=1`,
      "node --version",
    ].join(" && ")]);
    wsl(["--terminate", name]);
    wsl(["--export", name, base + ".tmp"]);
    fs.renameSync(base + ".tmp", base);
  } finally {
    wsl(["--unregister", name], { allowFailure: true, stdio: "ignore" });
  }
}

const name = `craftpanel-sandbox-${crypto.randomBytes(3).toString("hex")}`;
const location = path.join(cache, name);
console.error(`Sandbox ${name}`);
wsl(["--import", name, location, base, "--version", "2"]);
let status = 1;
try {
  // Wait for systemd so service tests behave like a real host.
  status = wsl(["-d", name, "-u", "root", "--", "bash", "-c", `systemctl is-system-running --wait >/dev/null 2>&1; ${command}`], { allowFailure: true });
} finally {
  if (keep) console.error(`Kept ${name}; remove it with: wsl --unregister ${name}`);
  else {
    wsl(["--unregister", name], { allowFailure: true, stdio: "ignore" });
    fs.rmSync(location, { recursive: true, force: true });
  }
}
process.exitCode = status;
