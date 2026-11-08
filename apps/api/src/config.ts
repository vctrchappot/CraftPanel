import path from "node:path";
import { parseNetwork } from "@craftpanel/network";
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
  /** Only these immediate peers may supply forwarding headers. Never trust every peer. */
  trustProxy: false | string[];
  /** Browser-facing origin, independent of the internal listener. No path prefixes. */
  publicUrl: string | null;
  webDir: string | null;
  sessionTtlMs: number;
  logLevel: string;
  /** Allow anyone to complete first-run setup without the setup token (loopback-only installs). */
  isLoopbackOnly: boolean;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

function booleanEnv(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const value = env[name];
  if (value === undefined) return fallback;
  if (value !== "true" && value !== "false") throw new Error(`${name} must be true or false`);
  return value === "true";
}

export function parsePublicUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("CRAFTPANEL_PUBLIC_URL must be an absolute HTTP(S) URL"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
    throw new Error("CRAFTPANEL_PUBLIC_URL must be an HTTP(S) origin without credentials, a path, query or fragment");
  return url.origin;
}

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
  if (!Object.hasOwn(PROFILES, requested)) throw new Error(`Unknown profile "${requested}". Available: ${Object.keys(PROFILES).join(", ")}`);
  const profile = requested as ProfileName;
  const preset = PROFILES[profile];
  const host = env.CRAFTPANEL_HOST ?? preset.host;
  const certFile = env.CRAFTPANEL_TLS_CERT;
  const keyFile = env.CRAFTPANEL_TLS_KEY;
  if (!!certFile !== !!keyFile) throw new Error("Set both CRAFTPANEL_TLS_CERT and CRAFTPANEL_TLS_KEY to enable HTTPS");
  const tls = certFile && keyFile ? { certFile: path.resolve(certFile), keyFile: path.resolve(keyFile) } : null;
  const publicUrl = env.CRAFTPANEL_PUBLIC_URL ? parsePublicUrl(env.CRAFTPANEL_PUBLIC_URL) : null;
  const proxyEnabled = booleanEnv(env, "CRAFTPANEL_TRUST_PROXY", preset.trustProxy || env.CRAFTPANEL_TRUSTED_PROXIES !== undefined);
  let trustProxy: AppConfig["trustProxy"] = false;
  if (proxyEnabled) {
    trustProxy = (env.CRAFTPANEL_TRUSTED_PROXIES ?? "127.0.0.1,::1").split(",").map((s) => s.trim());
    if (!trustProxy.length || trustProxy.some((n) => !parseNetwork(n)))
      throw new Error("CRAFTPANEL_TRUSTED_PROXIES must contain specific proxy IPs or CIDRs (not a /0 range)");
    trustProxy = [...new Set(trustProxy.map((n) => parseNetwork(n)!))];
    if (trustProxy.some((n) => /\/0$/.test(n))) throw new Error("CRAFTPANEL_TRUSTED_PROXIES must not trust a /0 range");
  } else if (env.CRAFTPANEL_TRUSTED_PROXIES !== undefined) {
    throw new Error("CRAFTPANEL_TRUSTED_PROXIES conflicts with CRAFTPANEL_TRUST_PROXY=false");
  }
  const secureCookies = booleanEnv(env, "CRAFTPANEL_SECURE_COOKIES", preset.secureCookies || !!tls || publicUrl?.startsWith("https:") === true);
  if (!secureCookies && (tls || publicUrl?.startsWith("https:")))
    throw new Error("Secure cookies cannot be disabled when HTTPS is configured");
  if (publicUrl?.startsWith("http:") && secureCookies)
    throw new Error("CRAFTPANEL_PUBLIC_URL must use HTTPS when Secure cookies are enabled");
  if (publicUrl?.startsWith("https:") && !tls && !trustProxy)
    throw new Error("An HTTPS CRAFTPANEL_PUBLIC_URL requires built-in TLS or CRAFTPANEL_TRUSTED_PROXIES");
  const port = Number(env.CRAFTPANEL_PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("CRAFTPANEL_PORT must be a valid port");
  const sessionHours = Number(env.CRAFTPANEL_SESSION_TTL_HOURS ?? 24 * 7);
  if (!Number.isFinite(sessionHours) || sessionHours <= 0 || sessionHours > 8760) throw new Error("CRAFTPANEL_SESSION_TTL_HOURS must be greater than 0 and at most 8760");
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
    secureCookies,
    trustProxy,
    publicUrl,
    webDir: env.CRAFTPANEL_WEB_DIR ?? null,
    sessionTtlMs: sessionHours * 3600_000,
    logLevel: env.CRAFTPANEL_LOG_LEVEL ?? "info",
    // A loopback listener behind a proxy can still be exposed to the whole internet.
    isLoopbackOnly: LOOPBACK.has(host) && !trustProxy && !publicUrl,
  };
}
