import os from "node:os";
import net from "node:net";

export interface LocalAddress {
  interface: string;
  address: string;
  family: "IPv4" | "IPv6";
  private: boolean;
  internal: boolean;
}

/** Parse dotted IPv4 into a 32-bit unsigned integer, or null. */
export function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}

function inRange(ip: string, cidr: string): boolean {
  const [base, bitsStr] = cidr.split("/");
  const a = ipv4ToInt(ip);
  const b = ipv4ToInt(base);
  if (a === null || b === null) return false;
  const bits = Number(bitsStr);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (a & mask) === (b & mask);
}

export function isPrivateIPv4(ip: string): boolean {
  return ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"].some((c) => inRange(ip, c));
}
export function isCgnatIPv4(ip: string): boolean {
  return inRange(ip, "100.64.0.0/10");
}
export function isLoopback(ip: string): boolean {
  return inRange(ip, "127.0.0.0/8") || ip === "::1";
}
export function isLinkLocal(ip: string): boolean {
  return inRange(ip, "169.254.0.0/16") || ip.toLowerCase().startsWith("fe80:");
}

export function listLocalAddresses(): LocalAddress[] {
  const out: LocalAddress[] = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4" && a.family !== "IPv6") continue;
      out.push({
        interface: name,
        address: a.address,
        family: a.family,
        internal: a.internal,
        private: a.family === "IPv4" ? isPrivateIPv4(a.address) : a.address.toLowerCase().startsWith("fd"),
      });
    }
  }
  return out;
}

/** Private, non-loopback IPv4 addresses players on the LAN can use. */
export function lanAddresses(): LocalAddress[] {
  return listLocalAddresses().filter((a) => a.family === "IPv4" && !a.internal && !isLinkLocal(a.address) && (a.private || isCgnatIPv4(a.address)));
}

/** True when a TCP port can be bound on the given host. */
export function isPortAvailable(port: number, host = "0.0.0.0"): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once("error", () => resolve(false));
    srv.listen({ port, host, exclusive: true }, () => srv.close(() => resolve(true)));
  });
}

/** Try a TCP connection; used to confirm the game port is accepting connections locally. */
export function probeTcp(host: string, port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

/**
 * Fetch the public IPv4 address. This contacts an external service and is
 * therefore only called on explicit user request (privacy-first).
 */
export async function fetchPublicIp(fetchImpl: typeof fetch = fetch): Promise<string> {
  const res = await fetchImpl("https://api.ipify.org?format=json", { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`Public IP lookup failed (${res.status})`);
  const body = (await res.json()) as { ip?: string };
  if (!body.ip || ipv4ToInt(body.ip) === null) throw new Error("Public IP lookup returned an invalid address");
  return body.ip;
}

export interface WanDiagnosis {
  publicIp: string | null;
  lanAddresses: string[];
  portBoundLocally: boolean;
  natLikely: boolean;
  cgnatLikely: boolean;
  findings: { level: "ok" | "warn" | "error" | "info"; message: string }[];
}

/**
 * Diagnose WAN reachability without contacting third-party port scanners.
 * We can detect CGNAT when an interface has a 100.64/10 address or the
 * public IP is in that range; we cannot test inbound reachability ourselves.
 */
export async function diagnoseWan(opts: { port: number; running: boolean; publicIp: string | null }): Promise<WanDiagnosis> {
  const lan = lanAddresses();
  const findings: WanDiagnosis["findings"] = [];
  const portBound = opts.running ? await probeTcp("127.0.0.1", opts.port) : false;
  const cgnatInterface = lan.some((a) => isCgnatIPv4(a.address));
  const cgnatPublic = opts.publicIp ? isCgnatIPv4(opts.publicIp) : false;
  const natLikely = lan.some((a) => a.private);

  if (!opts.running) findings.push({ level: "info", message: "Start the server to test whether the game port is listening." });
  else if (portBound) findings.push({ level: "ok", message: `Minecraft is listening on port ${opts.port}.` });
  else findings.push({ level: "error", message: `Nothing is accepting connections on port ${opts.port} locally.` });

  if (natLikely) findings.push({ level: "info", message: "This machine is behind a router (private address). Forward TCP port " + opts.port + " on the router to " + (lan.find((a) => a.private)?.address ?? "this machine") + "." });
  if (cgnatInterface || cgnatPublic)
    findings.push({ level: "warn", message: "Carrier-grade NAT (100.64.0.0/10) detected. Port forwarding will likely not work; ask your ISP for a public IPv4 address or use a tunnel provider." });
  if (opts.publicIp && !cgnatPublic)
    findings.push({ level: "info", message: `Your public address is ${opts.publicIp}. Players outside your network connect to ${opts.publicIp}${opts.port === 25565 ? "" : ":" + opts.port}.` });
  if (!opts.publicIp) findings.push({ level: "info", message: "Public IP not checked. Run the check to look it up (contacts api.ipify.org)." });
  findings.push({ level: "info", message: "CraftPanel cannot verify inbound reachability from the internet without a third-party service. Ask a friend outside your network to connect, or use an external port checker." });

  return { publicIp: opts.publicIp, lanAddresses: lan.map((a) => a.address), portBoundLocally: portBound, natLikely, cgnatLikely: cgnatInterface || cgnatPublic, findings };
}

export function formatAddress(host: string, port: number): string {
  const h = host.includes(":") ? `[${host}]` : host;
  return port === 25565 ? h : `${h}:${port}`;
}

// ---- Dynamic DNS -------------------------------------------------------

export interface DdnsProvider {
  id: string;
  update(opts: { domain: string; token: string; ip?: string }): Promise<{ ok: boolean; message: string }>;
}

export const duckDns: DdnsProvider = {
  id: "duckdns",
  async update({ domain, token, ip }) {
    const sub = domain.replace(/\.duckdns\.org$/i, "");
    if (!/^[a-z0-9-]{1,63}$/i.test(sub)) return { ok: false, message: "Invalid DuckDNS subdomain" };
    const url = new URL("https://www.duckdns.org/update");
    url.searchParams.set("domains", sub);
    url.searchParams.set("token", token);
    url.searchParams.set("ip", ip ?? "");
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const text = (await res.text()).trim();
    return text.startsWith("OK") ? { ok: true, message: `Updated ${sub}.duckdns.org` } : { ok: false, message: `DuckDNS rejected the update (${text || res.status})` };
  },
};

export const DDNS_PROVIDERS: Record<string, DdnsProvider> = { duckdns: duckDns };

// ---- Tunnels (future) ----------------------------------------------------

/**
 * A tunnel exposes a local game port through a third-party relay (for users
 * behind CGNAT). No provider ships yet; implementations must never expose
 * the CraftPanel dashboard, only the Minecraft port.
 */
export interface TunnelProvider {
  id: string;
  label: string;
  start(opts: { localPort: number }): Promise<{ publicAddress: string }>;
  stop(): Promise<void>;
}
