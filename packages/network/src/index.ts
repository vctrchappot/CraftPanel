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

// ---- dashboard access control ------------------------------------------------

/** Who may open the dashboard: only this machine, private networks and VPNs, or anyone. */
export type AccessPolicy = "local" | "private" | "any";

/** Strip the IPv4-mapped IPv6 prefix (::ffff:192.168.1.5) and IPv6 zone ids. */
export function normalizeIp(ip: string): string {
  const s = ip.trim().toLowerCase().replace(/%.*$/, "");
  return s.startsWith("::ffff:") && s.includes(".") ? s.slice(7) : s;
}

function ipv6ToBigInt(ip: string): bigint | null {
  if (!/^[0-9a-f:]+$/.test(ip) || !ip.includes(":")) return null;
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const groups = [...head, ...Array(missing).fill("0"), ...tail];
  let n = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    n = (n << 16n) | BigInt(parseInt(g, 16));
  }
  return n;
}

/** Validate an IP address or CIDR range (IPv4 or IPv6). Returns the normalized form or null. */
export function parseNetwork(input: string): string | null {
  const [rawIp, bitsStr, ...rest] = input.trim().split("/");
  if (rest.length || !rawIp) return null;
  const ip = normalizeIp(rawIp);
  const v4 = ipv4ToInt(ip) !== null;
  const v6 = !v4 && ipv6ToBigInt(ip) !== null;
  if (!v4 && !v6) return null;
  if (bitsStr === undefined) return ip;
  if (!/^\d{1,3}$/.test(bitsStr) || Number(bitsStr) > (v4 ? 32 : 128)) return null;
  return `${ip}/${Number(bitsStr)}`;
}

/** True when `ip` equals or lies inside `network` (IP or CIDR, IPv4 or IPv6). */
export function ipMatches(ip: string, network: string): boolean {
  const addr = normalizeIp(ip);
  const [base, bitsStr] = network.split("/");
  if (!base) return false;
  if (ipv4ToInt(addr) !== null) return bitsStr === undefined ? addr === base : ipv4ToInt(base) !== null && inRange(addr, `${base}/${bitsStr}`);
  const a = ipv6ToBigInt(addr);
  const b = ipv6ToBigInt(base);
  if (a === null || b === null) return false;
  const bits = bitsStr === undefined ? 128 : Number(bitsStr);
  const shift = BigInt(128 - bits);
  return a >> shift === b >> shift;
}

/** Private address space: home/office LANs, VPN overlays such as Tailscale (100.64/10), link-local and IPv6 ULA. */
export function isPrivateAddress(ip: string): boolean {
  const a = normalizeIp(ip);
  if (ipv4ToInt(a) !== null) return isLoopback(a) || isPrivateIPv4(a) || isCgnatIPv4(a) || isLinkLocal(a);
  return a === "::1" || ipMatches(a, "fc00::/7") || ipMatches(a, "fe80::/10");
}

/** Whether a client address may use the dashboard. The host itself is always allowed, so nobody locks themselves out. */
export function isClientAllowed(ip: string, policy: AccessPolicy, extraNetworks: string[] = []): boolean {
  const a = normalizeIp(ip);
  if (isLoopback(a)) return true;
  if (extraNetworks.some((n) => ipMatches(a, n))) return true;
  if (policy === "any") return true;
  if (policy === "private") return isPrivateAddress(a);
  return false;
}

export interface DashboardUrl {
  url: string;
  /** local = this machine, lan = home/office network, vpn = Tailscale/WireGuard/ZeroTier, virtual = VM/container adapters. */
  kind: "local" | "lan" | "vpn" | "virtual";
  interface?: string;
}

const VPN_ADAPTER = /tailscale|wireguard|^wg\d|^zt|zerotier|^utun/i;
const VIRTUAL_ADAPTER = /vEthernet|Hyper-V|VirtualBox|VMware|docker|^br-|^veth|^virbr|^vboxnet|^lxc|^cni/i;

/** Every address the dashboard can be opened at, given the address it listens on. */
export function dashboardUrls(host: string, port: number, https = false): DashboardUrl[] {
  const scheme = https ? "https" : "http";
  const fmt = (h: string) => `${scheme}://${h.includes(":") ? `[${h}]` : h}:${port}`;
  const wildcard = host === "0.0.0.0" || host === "::";
  if (!wildcard) return [{ url: fmt(isLoopback(host) ? "localhost" : host), kind: isLoopback(host) ? "local" : isCgnatIPv4(host) ? "vpn" : "lan" }];
  const out: DashboardUrl[] = [{ url: fmt("localhost"), kind: "local" }];
  for (const a of listLocalAddresses()) {
    if (a.internal || a.family !== "IPv4" || isLinkLocal(a.address)) continue;
    const kind = VPN_ADAPTER.test(a.interface) || isCgnatIPv4(a.address) ? "vpn" : VIRTUAL_ADAPTER.test(a.interface) ? "virtual" : "lan";
    out.push({ url: fmt(a.address), kind, interface: a.interface });
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
