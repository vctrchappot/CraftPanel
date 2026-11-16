import { expect, test } from "@playwright/test";

const tab = (page: import("@playwright/test").Page, name: string) => page.getByRole("navigation", { name: "Server sections" }).getByRole("link", { name: new RegExp("^" + name) });
const shot = (name: string) => ({ path: `test-results/screens/${name}.png`, fullPage: true });

/**
 * The primary success path: set up CraftPanel, create a real Vanilla server
 * through the wizard, accept the EULA, start it, send a console command,
 * change a setting, back it up, stop it and restore the backup.
 */
test("create, run, configure, back up and restore a real server", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/setup\/$/);
  await page.getByLabel("Username").fill("owner");
  await page.getByLabel("Password", { exact: true }).fill("e2e-password-123");
  await page.getByLabel("Confirm password").fill("e2e-password-123");
  await page.screenshot(shot("01-setup"));
  await page.getByRole("button", { name: "Create owner account" }).click();

  // Wizard
  await expect(page.getByRole("heading", { name: "Create a server" })).toBeVisible();
  await page.getByLabel("Server name").fill("E2E Vanilla");
  await page.screenshot(shot("02-wizard-basics"));
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: /^Vanilla/ }).click();
  await page.screenshot(shot("03-wizard-software"));
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText(/Requires Java \d+/)).toBeVisible({ timeout: 30_000 });
  await page.screenshot(shot("04-wizard-version"));
  for (let i = 0; i < 4; i++) await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Port").fill("25580");
  await page.screenshot(shot("05-wizard-network"));
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("checkbox").check();
  await page.screenshot(shot("06-wizard-review"));
  await page.getByRole("button", { name: "Create server" }).click();

  // Installation (downloads the official jar and, if needed, Java)
  await expect(page).toHaveURL(/\/server\/\?id=/);
  const serverId = new URL(page.url()).searchParams.get("id")!;
  await page.screenshot(shot("07-installing"));
  const start = page.getByRole("button", { name: "Start", exact: true });
  await expect(start).toBeVisible({ timeout: 10 * 60 * 1000 });
  await start.click();
  await expect(page.getByRole("main").getByText("Running", { exact: true }).first()).toBeVisible({ timeout: 3 * 60 * 1000 });
  await page.waitForTimeout(6000);
  await page.screenshot(shot("08-overview-running"));

  // Console
  await tab(page, "Console").click();
  const input = page.getByLabel("Minecraft command");
  await input.fill("say hello from playwright");
  await input.press("Enter");
  await expect(page.getByRole("log").getByText(/\[Server\] hello from playwright/)).toBeVisible();
  await page.screenshot(shot("09-console"));

  // Settings open on Appearance: change the message of the day with the colour tools
  await tab(page, "Settings").click();
  await page.getByLabel("Message", { exact: true }).fill("Edited by Playwright");
  await page.getByRole("group", { name: "Effects" }).getByRole("button", { name: "Rainbow" }).click();
  await page.getByRole("button", { name: "Save message" }).click();
  await expect(page.getByText(/Restart the server to show the new message/)).toBeVisible();
  await page.screenshot(shot("10-settings"));

  // Players tab renders
  await tab(page, "Players").click();
  await expect(page.getByText("Online (0)")).toBeVisible();

  // Backup while running
  await tab(page, "Backups").click();
  await page.getByRole("button", { name: "Back up now" }).click();
  await expect(page.getByText("Complete").first()).toBeVisible({ timeout: 120_000 });
  await page.screenshot(shot("11-backups"));

  // Stop
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.getByRole("button", { name: "Start", exact: true })).toBeVisible({ timeout: 120_000 });

  // Restore
  await page.getByRole("button", { name: "Backup actions" }).first().click();
  await page.getByRole("menuitem", { name: "Restore…" }).click();
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(page.getByText("Backup restored")).toBeVisible({ timeout: 120_000 });
  await expect(page.getByRole("cell", { name: "Before restore", exact: true })).toBeVisible();
  await page.screenshot(shot("12-restored"));

  // Global pages
  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Overview" }).click();
  await expect(page.getByText("E2E Vanilla").first()).toBeVisible();
  await page.screenshot(shot("13-home"));
  await page.goto("/activity/");
  await expect(page.getByText(/Restored backup/).first()).toBeVisible();
  await page.screenshot(shot("14-activity"));

  // The maintenance action saves/stops the real server from global settings.
  await page.goto(`/server/?id=${serverId}`);
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expect(page.getByRole("main").getByText("Running", { exact: true }).first()).toBeVisible({ timeout: 3 * 60 * 1000 });
  await page.goto("/settings/?tab=about");
  await page.getByRole("button", { name: "Stop all servers for maintenance" }).click();
  const maintenance = page.getByRole("dialog");
  await expect(maintenance.getByText("E2E Vanilla", { exact: true })).toBeVisible();
  await page.screenshot(shot("15-runtime-maintenance"));
  await maintenance.getByRole("button", { name: "Save and stop all servers" }).click();
  await expect(page.getByText("All Minecraft servers stopped", { exact: true })).toBeVisible({ timeout: 120_000 });
  await page.goto(`/server/?id=${serverId}`);
  await expect(page.getByRole("button", { name: "Start", exact: true })).toBeVisible();

  // Exercise preview wording/controls with controlled release metadata; never install a release here.
  let interruption: "required" | "none" | "unknown" = "required";
  await page.route("**/api/updates?*", async (route) => route.fulfill({ json: {
    enabled: true, current: "0.1.0", latest: "999.0.0", available: true, canInstall: true,
    source: "folder", install: { method: "linux-service", updateCommand: "update.sh" },
    runtime: { protocol: 1, sha256: "a".repeat(64) }, interruption,
    affectedServers: [{ id: serverId, name: "E2E Vanilla", autoStart: false }],
  } }));
  await page.route("**/api/updates", async (route) => route.fulfill({ json: {
    enabled: true, current: "0.1.0", latest: "999.0.0", available: true, canInstall: true,
    source: "folder", install: { method: "linux-service", updateCommand: "update.sh" },
    runtime: { protocol: 1, sha256: "a".repeat(64) }, interruption,
    affectedServers: [{ id: serverId, name: "E2E Vanilla", autoStart: false }],
  } }));
  for (const state of ["required", "none", "unknown"] as const) {
    interruption = state;
    await page.goto("/settings/?tab=about");
    await page.getByRole("button", { name: "Update now", exact: true }).click();
    const preview = page.getByRole("dialog");
    if (state === "required") {
      await expect(preview.getByText("E2E Vanilla", { exact: true })).toBeVisible();
      await expect(preview.getByRole("button", { name: "Stop affected servers and update" })).toBeEnabled();
    } else if (state === "none") {
      await expect(preview.getByRole("button", { name: "Update dashboard", exact: true })).toBeEnabled();
      await expect(preview.getByText("Dashboard update", { exact: true })).toBeVisible();
    } else {
      await expect(preview.getByText("Interruption could not be determined", { exact: true })).toBeVisible();
      await expect(preview.getByRole("button", { name: "Stop affected servers and update" })).toBeDisabled();
    }
    await page.screenshot(shot(`16-update-preview-${state}`));
    await preview.getByRole("button", { name: "Later", exact: true }).click();
  }
});

