// Runs a PowerShell command as administrator in a fresh Windows Sandbox and waits for it; the sandbox is discarded afterwards.
// node scripts/real-tests/windows-sandbox.mjs [--offline] [--keep] [--timeout <minutes>] [--map <dir>]... (--script <file.ps1> | -- <PowerShell command>)
// The checkout, Node, Git for Windows and every --map folder are mapped read-only at their host paths (so pnpm's links
// still resolve and `bash` runs run.sh); the only writable host folder is $env:SANDBOX_OUT, kept under
// %LOCALAPPDATA%\craftpanel-sandbox only with --keep. The command's output is streamed here; its exit code becomes ours.
// One sandbox runs at a time.
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const usage = "Usage: windows-sandbox.mjs [--offline] [--keep] [--timeout <minutes>] [--map <dir>]... (--script <file.ps1> | -- <PowerShell command>)";
if (process.platform !== "win32") throw new Error("Run from Windows");
const split = process.argv.indexOf("--");
const flags = process.argv.slice(2, split < 0 ? undefined : split);
const values = (name) => flags.flatMap((flag, i) => (flag === name ? [flags[i + 1]] : []));
const [script] = values("--script");
const command = script ? fs.readFileSync(script, "utf8") : split < 0 ? "" : process.argv.slice(split + 1).join(" ");
if (!command) throw new Error(usage);
const keep = flags.includes("--keep");
const offline = flags.includes("--offline");
const timeoutMs = Number(values("--timeout")[0] ?? 30) * 60_000;
const extra = values("--map").map((dir) => path.resolve(dir));

const exe = path.join(process.env.SystemRoot, "System32", "WindowsSandbox.exe");
if (!fs.existsSync(exe)) throw new Error("Windows Sandbox is off: enable Containers-DisposableClientVM as administrator and reboot");
const sandboxProcesses = () =>
  spawnSync("tasklist.exe", ["/fo", "csv", "/nh"], { encoding: "utf8" }).stdout
    .split("\n").map((line) => line.split(",")[0]?.replace(/"/g, "")).filter((name) => /^(vmmem)?WindowsSandbox/i.test(name ?? ""));
if (sandboxProcesses().length) throw new Error("A Windows Sandbox is already running; close it first (only one can run at a time)");

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const git = path.dirname(path.dirname(spawnSync("where.exe", ["git"], { encoding: "utf8" }).stdout.split(/\r?\n/)[0] || "C:\\Program Files\\Git\\cmd\\git.exe"));
const node = path.dirname(process.execPath);
const run = path.join(process.env.LOCALAPPDATA, "craftpanel-sandbox", `windows-${crypto.randomBytes(3).toString("hex")}`);
const inside = "C:\\sandbox-run";
fs.mkdirSync(path.join(run, "out"), { recursive: true });

const escapeXml = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const mapped = (host, sandbox, readOnly) =>
  `<MappedFolder><HostFolder>${escapeXml(host)}</HostFolder><SandboxFolder>${escapeXml(sandbox)}</SandboxFolder><ReadOnly>${readOnly}</ReadOnly></MappedFolder>`;
fs.writeFileSync(path.join(run, "command.ps1"), command);
// Runs at logon as the sandbox's administrator. The command runs in a child process so a `stop` file from the host
// (timeout, Ctrl+C) can end it; closing the sandbox window would leave the VM running. The exit file is written last,
// so the host knows the log is complete.
fs.writeFileSync(path.join(run, "boot.ps1"), [
  "$ErrorActionPreference = 'Continue'",
  `$env:Path = '${node};${git}\\bin;${git}\\usr\\bin;' + $env:Path`,
  `$env:SANDBOX_OUT = '${inside}\\out'`,
  `Set-Location '${repo}'`,
  `$run = "& '${inside}\\command.ps1' *>&1 | Out-File -Encoding utf8 -Append '${inside}\\out\\log.txt'; exit $" + "LASTEXITCODE"`,
  "$child = Start-Process powershell.exe -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $run -PassThru -WindowStyle Hidden",
  `while (-not $child.WaitForExit(1000)) { if (Test-Path '${inside}\\stop') { taskkill.exe /t /f /pid $child.Id | Out-Null; break } }`,
  "$code = if ($child.HasExited) { $child.ExitCode } else { 1 }",
  `Set-Content '${inside}\\out\\exit.tmp' $code`,
  `Move-Item '${inside}\\out\\exit.tmp' '${inside}\\out\\exit'`,
  keep ? "" : "shutdown.exe /s /t 0",
].join("\r\n"));
fs.writeFileSync(path.join(run, "config.wsb"), `<Configuration>
  <Networking>${offline ? "Disable" : "Default"}</Networking>
  <ClipboardRedirection>Disable</ClipboardRedirection>
  <PrinterRedirection>Disable</PrinterRedirection>
  <AudioInput>Disable</AudioInput>
  <VideoInput>Disable</VideoInput>
  <MemoryInMB>8192</MemoryInMB>
  <MappedFolders>
    ${mapped(repo, repo, true)}
    ${mapped(node, node, true)}
    ${mapped(git, git, true)}
    ${extra.map((dir) => mapped(dir, dir, true)).join("\n    ")}
    ${mapped(run, inside, false)}
  </MappedFolders>
  <LogonCommand><Command>powershell.exe -NoProfile -ExecutionPolicy Bypass -File ${inside}\\boot.ps1</Command></LogonCommand>
</Configuration>
`);

console.error(`Windows Sandbox ${path.basename(run)}`);
spawn(exe, [path.join(run, "config.wsb")], { detached: true, stdio: "ignore" }).unref();
const log = path.join(run, "out", "log.txt");
const exitFile = path.join(run, "out", "exit");
let shown = 0;
const flush = () => {
  if (!fs.existsSync(log)) return;
  const text = fs.readFileSync(log, "utf8").replace(/^\uFEFF/, "");
  process.stdout.write(text.slice(shown));
  shown = text.length;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let stopAt = Date.now() + timeoutMs;
let stopping = false;
const stop = (why) => {
  if (stopping) return;
  stopping = true;
  console.error(`${why}; stopping the sandbox`);
  fs.writeFileSync(path.join(run, "stop"), "");
  stopAt = Date.now() + 60_000;
};
process.on("SIGINT", () => stop("Interrupted"));
let status = 1;
while (true) {
  await sleep(2000);
  flush();
  const code = (() => { try { return fs.readFileSync(exitFile, "utf8").trim(); } catch { return undefined; } })();
  if (code !== undefined) {
    status = stopping ? 1 : Number(code) || 0;
    break;
  }
  if (Date.now() > stopAt) {
    if (stopping) {
      console.error(`The sandbox did not stop; close it by hand, then delete ${run}`);
      process.exit(1);
    }
    stop(`Timed out after ${timeoutMs / 60_000} minutes`);
  }
}
flush();
if (keep) console.error(`Kept the sandbox open and ${run}`);
else {
  // The VM shuts itself down; wait for it, close a leftover window, then remove the shared folder.
  for (let i = 0; i < 60 && sandboxProcesses().some((name) => /^vmmem/i.test(name)); i++) await sleep(1000);
  for (const name of new Set(sandboxProcesses())) spawnSync("taskkill.exe", ["/im", name, "/f"], { stdio: "ignore" });
  fs.rmSync(run, { recursive: true, force: true, maxRetries: 10, retryDelay: 1000 });
}
process.exitCode = status;
