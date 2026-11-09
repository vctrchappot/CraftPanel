import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// Real network tests of the production package. No Minecraft downloads or existing service changes.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const distOption = args.indexOf("--dist");
if (distOption >= 0 && !args[distOption + 1]) throw new Error("--dist needs the built API directory");
const dist = path.resolve(distOption >= 0 ? args[distOption + 1] : path.join(repo, "apps/api/dist"));
const entry = path.join(dist, "index.js");
await fs.access(entry);
const root = await fs.mkdtemp(path.join(os.tmpdir(), "craftpanel-deployment-"));
const dataRoot = args.includes("--deep-data") ? path.join(root, "nested-" + "x".repeat(100)) : root;
await fs.mkdir(dataRoot, { recursive: true });
const processes = [];
const servers = [];
const sockets = new Set();
const inheritedEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("CRAFTPANEL_")));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let browser;

function request(url, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = (url.startsWith("https:") ? https : http).request(url, {
      method, rejectUnauthorized: false, agent: false,
      headers: { ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}), ...headers },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString(), json() { return JSON.parse(this.text); } }));
      res.on("error", reject);
    });
    req.on("upgrade", (res, socket) => {
      socket.destroy();
      resolve({ status: res.statusCode, headers: res.headers });
    });
    req.setTimeout(10_000, () => req.destroy(new Error(`Request timed out: ${url}`)));
    req.on("error", reject);
    req.end(payload);
  });
}

