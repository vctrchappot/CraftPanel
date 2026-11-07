import { appSettings, eq, type Database } from "@craftpanel/database";
import type { AccessPolicy } from "@craftpanel/network";

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
    return { ...s, ddnsToken: s.ddnsToken ? "••••••••" : "" };
  }
}
