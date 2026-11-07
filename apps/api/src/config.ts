import path from "node:path";
import { dataLayout, defaultDataDir, type DataLayout } from "@craftpanel/server-runtime";

/**
 * Start profiles: presets for common setups. Individual CRAFTPANEL_* variables still win.
 *  - local     Dashboard on this computer only (default).
 *  - lan       Dashboard reachable from other devices on the home network.
 *  - proxy     Behind an HTTPS reverse proxy on the same machine (Caddy, nginx, Traefik).
 *  - headless  API and WebSocket only, no web dashboard (automation, scripts, future remote agents).
 */
export const PROFILES = {
  local: { host: "127.0.0.1", web: true, secureCookies: false, trustProxy: false, summary: "dashboard on this computer only" },
  lan: { host: "0.0.0.0", web: true, secureCookies: false, trustProxy: false, summary: "dashboard reachable on your local network" },
  proxy: { host: "127.0.0.1", web: true, secureCookies: true, trustProxy: true, summary: "behind an HTTPS reverse proxy on this machine" },
  headless: { host: "127.0.0.1", web: false, secureCookies: false, trustProxy: false, summary: "API only, no web dashboard" },
} as const;
export type ProfileName = keyof typeof PROFILES;

export interface AppConfig {
  profile: ProfileName;
  /** Serve the web dashboard (false in the headless profile). */
  serveWeb: boolean;
  logFormat: "pretty" | "json";
  /** Serve HTTPS directly with this certificate/key (PEM file paths). */
  tls: { certFile: string; keyFile: string } | null;
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

/** `--profile lan`, `--profile=lan` or CRAFTPANEL_PROFILE=lan. */
export function profileFromArgs(argv: string[], env = process.env): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--profile") return argv[i + 1];
    if (a.startsWith("--profile=")) return a.slice("--profile=".length);
  }
  return env.CRAFTPANEL_PROFILE;
}

export function loadConfig(env = process.env, argv: string[] = []): AppConfig {
  const requested = (profileFromArgs(argv, env) ?? "local").toLowerCase();
  if (!(requested in PROFILES)) throw new Error(`Unknown profile "${requested}". Available: ${Object.keys(PROFILES).join(", ")}`);
  const profile = requested as ProfileName;
  const preset = PROFILES[profile];
  const host = env.CRAFTPANEL_HOST ?? preset.host;
  const certFile = env.CRAFTPANEL_TLS_CERT;
  const keyFile = env.CRAFTPANEL_TLS_KEY;
  if (!!certFile !== !!keyFile) throw new Error("Set both CRAFTPANEL_TLS_CERT and CRAFTPANEL_TLS_KEY to enable HTTPS");
  const tls = certFile && keyFile ? { certFile: path.resolve(certFile), keyFile: path.resolve(keyFile) } : null;
  const port = Number(env.CRAFTPANEL_PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("CRAFTPANEL_PORT must be a valid port");
  const root = env.CRAFTPANEL_DATA_DIR ? path.resolve(env.CRAFTPANEL_DATA_DIR) : defaultDataDir();
  return {
    host,
    port,
    layout: dataLayout(root),
    corsOrigins: (env.CRAFTPANEL_CORS_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    profile,
    serveWeb: preset.web,
    logFormat: env.CRAFTPANEL_LOG_FORMAT === "json" ? "json" : "pretty",
    tls,
    // Cookies must be Secure whenever the browser talks HTTPS (directly or through a proxy).
    secureCookies: env.CRAFTPANEL_SECURE_COOKIES ? env.CRAFTPANEL_SECURE_COOKIES === "true" : preset.secureCookies || !!tls,
    trustProxy: env.CRAFTPANEL_TRUST_PROXY ? env.CRAFTPANEL_TRUST_PROXY === "true" : preset.trustProxy,
    webDir: env.CRAFTPANEL_WEB_DIR ?? null,
    sessionTtlMs: Number(env.CRAFTPANEL_SESSION_TTL_HOURS ?? 24 * 7) * 3600_000,
    logLevel: env.CRAFTPANEL_LOG_LEVEL ?? "info",
    isLoopbackOnly: LOOPBACK.has(host),
  };
}