async function listen(server) {
  servers.push(server);
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  server.on("connection", track);
  return server.address().port;
}
function track(socket) {
  sockets.add(socket);
  socket.on("error", () => {});
  socket.once("close", () => sockets.delete(socket));
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function start(name, env, useDefaultData = false) {
  const dataBase = path.join(dataRoot, name);
  const data = useDefaultData ? process.platform === "darwin" ? path.join(dataBase, "Library", "Application Support", "CraftPanel")
    : path.join(dataBase, process.platform === "win32" ? "CraftPanel" : "craftpanel") : dataBase;
  const port = await freePort();
  const variables = {
    ...inheritedEnv, CRAFTPANEL_HOST: "127.0.0.1", CRAFTPANEL_PORT: String(port),
    CRAFTPANEL_DATA_DIR: data, CRAFTPANEL_UPDATE_CHECK: "false", CRAFTPANEL_LOG_LEVEL: "warn",
    CRAFTPANEL_LOG_FORMAT: "json", ...env,
    ...(useDefaultData ? { CRAFTPANEL_DATA_DIR: undefined, LOCALAPPDATA: dataBase, XDG_DATA_HOME: dataBase, HOME: dataBase } : {}),
  };
  const runtime = spawn(process.execPath, [path.join(dist, "runtime.js")], { cwd: dist, env: variables, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const runtimeClosed = new Promise((resolve) => runtime.once("close", resolve));
  processes.push({ child: runtime, closed: runtimeClosed, data, runtime: true, env: variables });
  runtime.stderr.on("data", () => {});
  runtime.stdout.on("data", () => {});
  const child = spawn(process.execPath, [entry], { cwd: dist, env: variables, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { output = (output + chunk).slice(-64_000); });
  const closed = new Promise((resolve) => child.once("close", resolve));
  child.once("error", (error) => { output += error.message; });
  const instance = { child, closed, data, port, env: variables, output: () => output };
  processes.push(instance);
  const base = `${variables.CRAFTPANEL_TLS_CERT ? "https" : "http"}://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${name} exited before readiness:\n${output}`);
    try { if ((await request(base + "/api/ready")).status === 200) return instance; } catch { /* startup */ }
    await pause(100);
  }
  throw new Error(`${name} did not become ready:\n${output}`);
}

function proxy(api, certificates, secureEdge = true) {
  const edgeProtocol = secureEdge ? "https" : "http";
  const headersFor = (req) => {
    const headers = { ...req.headers, host: "rewritten-backend.invalid", "x-forwarded-for": req.headers["x-smoke-client-ip"] ?? "192.168.50.10", "x-forwarded-proto": edgeProtocol };
    delete headers["x-smoke-client-ip"];
    return headers;
  };
  const handler = (req, res) => {
    const upstream = (api.env.CRAFTPANEL_TLS_CERT ? https : http).request({
      host: "127.0.0.1", port: api.port, path: req.url, method: req.method,
      headers: headersFor(req), rejectUnauthorized: false, agent: false,
    }, (response) => { res.writeHead(response.statusCode, response.headers); response.pipe(res); });
    upstream.on("error", (error) => { if (!res.headersSent) res.writeHead(502); res.end(error.message); });
    req.pipe(upstream);
  };
  const server = secureEdge ? https.createServer(certificates, handler) : http.createServer(handler);
  server.on("upgrade", (req, socket, head) => {
    // The HTTPS edge test uses the plain HTTP backend. Forward the actual WS upgrade unchanged.
    const upstream = net.connect(api.port, "127.0.0.1", () => {
      const headers = Object.entries(headersFor(req)).map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : value}`).join("\r\n");
      upstream.write(`GET ${req.url} HTTP/1.1\r\n${headers}\r\n\r\n`);
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    track(upstream);
    socket.once("close", () => upstream.destroy());
    upstream.once("close", () => socket.destroy());
  });
  return server;
}

try {
  const defaults = await start("default-data-path", { CRAFTPANEL_PROFILE: "local" }, true);
  await fs.access(path.join(defaults.data, "runtime", "token"));
  await fs.access(path.join(defaults.data, "craftpanel.db"));
  console.log("PASS dashboard and runtime share the platform default data directory");
  const openssl = process.env.OPENSSL ?? (process.platform === "win32" ? "C:/Program Files/Git/usr/bin/openssl.exe" : "openssl");
  const cert = path.join(root, "localhost.pem");
  const key = path.join(root, "localhost.key");
  const generated = spawnSync(openssl, ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-keyout", key, "-out", cert], { windowsHide: true, encoding: "utf8" });
  assert.equal(generated.status, 0, `OpenSSL failed (${openssl}): ${generated.error?.message ?? generated.stderr}`);
  const certificates = { cert: await fs.readFile(cert), key: await fs.readFile(key) };

  // Reserve the HTTPS edge first so the backend can use its canonical browser-facing origin.
  let api;
  const edge = https.createServer(certificates, (req, res) => edge.emit("proxy-request", req, res));
  const edgePort = await listen(edge);
  const origin = `https://localhost:${edgePort}`;
  api = await start("proxy", { CRAFTPANEL_PROFILE: "proxy", CRAFTPANEL_PUBLIC_URL: origin, CRAFTPANEL_TRUSTED_PROXIES: "127.0.0.1" });
  const forwarding = proxy(api, certificates);
  edge.on("proxy-request", forwarding.listeners("request")[0]);
  edge.on("upgrade", forwarding.listeners("upgrade")[0]);
  const external = `https://127.0.0.1:${edgePort}`;
  let response = await request(external + "/api/auth/state");
  assert.equal(response.status, 200, response.text);
  assert.equal(response.json().setupTokenRequired, true);
  response = await request(external + "/api/auth/setup", { method: "POST", headers: { origin }, body: { username: "smoke_owner", password: "smoke-password-123" } });
  assert.equal(response.status, 403);
  const token = (await fs.readFile(path.join(api.data, "setup-token.txt"), "utf8")).trim();
  response = await request(external + "/api/auth/setup", { method: "POST", headers: { origin }, body: { username: "smoke_owner", password: "smoke-password-123", setupToken: token } });
  assert.equal(response.status, 200, response.text);
  const setCookie = response.headers["set-cookie"][0];
  assert.match(setCookie, /; Secure(?:;|$)/);
  const session = { cookie: setCookie.split(";")[0], "x-csrf-token": response.json().csrfToken, origin };
  console.log("PASS HTTPS proxy, rewritten Host, setup token and Secure session cookie");

  response = await request(external + "/api/settings", { method: "PUT", headers: session, body: { dashboardAccess: "any" } });
  assert.equal(response.status, 200, response.text);
  response = await request(external + "/api/system", { headers: { ...session, "x-smoke-client-ip": "203.0.113.10" } });
  assert.equal(response.status, 200, response.text);
  assert.equal(response.json().dashboard.clientIp, "203.0.113.10");
  assert.equal(response.json().dashboard.transportSecure, true);
  assert.equal(response.json().dashboard.publicUrl, origin);
  const wsKey = randomBytes(16).toString("base64");
  response = await request(external + "/api/ws", { headers: { ...session, connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": wsKey } });
  assert.equal(response.status, 101);
  assert.equal(response.headers["sec-websocket-accept"], createHash("sha1").update(wsKey + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64"));
  response = await request(external + "/api/ws", { headers: { ...session, origin: "https://evil.invalid", connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": wsKey } });
  assert.equal(response.status, 403);
  console.log("PASS public-client policy, authenticated WebSocket upgrade and rejected foreign origin");

  const directTls = await start("direct-tls", { CRAFTPANEL_PROFILE: "lan", CRAFTPANEL_TLS_CERT: cert, CRAFTPANEL_TLS_KEY: key });
  response = await request(`https://127.0.0.1:${directTls.port}/api/auth/state`);
  assert.equal(response.status, 200, response.text);
  assert.equal(response.json().setupRequired, true);
  const doctor = spawnSync(process.execPath, [entry, "doctor", "--json"], { cwd: dist, env: directTls.env, encoding: "utf8", windowsHide: true, timeout: 20_000 });
  assert.equal(doctor.status, 0, doctor.stderr || doctor.stdout);
  const report = JSON.parse(doctor.stdout);
  assert.equal(report.ok, true);
  assert.ok(report.checks.some((check) => check.id === "certificate" && check.status !== "error"));
  assert.ok(report.checks.some((check) => check.id === "database" && check.status === "ok"));
  console.log("PASS built-in TLS, local readiness and doctor --json with certificate/database checks");

  const tlsBackend = await start("tls-backend", { CRAFTPANEL_PROFILE: "proxy", CRAFTPANEL_TLS_CERT: cert, CRAFTPANEL_TLS_KEY: key, CRAFTPANEL_TRUSTED_PROXIES: "127.0.0.1" });
  const insecureEdge = proxy(tlsBackend, certificates, false);
  const insecurePort = await listen(insecureEdge);
  response = await request(`http://127.0.0.1:${insecurePort}/api/auth/state`);
  assert.equal(response.status, 403, response.text);
  assert.equal(response.json().error.code, "https_required");
  console.log("PASS HTTP browser edge rejected even when the proxy-to-backend connection uses TLS");

  if (args.includes("--browser")) {
    const artifactRequire = createRequire(path.join(path.resolve(dist, "../../.."), "package.json"));
    const { chromium } = artifactRequire("@playwright/test");
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
    await context.addCookies([{ name: setCookie.split("=")[0], value: setCookie.split(";")[0].slice(setCookie.indexOf("=") + 1), url: origin, secure: true, httpOnly: true, sameSite: "Strict" }]);
    const page = await context.newPage();
    await page.goto(origin + "/settings/");
    await page.getByRole("tab", { name: "Remote access", exact: true }).click();
    await page.getByRole("heading", { name: "Deployment checks", exact: true }).waitFor();
    await page.getByText("This request arrived over HTTPS", { exact: true }).waitFor();
    const screenshot = path.resolve("test-results/screens/deployment-proxy.png");
    await fs.mkdir(path.dirname(screenshot), { recursive: true });
    await page.screenshot({ path: screenshot, fullPage: true });
    console.log(`PASS Remote access browser UI (${screenshot})`);
  }
  console.log("Deployment package smoke test passed.");
} finally {
  if (browser) await browser.close();
  for (const instance of processes.reverse()) {
    if (instance.child.exitCode !== null) continue;
    try {
      if (instance.runtime) {
        const stop = spawn(process.execPath, [path.join(dist, "runtime.js"), "--shutdown"], { cwd: dist, env: instance.env, windowsHide: true, stdio: "ignore" });
        await new Promise((resolve) => stop.once("close", resolve));
      } else {
      const control = JSON.parse(await fs.readFile(path.join(instance.data, "control.json"), "utf8"));
      await request(control.url + "/api/control/shutdown", { method: "POST", headers: { "x-craftpanel-control": control.token }, body: {} });
      }
    } catch { /* A failed startup may not have written a control file. */ }
    await Promise.race([instance.closed, pause(5_000)]);
    if (instance.child.exitCode === null) { instance.child.kill(); await instance.closed; }
  }
  for (const socket of sockets) socket.destroy();
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  await fs.rm(root, { recursive: true, force: true });
}
