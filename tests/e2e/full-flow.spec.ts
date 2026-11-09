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

  // Settings: change MOTD via the validated editor
  await tab(page, "Settings").click();
  await page.getByLabel(/Message of the day/).fill("Edited by Playwright");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText(/Restart the server to apply/)).toBeVisible();
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
