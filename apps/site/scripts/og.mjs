// Renders scripts/og.html to public/og.png (the social preview image). Needs Playwright's Chromium.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const { chromium } = createRequire(path.join(here, "../../../package.json"))("@playwright/test");
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await page.goto(pathToFileURL(path.join(here, "og.html")).href);
await page.addStyleTag({ url: pathToFileURL(path.join(here, "../node_modules/@fontsource-variable/inter/index.css")).href });
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: path.join(here, "../public/og.png") });
await browser.close();
console.log("public/og.png");
