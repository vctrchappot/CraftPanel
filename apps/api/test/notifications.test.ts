import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SMTPServer } from "smtp-server";
import type { AddressInfo } from "node:net";
import type { ActivityEvent } from "@craftpanel/shared";
import { isDiscordWebhook, NotificationService } from "../src/services/notifications";
import type { AppSettings, SettingsService } from "../src/services/settings";
import type { UpdateService, UpdateStatus } from "../src/services/updates";

const WEBHOOK = "https://discord.com/api/webhooks/123456789012345678/abcDEF_ghi-jkl";

function fakeSettings(over: Partial<AppSettings>) {
  let s = {
    notifyDiscordWebhook: "",
    notifyEmail: { enabled: false, host: "", port: 587, security: "starttls", username: "", password: "", from: "", to: "" },
    notifyEvents: ["server", "backup", "schedule", "update"],
    notifyLastUpdate: null,
    ...over,
  } as AppSettings;
  return {
    get: async () => s,
    set: async (p: Partial<AppSettings>) => (s = { ...s, ...p }),
  } as unknown as SettingsService;
}

function fakeFetch() {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  return { calls, fn };
}

const noUpdates = { status: async () => ({ enabled: false }) } as unknown as UpdateService;
const event = (kind: string, serverId: string | null = "s1", message = "Exit code 1"): ActivityEvent => ({ id: 1, serverId, kind, level: "error", message, actor: null, createdAt: Date.now() });

describe("Discord webhooks", () => {
  it("accepts only Discord webhook URLs", () => {
    expect(isDiscordWebhook(WEBHOOK)).toBe(true);
    expect(isDiscordWebhook("https://canary.discord.com/api/webhooks/1/x")).toBe(true);
    expect(isDiscordWebhook("http://discord.com/api/webhooks/1/x")).toBe(false);
    expect(isDiscordWebhook("https://discord.com.evil.example/api/webhooks/1/x")).toBe(false);
    expect(isDiscordWebhook("https://discord.com/api/users/@me")).toBe(false);
    expect(isDiscordWebhook("not a url")).toBe(false);
  });

  it("posts an embed for a crash, without mentions, once per crash loop", async () => {
    const f = fakeFetch();
    const n = new NotificationService(fakeSettings({ notifyDiscordWebhook: WEBHOOK }), noUpdates, f.fn);
    await n.onEvent(event("server.crashed", "s1", "@everyone Exit code 1"), "Survival");
    await n.onEvent(event("server.crashed"), "Survival");
    await n.onEvent(event("server.crashed", "s2"), "Creative");
    await n.onEvent(event("server.running"), "Survival");
    expect(f.calls).toHaveLength(2);
    expect(f.calls[0].url).toBe(WEBHOOK);
    expect(f.calls[0].body).toMatchObject({ username: "CraftPanel", allowed_mentions: { parse: [] } });
    const embed = (f.calls[0].body.embeds as Record<string, unknown>[])[0];
    expect(embed).toMatchObject({ title: "Server crashed", description: "@everyone Exit code 1", fields: [{ name: "Server", value: "Survival" }] });
  });

  it("respects the chosen categories", async () => {
    const f = fakeFetch();
    const n = new NotificationService(fakeSettings({ notifyDiscordWebhook: WEBHOOK, notifyEvents: ["backup"] }), noUpdates, f.fn);
    await n.onEvent(event("server.crashed"), "Survival");
    await n.onEvent(event("backup.failed"), "Survival");
    expect(f.calls.map((c) => (c.body.embeds as { title: string }[])[0].title)).toEqual(["Backup failed"]);
  });

  it("reports a failing webhook instead of throwing", async () => {
    const failing = (async () => new Response(null, { status: 404 })) as unknown as typeof fetch;
    const n = new NotificationService(fakeSettings({ notifyDiscordWebhook: WEBHOOK }), noUpdates, failing);
    expect(await n.send({ title: "t", message: "m", level: "info" })).toEqual([{ channel: "discord", ok: false, error: "Discord answered HTTP 404" }]);
  });

  it("announces each new CraftPanel release once", async () => {
    const f = fakeFetch();
    const status: UpdateStatus = {
      enabled: true,
      current: "0.1.0",
      latest: "0.2.0",
      available: true,
      releaseUrl: "https://github.com/x/releases/tag/v0.2.0",
      notes: null,
      source: "github",
      canInstall: false,
      lastResult: null,
      publishedAt: null,
      checkedAt: Date.now(),
      error: null,
      install: { method: "linux-service", updateCommand: "sudo /opt/craftpanel/update.sh" },
    };
    const n = new NotificationService(fakeSettings({ notifyDiscordWebhook: WEBHOOK }), { status: async () => status } as unknown as UpdateService, f.fn);
    await n.checkUpdate();
    await n.checkUpdate();
    expect(f.calls).toHaveLength(1);
    const embed = (f.calls[0].body.embeds as Record<string, string>[])[0];
    expect(embed.title).toBe("CraftPanel 0.2.0 is available");
    expect(embed.description).toContain("sudo /opt/craftpanel/update.sh");
  });
});

describe("e-mail", () => {
  const received: { from: string; to: string[]; data: string; user?: string }[] = [];
  let smtp: SMTPServer;
  let port: number;

  beforeAll(async () => {
    smtp = new SMTPServer({
      secure: false,
      disabledCommands: ["STARTTLS"],
      authOptional: true,
      allowInsecureAuth: true,
      onAuth(auth, _session, cb) {
        if (auth.username === "mailer" && auth.password === "secret") return cb(null, { user: auth.username });
        cb(new Error("Invalid login"));
      },
      onData(stream, session, cb) {
        let data = "";
        stream.on("data", (c: Buffer) => (data += c.toString("utf8")));
        stream.on("end", () => {
          received.push({ from: session.envelope.mailFrom ? session.envelope.mailFrom.address : "", to: session.envelope.rcptTo.map((r) => r.address), data, user: session.user as string | undefined });
          cb();
        });
      },
    });
    await new Promise<void>((r) => smtp.listen(0, "127.0.0.1", r));
    port = (smtp.server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => smtp.close(() => r())));

  it("sends through a real SMTP server with login", async () => {
    const n = new NotificationService(
      fakeSettings({ notifyEmail: { enabled: true, host: "127.0.0.1", port, security: "none", username: "mailer", password: "secret", from: "panel@example.test", to: "admin@example.test, mod@example.test" } }),
      noUpdates,
    );
    await n.onEvent(event("backup.failed", "s1", "Disk full"), "Survival");
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ from: "panel@example.test", to: ["admin@example.test", "mod@example.test"], user: "mailer" });
    expect(received[0].data).toContain("Subject: [CraftPanel] Backup failed - Survival");
    expect(received[0].data).toContain("Disk full");
  });

  it("reports a wrong password", async () => {
    const n = new NotificationService(
      fakeSettings({ notifyEmail: { enabled: true, host: "127.0.0.1", port, security: "none", username: "mailer", password: "wrong", from: "", to: "a@example.test" } }),
      noUpdates,
    );
    const [r] = await n.send({ title: "t", message: "m", level: "info" });
    expect(r.channel).toBe("email");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Invalid login|auth/i);
  });
});