test("application backup schedules can be created, run, paused and removed", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // The real-server flow can use most of the shared per-IP budget on fast runners.
  // Start this separate browser session with enough budget for its assets and controls.
  await expect.poll(async () => {
    const response = await page.request.get("/api/auth/state");
    return Number(response.headers()["x-ratelimit-remaining"] ?? 0);
  }, { timeout: 70_000, intervals: [1000] }).toBeGreaterThan(400);
  const state = await (await page.request.get("/api/auth/state")).json();
  const login = await page.request.post(state.setupRequired ? "/api/auth/setup" : "/api/auth/login", { data: { username: "owner", password: "e2e-password-123" } });
  expect(login.ok()).toBe(true);
  await page.goto("/settings/?tab=backups");
  await page.getByRole("button", { name: "Add schedule", exact: true }).click();
  const editor = page.getByRole("dialog");
  await editor.getByLabel("Name", { exact: true }).fill("E2E application backup");
  await editor.getByRole("button", { name: "Every 6 hours", exact: true }).click();
  await expect(editor.getByLabel("Schedule", { exact: true })).toHaveValue("0 */6 * * *");
  await editor.getByLabel("Backups to keep", { exact: true }).fill("2");
  await editor.getByRole("switch").click(); // Settings-only keeps this UI scenario quick.
  await editor.getByRole("button", { name: "Save schedule", exact: true }).click();
  await expect(editor).not.toBeVisible();
  await expect(page.getByText("E2E application backup", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Run E2E application backup now", exact: true }).click();
  await page.getByRole("button", { name: "History of E2E application backup", exact: true }).click();
  const history = page.getByRole("dialog");
  await expect(history.getByText("success", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(history.getByText(/^Created craftpanel-app-/)).toBeVisible();
  await history.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("switch", { name: "Enable E2E application backup", exact: true }).click();
  await expect(page.getByRole("switch", { name: "Enable E2E application backup", exact: true })).not.toBeChecked();
  await page.getByRole("button", { name: "Edit E2E application backup", exact: true }).click();
  await editor.getByLabel("Name", { exact: true }).fill("E2E weekly application backup");
  await editor.getByRole("button", { name: "Sundays at 03:00", exact: true }).click();
  await editor.getByRole("button", { name: "Save schedule", exact: true }).click();
  await expect(page.getByText("E2E weekly application backup", { exact: true })).toBeVisible();
  // Let transient save messages clear before recording the layout.
  await expect(page.getByText("Backup schedule saved", { exact: true })).toHaveCount(0, { timeout: 10_000 });
  for (const [width, theme] of [[1440, "dark"], [390, "light"]] as const) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate((value) => { document.documentElement.classList.toggle("dark", value === "dark"); }, theme);
    const panel = page.getByText("Automatic application backups", { exact: true }).locator("../../..");
    await expect(panel.getByRole("button", { name: "Add schedule" })).toBeVisible();
    expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    const bounds = await panel.evaluate((element) => {
      const parents = [];
      for (let parent: Element | null = element; parent; parent = parent.parentElement) parents.push({ tag: parent.tagName, class: parent.className, width: parent.getBoundingClientRect().width });
      return { right: element.getBoundingClientRect().right, viewport: window.innerWidth, parents };
    });
    expect(bounds.right, JSON.stringify(bounds)).toBeLessThanOrEqual(bounds.viewport + 1);
    await page.screenshot(shot(`17-app-backups-${theme}-${width}`));
  }
  await page.getByRole("button", { name: "Delete schedule E2E weekly application backup", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByText("E2E weekly application backup", { exact: true })).not.toBeVisible();
  await expect(page.getByText("Scheduled", { exact: true }).first()).toBeVisible(); // Deleting the schedule keeps its backup.
  expect(errors).toEqual([]);
});
