// Smoke test of the built website: serves apps/site/dist and opens every page at a phone and a desktop width.
//
//   pnpm --filter @craftpanel/site build && pnpm --filter @craftpanel/site smoke
//
// Per page and width it fails on: a script or console error, a same-origin request that fails or answers with an
// error, horizontal overflow, a missing <h1>, and, on pages with scroll reveals, an element that stays hidden after
// the page was scrolled through. A last pass with reduced motion checks that nothing waits to be revealed.
// Needs Chromium (`pnpm exec playwright install chromium`, or SMOKE_CHROMIUM_PATH).
import { chromium } from "@playwright/test";
import { preview } from "astro";
import { readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const port = Number(process.env.SMOKE_PORT ?? 4399);
const origin = `http://127.0.0.1:${port}`;

/** URL path of every built page (`dist/docs/guides/players/index.html` → `/docs/guides/players/`). */
function pages(dir = dist) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...pages(full));
    else if (entry.name === "index.html") out.push(`/${relative(dist, dir).split("\\").join("/")}/`.replace("//", "/"));
  }
  return out.sort();
}

const viewports = [
  { name: "phone", width: 390, height: 800, mobile: true },
  { name: "desktop", width: 1440, height: 900, mobile: false },
];

const failures = [];
const fail = (where, what) => failures.push(`${where}: ${what}`);

/** Scrolls the page through so scroll reveals fire, then lets the last transitions finish (about 0.8 s with their delay). */
async function scrollThrough(page) {
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y < height; y += 450) {
    await page.evaluate((top) => scrollTo(0, top), y);
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(1000);
}

async function check(context, path, label, { reducedMotion = false } = {}) {
  const where = `${label} ${path}`;
  const page = await context.newPage();
  page.on("pageerror", (e) => fail(where, `script error: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && fail(where, `console error: ${m.text()}`));
  page.on("requestfailed", (r) => r.url().startsWith(origin) && fail(where, `request failed: ${r.url()}`));
  page.on("response", (r) => r.url().startsWith(origin) && r.status() >= 400 && fail(where, `${r.status()} for ${r.url()}`));
  try {
    await page.goto(origin + path, { waitUntil: "load", timeout: 30_000 });
    // Only pages with scroll reveals need the scroll-through; the others are checked as they load.
    if (await page.evaluate(() => document.querySelector("[data-reveal]") !== null || document.documentElement.classList.contains("motion"))) await scrollThrough(page);
    else await page.waitForTimeout(300);
    const state = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - innerWidth,
      h1: document.querySelectorAll("h1").length,
      motion: document.documentElement.classList.contains("motion"),
      hidden: [...document.querySelectorAll("[data-reveal]")]
        .filter((el) => !el.classList.contains("is-in"))
        .map((el) => `${el.tagName.toLowerCase()}.${[...el.classList].join(".")}`)
        .slice(0, 5),
      total: document.querySelectorAll("[data-reveal]").length,
    }));
    if (state.overflow > 0) fail(where, `page is ${state.overflow}px wider than the screen`);
    if (state.h1 < 1) fail(where, "no <h1>");
    if (reducedMotion) {
      if (state.motion || state.total > 0) fail(where, "reveals are set up although reduced motion is requested");
    } else if (state.hidden.length) {
      fail(where, `${state.hidden.length}+ of ${state.total} reveal elements stayed hidden, e.g. ${state.hidden.join(", ")}`);
    }
  } catch (error) {
    fail(where, `could not be checked: ${error.message.split("\n")[0]}`);
  } finally {
    await page.close();
  }
}

const list = pages();
if (!list.length) {
  console.error("No built pages found in apps/site/dist. Build the site first.");
  process.exit(2);
}
const server = await preview({ root, logLevel: "error", server: { host: "127.0.0.1", port } });
// SMOKE_CHROMIUM_PATH points at an existing Chromium when the one Playwright expects isn't installed.
const browser = await chromium.launch({ executablePath: process.env.SMOKE_CHROMIUM_PATH || undefined });
try {
  for (const v of viewports) {
    const context = await browser.newContext({ viewport: { width: v.width, height: v.height }, isMobile: v.mobile, hasTouch: v.mobile });
    for (const path of list) await check(context, path, v.name);
    await context.close();
  }
  const reduced = await browser.newContext({ viewport: { width: 390, height: 800 }, reducedMotion: "reduce" });
  await check(reduced, "/", "phone, reduced motion", { reducedMotion: true });
  await reduced.close();
} finally {
  await browser.close();
  await server.stop();
}

console.log(`${list.length} pages at ${viewports.map((v) => v.width).join(" and ")} px, plus reduced motion.`);
if (failures.length) {
  console.error(`\n${failures.length} problem(s):\n${failures.map((f) => `  - ${f}`).join("\n")}`);
  process.exit(1);
}
console.log("No problems found.");
