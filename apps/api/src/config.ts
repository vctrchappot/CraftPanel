import path from "node:path";
import { dataLayout, defaultDataDir, type DataLayout } from "@craftpanel/server-runtime";

export interface AppConfig {
  host: string;
  port: number;
  layout: DataLayout;
  /** Origins allowed to call the API cross-origin (development web server). */
  corsOrigins: string[];
  /** Mark cookies Secure. Enable when served over HTTPS (directly or via proxy). */
  secureCookies: boolean;
  trustProxy: boolean;
  webDir: string | null;
  sessionTtlMs: number;
  logLevel: string;
  /** Allow anyone to complete first-run setup without the setup token (loopback-only installs). */
  isLoopbackOnly: boolean;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

export function loadConfig(env = process.env): AppConfig {
  const host = env.CRAFTPANEL_HOST ?? "127.0.0.1";
  const port = Number(env.CRAFTPANEL_PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("CRAFTPANEL_PORT must be a valid port");
  const root = env.CRAFTPANEL_DATA_DIR ? path.resolve(env.CRAFTPANEL_DATA_DIR) : defaultDataDir();
  return {
    host,
    port,
    layout: dataLayout(root),
    corsOrigins: (env.CRAFTPANEL_CORS_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    secureCookies: env.CRAFTPANEL_SECURE_COOKIES === "true",
    trustProxy: env.CRAFTPANEL_TRUST_PROXY === "true",
    webDir: env.CRAFTPANEL_WEB_DIR ?? null,
    sessionTtlMs: Number(env.CRAFTPANEL_SESSION_TTL_HOURS ?? 24 * 7) * 3600_000,
    logLevel: env.CRAFTPANEL_LOG_LEVEL ?? "info",
    isLoopbackOnly: LOOPBACK.has(host),
  };
}
