// Captures dashboard screenshots for the website (apps/site/src/assets/screenshots) from a running CraftPanel.
// usage: node scripts/site-screenshots.mjs <base> <username> <password> <serverId>
// Use a throwaway instance on localhost with demo servers; never point this at a real install.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const [base, username, password, serverId] = process.argv.slice(2);
if (!serverId) throw new Error("usage: site-screenshots.mjs <base> <username> <password> <serverId>");
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "../apps/site/src/assets/screenshots");

const browser = await chromium.launch();
for (const scheme of ["dark", "light"]) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: scheme });
  await page.goto(`${base}/login/`);
  await page.getByLabel(/username/i).fill(username);
  await page.getByLabel(/password/i).fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
  const shots = [
    ["servers", "/servers/"],
    // The Connect card lists this machine's addresses; show documentation addresses instead.
    ["overview", `/server/?id=${serverId}`, () => page.evaluate(() => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let i = 20;
      for (let n = walker.nextNode(); n; n = walker.nextNode()) n.textContent = n.textContent.replace(/\b\d{1,3}(\.\d{1,3}){3}(?=:\d+)/g, () => `192.168.1.${i++}`);
    })],
    ["console", `/server/?id=${serverId}&tab=console`],
    ["plugins", `/server/?id=${serverId}&tab=plugins`, async () => {
      await page.getByRole("tab", { name: "Browse" }).click();
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(2500);
    }],
    ["new-server", "/servers/new/", async () => {
      await page.getByLabel("Server name").fill("Survival with friends");
      await page.getByRole("button", { name: /continue/i }).click();
      await page.waitForTimeout(1000);
    }],
  ];
  for (const [name, url, prepare] of shots) {
    await page.goto(base + url);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(2500);
    await prepare?.();
    await page.screenshot({ path: path.join(out, `${name}-${scheme}.png`) });
    console.log(`${name}-${scheme}.png`);
  }
  await page.close();
}
await browser.close();
