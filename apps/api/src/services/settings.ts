import { appSettings, eq, type Database } from "@craftpanel/database";
import type { AccessPolicy } from "@craftpanel/network";
import { ASSISTANT_DEFAULTS, NOTIFICATION_CATEGORIES, type AssistantSettings, type NotificationCategory, type Role } from "@craftpanel/shared";

export interface EmailSettings {
  enabled: boolean;
  host: string;
  port: number;
  /** "tls": implicit TLS (usually 465); "starttls": upgrade required (587); "none": plain (local relays only). */
  security: "tls" | "starttls" | "none";
  username: string;
  password: string;
  from: string;
  /** Comma-separated recipients. */
  to: string;
}

/** Shown instead of stored secrets; sending it back keeps the stored value. */
export const REDACTED = "••••••••";

export interface AppSettings {
  backupDirectory: string | null;
  backupRetention: number;
  ddnsProvider: "none" | "duckdns";
  ddnsDomain: string;
  ddnsToken: string;
  publicIp: string | null;
  /** Ship the `/trigger craftpanel` info datapack to managed worlds. */
  infoCommand: boolean;
  /** Which client addresses may use the dashboard (only matters when it listens beyond loopback). */
  dashboardAccess: AccessPolicy;
  /** Extra IPs/CIDR ranges always allowed, e.g. an office's public address. */
  allowedNetworks: string[];
  /** Look up the newest CraftPanel release on GitHub and show a notice in the dashboard. */
  updateCheck: boolean;
  /** Roles that must sign in with a second factor (TOTP). */
  twoFactorRoles: Role[];
  /** Discord webhook for notifications ("" = off). */
  notifyDiscordWebhook: string;
  notifyEmail: EmailSettings;
  notifyEvents: NotificationCategory[];
  /** Last CraftPanel version an update notification was sent for. */
  notifyLastUpdate: string | null;
  /** Version that ran last time, to notice updates done by any method. */
  lastRunVersion: string | null;
  /** finishedAt of the last installer result already reported. */
  lastUpdateResultAt: number | null;
  /** The optional AI assistant (Settings → AI assistant); off until the owner adds a provider. */
  assistant: AssistantSettings;
}

const DEFAULTS: AppSettings = {
  backupDirectory: null,
  backupRetention: 10,
  ddnsProvider: "none",
  ddnsDomain: "",
  ddnsToken: "",
  publicIp: null,
  infoCommand: true,
  dashboardAccess: "private",
  allowedNetworks: [],
  updateCheck: true,
  twoFactorRoles: [],
  notifyDiscordWebhook: "",
  notifyEmail: { enabled: false, host: "", port: 587, security: "starttls", username: "", password: "", from: "", to: "" },
  notifyEvents: [...NOTIFICATION_CATEGORIES],
  notifyLastUpdate: null,
  lastRunVersion: null,
  lastUpdateResultAt: null,
  assistant: ASSISTANT_DEFAULTS,
};

export class SettingsService {
  private cache: AppSettings | null = null;
  constructor(private db: Database) {}

  async get(): Promise<AppSettings> {
    if (this.cache) return this.cache;
    const rows = await this.db.select().from(appSettings);
    const out = { ...DEFAULTS } as Record<string, unknown>;
    for (const r of rows) {
      if (r.key in DEFAULTS) {
        try {
          out[r.key] = JSON.parse(r.value);
        } catch {
          /* ignore corrupt value */
        }
      }
    }
    this.cache = out as unknown as AppSettings;
    return this.cache;
  }

  async set(patch: Partial<AppSettings>): Promise<AppSettings> {
    for (const [key, value] of Object.entries(patch)) {
      if (!(key in DEFAULTS) || value === undefined) continue;
      const json = JSON.stringify(value);
      const [existing] = await this.db.select().from(appSettings).where(eq(appSettings.key, key));
      if (existing) await this.db.update(appSettings).set({ value: json }).where(eq(appSettings.key, key));
      else await this.db.insert(appSettings).values({ key, value: json });
    }
    this.cache = null;
    return this.get();
  }

  /** Settings safe to send to the browser (secrets redacted). */
  async publicView() {
    const s = await this.get();
    return {
      ...s,
      ddnsToken: s.ddnsToken ? REDACTED : "",
      // The webhook URL is itself the credential.
      notifyDiscordWebhook: s.notifyDiscordWebhook ? REDACTED : "",
      notifyEmail: { ...s.notifyEmail, password: s.notifyEmail.password ? REDACTED : "" },
      assistant: { ...ASSISTANT_DEFAULTS, ...s.assistant, apiKey: s.assistant?.apiKey ? REDACTED : "" },
    };
  }
}
