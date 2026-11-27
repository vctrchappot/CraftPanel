// Jobs across a dashboard crash: the dashboard process is killed while it installs a real Paper server; after it
// starts again the installation's job resumes (attempt 2) and the server is installed. A backup is then recorded
// as a finished job. Manages its own runtime and dashboard processes (not run.sh), on its own port and data dir.
// usage: pnpm build && node scripts/real-tests/jobs-restart.mjs <port> <data-dir> [mcVersion] [mcPort]
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { client } from "./client.mjs";

const [port = "19733", data = path.join(os.tmpdir(), "cp-jobs"), mcVersion = "1.21.4", mcPort = "25833"] = process.argv.slice(2);
const here = path.dirname(fileURLToPath(import.meta.url));
const dist = fs.mkdtempSync(path.join(os.tmpdir(), "cp-jobs-dist-"));
fs.cpSync(path.join(here, "..", "..", "apps", "api", "dist"), dist, { recursive: true });
fs.rmSync(data, { recursive: true, force: true });
fs.mkdirSync(data, { recursive: true });
const base = `http://127.0.0.1:${port}`;
const env = { ...process.env, CRAFTPANEL_DATA_DIR: data, CRAFTPANEL_PORT: port, CRAFTPANEL_HOST: "127.0.0.1", CRAFTPANEL_UPDATE_CHECK: "false" };
const log = (name) => fs.openSync(`${data}.${name}.log`, "a");
const ok = (cond, msg) => {
  console.log(`${cond ? "PASS" : "FAIL"} ${msg}`);
  if (!cond) process.exitCode = 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const runtime = spawn(process.execPath, [path.join(dist, "runtime.js")], { env, stdio: ["ignore", log("runtime"), log("runtime")] });
let api = null;
async function startApi() {
  api = spawn(process.execPath, [path.join(dist, "index.js")], { env, stdio: ["ignore", log("api"), log("api")] });
  for (let i = 0; i < 60; i++) {
    if (await fetch(`${base}/api/ready`).then((r) => r.ok, () => false)) return;
    await sleep(1000);
  }
  throw new Error("the dashboard did not become ready");
}

try {
  await startApi();
  let c = client(base);
  await c.signIn();
  const s = await c.create({ name: "jobs-restart", software: "paper", mcVersion, port: Number(mcPort), memoryMb: 1536 });

  // Wait until the installation is a running job that is downloading, then end the dashboard without warning.
  let job;
  for (let i = 0; i < 120; i++) {
    [job] = (await c.call("GET", `/api/jobs?serverId=${s.id}`)).filter((j) => j.kind === "server.install");
    if (job?.state === "running" && job.stage && job.stage !== "Checking Java runtime") break;
    await sleep(250);
  }
  ok(job?.state === "running", `installation runs as a job (${job?.title}: ${job?.stage})`);
  api.kill("SIGKILL");
  await new Promise((r) => api.once("exit", r));
  console.log("dashboard killed during the installation");

  await startApi();
  c = client(base);
  await c.signIn();
  const installed = await c.waitInstalled(s.id).then(() => true, () => false);
  const [after] = (await c.call("GET", `/api/jobs?serverId=${s.id}`)).filter((j) => j.id === job.id);
  ok(installed && (await c.server(s.id)).installState === "installed", "the server is installed after the restart");
  ok(after?.state === "succeeded" && after.attempt === 2, `the same job resumed and finished (attempt ${after?.attempt}, ${after?.state})`);
  const owner = (await c.call("GET", `/api/jobs?serverId=${s.id}`)).length;
  ok(owner === 1, `one job for the installation, not two (${owner})`);

  // The server starts from the resumed installation, and a backup is recorded as a job.
  await c.start(s.id);
  await c.waitStatus(s.id, "running");
  ok(true, "the server starts");
  await c.call("POST", `/api/servers/${s.id}/backups`, {});
  let backup;
  for (let i = 0; i < 120; i++) {
    [backup] = (await c.call("GET", `/api/jobs?serverId=${s.id}`)).filter((j) => j.kind === "server.backup");
    if (backup && backup.state !== "running") break;
    await sleep(1000);
  }
  ok(backup?.state === "succeeded" && backup.percent === 100, `a backup of the running server is a finished job (${backup?.title})`);
  await c.stop(s.id);
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  api?.kill();
  runtime.kill();
  await sleep(2000);
  fs.rmSync(dist, { recursive: true, force: true });
}
console.log(process.exitCode ? "FAILED" : "all checks passed");
