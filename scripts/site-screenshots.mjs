// Captures dashboard screenshots for the website (apps/site/src/assets/screenshots) from a running CraftPanel.
// usage: node scripts/site-screenshots.mjs <base> <username> <password> <serverId>
// Use a throwaway instance on localhost with demo servers; never point this at a real install.
// The server should be running for a few minutes first (with players, if you can) so the performance charts have data.
// For the assistant shot a scripted model on localhost stands in for a provider; the instance's assistant settings are
// put back afterwards, and the shot is skipped when the instance has a real API key stored.
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { client } from "./real-tests/client.mjs";

const [base, username, password, serverId] = process.argv.slice(2);
if (!serverId) throw new Error("usage: site-screenshots.mjs <base> <username> <password> <serverId>");
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "../apps/site/src/assets/screenshots");

// The scripted model: look at the players, then ask to whitelist one (which waits for approval in the panel).
const model = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    const { messages } = JSON.parse(body);
    const tools = messages.filter((m) => m.role === "tool").length;
    const call = (name, args, content = null) => ({ choices: [{ finish_reason: "tool_calls", message: { content, tool_calls: [{ id: `call_${tools}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] });
    const reply =
      tools === 0 ? call("list_players", {})
      : tools === 1 ? call("player_action", { action: "whitelist-add", player: "Steve" }, "Alex, Sam and Mia are online and the whitelist is on. I'll add Steve so he can join too.")
      : { choices: [{ finish_reason: "stop", message: { content: "Okay, I left the whitelist as it is." } }] };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(reply));
  });
});
await new Promise((r) => model.listen(0, "127.0.0.1", r));
const api = client(base);
await api.signIn(username, password);
const savedAssistant = await api.call("GET", "/api/assistant/settings");

const browser = await chromium.launch();
try {
for (const scheme of ["dark", "light"]) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: scheme });
  await page.goto(`${base}/login/`);
  await page.getByLabel(/username/i).fill(username);
  await page.getByLabel(/password/i).fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
  // The Connect card lists this machine's addresses; show documentation addresses instead.
  const maskAddresses = () => page.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let i = 20;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) n.textContent = n.textContent.replace(/\b\d{1,3}(\.\d{1,3}){3}(?=:\d+)/g, () => `192.168.1.${i++}`);
  });
  const shots = [
    ["servers", "/servers/"],
    ["overview", `/server/?id=${serverId}`, maskAddresses],
    ["console", `/server/?id=${serverId}&tab=console`],
    ["performance", `/server/?id=${serverId}&tab=performance`],
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
    ["assistant", `/server/?id=${serverId}`, async () => {
      if (savedAssistant.apiKey) return false;
      await api.call("PUT", "/api/assistant/settings", {
        ...savedAssistant, enabled: true, provider: "openai-compatible", model: "local-model", apiKey: "",
        baseUrl: `http://127.0.0.1:${model.address().port}/v1`, approval: "always", minRole: "operator", maxSteps: 6,
      });
      await page.reload();
      await page.waitForLoadState("networkidle");
      await maskAddresses();
      await page.keyboard.press("Control+i");
      await page.getByLabel("Message to the assistant").fill("Whitelist Steve, he wants to join tonight");
      await page.getByLabel("Send").click();
      await page.getByRole("button", { name: "Approve" }).waitFor();
      await page.waitForTimeout(800);
    }],
  ];
  for (const [name, url, prepare] of shots) {
    await page.goto(base + url);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(2500);
    if ((await prepare?.()) === false) {
      console.log(`${name}-${scheme}.png skipped: the instance has an API key stored`);
      continue;
    }
    await page.screenshot({ path: path.join(out, `${name}-${scheme}.png`) });
    console.log(`${name}-${scheme}.png`);
    if (name === "assistant") {
      await page.getByRole("button", { name: "Decline" }).click();
      await page.waitForTimeout(1000);
      for (const c of await api.call("GET", "/api/assistant/conversations")) await api.call("DELETE", `/api/assistant/conversations/${c.id}`);
    }
  }
  await page.close();
}
} finally {
  await browser.close();
  if (!savedAssistant.apiKey) await api.call("PUT", "/api/assistant/settings", savedAssistant);
  model.close();
}
