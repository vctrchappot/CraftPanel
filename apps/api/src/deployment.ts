import type { FastifyRequest } from "fastify";
import { ipMatches, isLoopback, listLocalAddresses, normalizeIp } from "@craftpanel/network";
import type { AppConfig } from "./config";

/** Raw socket peers on this host, including a listener bound to a specific LAN/VPN interface. */
export function isHostPeer(address: string): boolean {
  const ip = normalizeIp(address);
  return isLoopback(ip) || listLocalAddresses().some((a) => normalizeIp(a.address) === ip);
}

export function isTrustedProxy(config: AppConfig, address: string): boolean {
  return config.trustProxy !== false && config.trustProxy.some((network) => ipMatches(address, network));
}

/** Do not infer encryption from a profile, Secure cookies or the configured public URL. */
export function isSecureRequest(req: FastifyRequest, config: AppConfig): boolean {
  // Backend TLS says nothing about the browser-to-proxy connection.
  if (isTrustedProxy(config, req.socket.remoteAddress ?? "")) return req.headers["x-forwarded-proto"] === "https";
  return (req.raw.socket as { encrypted?: boolean }).encrypted === true;
}

/** Compare complete origins, including the scheme. The canonical origin handles rewritten Host headers. */
export function isRequestOriginAllowed(req: FastifyRequest, config: AppConfig): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // Non-browser API clients still require authentication and CSRF tokens.
  let parsed: URL;
  try { parsed = new URL(origin); } catch { return false; }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== origin) return false;
  if (config.corsOrigins.includes(origin)) return true;
  if (config.publicUrl) return origin === config.publicUrl;
  const scheme = isSecureRequest(req, config) ? "https" : "http";
  try { return origin === new URL(`${scheme}://${req.headers.host}`).origin; } catch { return false; }
}
