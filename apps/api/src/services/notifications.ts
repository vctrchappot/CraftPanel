import nodemailer from "nodemailer";
import type { ActivityEvent, NotificationCategory } from "@craftpanel/shared";
import type { EmailSettings, SettingsService } from "./settings";
import type { UpdateService } from "./updates";

/** Which activity events notify, by category. */
const EVENT_CATEGORY: Record<string, NotificationCategory> = {
  "server.crashed": "server",
  "server.lost": "server",
  "server.error": "server",
  "server.autostart_failed": "server",
  "server.restart_failed": "server",
  "server.install_failed": "server",
  "backup.failed": "backup",
  "schedule.error": "schedule",
  "ddns.failed": "schedule",
  "craftpanel.updated": "update",
  "craftpanel.update_failed": "update",
};

const TITLES: Record<string, string> = {
  "server.crashed": "Server crashed",
  "server.lost": "Server stopped unexpectedly",
  "server.error": "Server failed to start",
  "server.autostart_failed": "Automatic start failed",
  "server.restart_failed": "Restart failed",
  "server.install_failed": "Installation failed",
  "backup.failed": "Backup failed",
  "schedule.error": "Scheduled task failed",
  "ddns.failed": "Dynamic DNS update failed",
  "craftpanel.updated": "CraftPanel updated",
  "craftpanel.update_failed": "CraftPanel update failed",
};

export interface Notification {
  title: string;
  message: string;
  level: "info" | "warn" | "error";
  server?: string | null;
}

export interface ChannelResult {
  channel: "discord" | "email";
  ok: boolean;
  error?: string;
}

/** The same problem on the same server notifies at most once in this window (crash loops). */
const REPEAT_WINDOW_MS = 10 * 60_000;
const UPDATE_CHECK_MS = 6 * 3600_000;

const DISCORD_HOSTS = ["discord.com", "discordapp.com", "ptb.discord.com", "canary.discord.com"];

export function isDiscordWebhook(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && DISCORD_HOSTS.includes(u.hostname) && /^\/api\/webhooks\/\d+\/[\w-]+\/?$/.test(u.pathname);
  } catch {
    return false;
  }
}

/** Discord embed colours for each level. */
const COLORS = { info: 0x3b82f6, warn: 0xf59e0b, error: 0xef4444 };

/**
 * Sends notifications to Discord (webhook) and e-mail (SMTP) for problems
 * that need attention: crashes and failed starts, failed backups, failing
 * scheduled tasks, and new CraftPanel releases.
 */
export class NotificationService {
  private recent = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private settings: SettingsService,
    private updates: UpdateService,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  /** Called for every activity event. */
  async onEvent(event: ActivityEvent, serverName: string | null) {
    const category = EVENT_CATEGORY[event.kind];
    if (!category) return;
    const s = await this.settings.get();
    if (!s.notifyEvents.includes(category) || !this.configured(s)) return;
    const key = `${event.kind}:${event.serverId ?? ""}`;
    const now = Date.now();
    if (now - (this.recent.get(key) ?? 0) < REPEAT_WINDOW_MS) return;
    this.recent.set(key, now);
    await this.send({ title: TITLES[event.kind] ?? event.kind, message: event.message, level: event.level === "info" && event.kind !== "craftpanel.updated" ? "warn" : event.level, server: serverName });
  }

  /** Periodically look for a new CraftPanel release and notify once per version. */
  start() {
    const tick = () => void this.checkUpdate().catch(() => undefined);
    setTimeout(tick, 60_000).unref();
    this.timer = setInterval(tick, UPDATE_CHECK_MS);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  async checkUpdate() {
    const s = await this.settings.get();
    if (!s.notifyEvents.includes("update") || !this.configured(s)) return;
    const status = await this.updates.status(false);
    if (!status.enabled || !status.available || !status.latest) return;
    if (s.notifyLastUpdate === status.latest) return;
    await this.settings.set({ notifyLastUpdate: status.latest });
    const command = status.install.updateCommand;
    await this.send({
      title: `CraftPanel ${status.latest} is available`,
      message: `You are running ${status.current}.${command ? `\nUpdate with: ${command}` : ""}${status.releaseUrl ? `\n${status.releaseUrl}` : ""}`,
      level: "info",
    });
  }

  private configured(s: Awaited<ReturnType<SettingsService["get"]>>) {
    return !!s.notifyDiscordWebhook || (s.notifyEmail.enabled && !!s.notifyEmail.host && !!s.notifyEmail.to);
  }

  /** Send to every configured channel. Failures are returned, not thrown. */
  async send(n: Notification): Promise<ChannelResult[]> {
    const s = await this.settings.get();
    const results: ChannelResult[] = [];
    if (s.notifyDiscordWebhook) results.push(await this.discord(s.notifyDiscordWebhook, n));
    if (s.notifyEmail.enabled && s.notifyEmail.host && s.notifyEmail.to) results.push(await this.email(s.notifyEmail, n));
    return results;
  }

  private async discord(webhook: string, n: Notification): Promise<ChannelResult> {
    try {
      if (!isDiscordWebhook(webhook)) throw new Error("Not a Discord webhook URL");
      const res = await this.fetchImpl(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "CraftPanel",
          // Never let a server name or log message ping @everyone or a role.
          allowed_mentions: { parse: [] },
          embeds: [
            {
              title: n.title.slice(0, 256),
              description: n.message.slice(0, 4000),
              color: COLORS[n.level],
              fields: n.server ? [{ name: "Server", value: n.server.slice(0, 1024), inline: true }] : [],
              timestamp: new Date().toISOString(),
            },
          ],
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`Discord answered HTTP ${res.status}`);
      return { channel: "discord", ok: true };
    } catch (err) {
      return { channel: "discord", ok: false, error: (err as Error).message };
    }
  }

  private async email(cfg: EmailSettings, n: Notification): Promise<ChannelResult> {
    try {
      const transport = nodemailer.createTransport({
        host: cfg.host,
        port: cfg.port,
        secure: cfg.security === "tls",
        requireTLS: cfg.security === "starttls",
        ignoreTLS: cfg.security === "none",
        auth: cfg.username ? { user: cfg.username, pass: cfg.password } : undefined,
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 15_000,
      });
      const subject = `[CraftPanel] ${n.title}${n.server ? ` - ${n.server}` : ""}`;
      const text = `${n.title}${n.server ? `\nServer: ${n.server}` : ""}\n\n${n.message}\n\n— CraftPanel`;
      await transport.sendMail({ from: cfg.from || cfg.username || `craftpanel@${cfg.host}`, to: cfg.to, subject, text });
      transport.close();
      return { channel: "email", ok: true };
    } catch (err) {
      return { channel: "email", ok: false, error: (err as Error).message };
    }
  }
}

