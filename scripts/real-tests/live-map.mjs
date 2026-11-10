// Run against a throwaway local instance. CP_MAP_SERVER may select a prepared fixture instead of downloading Paper.
import assert from "node:assert/strict";
import { client } from "./client.mjs";

const [base = "http://127.0.0.1:8241", version = "1.21.11", port = "25841"] = process.argv.slice(2);
const c = client(base);
await c.signIn();
const s = process.env.CP_MAP_SERVER ? await c.server(process.env.CP_MAP_SERVER) : await c.create({ name: "Live map test", software: "paper", mcVersion: version, port: Number(port), memoryMb: 3072 });
await c.waitInstalled(s.id);
const endpoint = `/api/servers/${s.id}/map`;
const status = () => c.call("GET", endpoint);
const checks = [];
const check = (condition, message) => { assert.ok(condition, message); checks.push(message); console.log("PASS " + message); };
const get = (url) => fetch(base + url, { redirect: "manual" });
async function waitFor(fn, message, ms = 240_000) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > ms) throw new Error(`Timed out: ${message}`);
    await c.sleep(2000);
  }
}

try {
  check(!(await status()).pageReady, "Map page is hidden before activation");
  await c.call("POST", endpoint + "/install", { acceptMojangEula: true });
  let m = await waitFor(async () => {
    const result = await status();
    if (result.setupError) throw new Error(result.setupError);
    return result.pageReady && result.webserver ? result : null;
  }, "BlueMap setup and webserver");
  check(m.installed && m.configReady && m.serverRunning, "Activation configures BlueMap and starts Paper automatically");
  check(m.threads === 1 && m.settings.radius === 3000, "Initial CPU and area limits apply");
  check((await get(m.url)).status === 401, "Anonymous visitors cannot open a private map");
  const privateLink = (await c.call("POST", endpoint + "/link")).url;
  const wrapper = await (await get(privateLink)).text();
  check(wrapper.includes('sandbox="allow-scripts allow-pointer-lock"') && !wrapper.includes("allow-same-origin"), "Viewer is isolated from dashboard cookies and storage");
  const document = await get(privateLink + "v/");
  const html = await document.text();
  check(document.status === 200 && html.includes("map-container"), "Real BlueMap viewer is served through CraftPanel");
  const asset = /src="\.\/(assets\/[^"]+\.js)"/.exec(html)?.[1];
  check(!!asset && (await get(privateLink + "v/" + asset)).status === 200, "Viewer JavaScript works below the protected map path");

  // Give the renderer a known saved change at the test camera's centre.
  await c.command(s.id, "forceload add -16 -16 16 16");
  await waitFor(async () => {
    await c.command(s.id, "fill 0 150 0 15 150 15 minecraft:gold_block");
    return (await c.log(s.id))?.some((line) => /Successfully filled|No blocks were filled/.test(line.text));
  }, "test terrain at the origin", 60_000);
  const savedAfter = Date.now();
  await c.command(s.id, "save-all flush");
  await waitFor(async () => (await c.log(s.id))?.some((line) => line.ts >= savedAfter && /Saved the game/.test(line.text)), "world flush before rendering", 60_000);

  await c.call("PUT", endpoint, { ...m.settings, radius: 500, detail: "2d", nether: false, end: false, players: false, access: "public" });
  const publicPath = `/map/${s.id}/t/public/v/`;
  const settings = await waitFor(async () => {
    const r = await get(publicPath + "settings.json");
    if (r.status !== 200) return null;
    const data = await r.json();
    return data.maps.length === 1 && data.defaultToFlatView ? data : null;
  }, "2D settings after reload");
  check(settings.maps.length === 1, "Disabled dimensions disappear from public map settings");
  check((await get(publicPath + "maps/world_nether/settings.json")).status === 404, "Previously rendered disabled dimensions cannot be requested directly");
  check((await (await get(publicPath + "maps/world/live/players.json")).json()).players.length === 0, "Player position endpoint is empty when live players are disabled");
  const mapSettings = await (await get(publicPath + `maps/${settings.maps[0]}/settings.json`)).json();
  check(mapSettings.flatView && !mapSettings.perspectiveView && !mapSettings.freeFlightView, "BlueMap applies flat-only rendering to the actual map");
  await c.call("POST", endpoint + "/action", { action: "pause" });
  check((await status()).paused, "Rendering can be paused without stopping Minecraft");
  await c.call("POST", endpoint + "/action", { action: "resume" });
  check(!(await status()).paused, "Rendering resumes");
  await c.call("POST", endpoint + "/action", { action: "rerender" });
  await c.call("POST", endpoint + "/action", { action: "update" });

  m = await status();
  await c.call("PUT", endpoint, { ...m.settings, password: "map-test-password" });
  check((await get(publicPath + "settings.json")).status === 401, "Adding a password immediately revokes open public access");
  const unlock = await fetch(`${base}/map/${s.id}/unlock`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "password=map-test-password", redirect: "manual" });
  check(unlock.status === 303 && (await get(unlock.headers.get("location") + "v/settings.json")).status === 200, "Map password unlocks the real viewer");

  if (process.argv.includes("--browser")) {
    const { chromium } = await import("@playwright/test");
    const browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-swiftshader"] });
    try {
      const page = await browser.newPage();
      const errors = [];
      let tileLoaded = false;
      page.on("pageerror", (err) => { errors.push(err.message); console.log("BROWSER ERROR " + err.message); });
      page.on("console", (message) => { if (message.type() === "error") { errors.push(message.text()); console.log("BROWSER CONSOLE " + message.text()); } });
      page.on("response", (r) => { if (r.url().includes("/tiles/") && r.status() === 200) tileLoaded = true; });
      // Settings changes revoke the old link. Open a fresh session-bound link for this browser check.
      const fresh = (await c.call("POST", endpoint + "/link")).url;
      await page.goto(base + fresh);
      await waitFor(async () => {
        for (const frame of page.frames()) {
          if (await frame.locator(".bm-app-err-main").count()) throw new Error(await frame.locator("body").innerText());
          if (await frame.locator("canvas").count() && !await frame.getByText("Loading map...", { exact: true }).isVisible() && tileLoaded) {
            const pixels = await frame.evaluate(() => {
              const gl = window.bluemap.mapViewer.renderer.getContext();
              const data = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
              gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, data);
              let count = 0;
              for (let i = 0; i < data.length; i += 4) if (data[i] > 20 || data[i + 1] > 20 || data[i + 2] > 20) count++;
              return count;
            });
            if (pixels > 100) return true;
          }
        }
        return false;
      }, "WebGL terrain pixels", 90_000);
      check(errors.length === 0, `BlueMap loads rendered terrain in its WebGL viewer without script errors (${errors.join("; ")})`);
      await page.screenshot({ path: "test-results/live-map-viewer.png" });
    } finally { await browser.close(); }
  }
  console.log(`${checks.length} live-map checks passed (${s.id}).`);
} finally {
  if ((await c.server(s.id)).status === "running") await c.stop(s.id);
}
