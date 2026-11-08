/**
 * Small, comment-preserving editors for the files a Velocity network needs: the proxy's
 * velocity.toml, Paper's config/paper-global.yml and FabricProxy-Lite's TOML. Velocity rewrites
 * its own file (tabs, reordered keys), so these only touch the keys CraftPanel manages.
 */

const TABLE = /^\s*\[\[?\s*[A-Za-z0-9_."-]+\s*\]\]?\s*(#.*)?$/;

/** A TOML basic string. JSON's escapes are valid TOML for the characters CraftPanel writes. */
export const tomlString = (s: string) => JSON.stringify(s);

function lines(text: string): string[] {
  return text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
}

/** Index of the first table header, i.e. the end of the top-level key region. */
function topLevelEnd(ls: string[]): number {
  const i = ls.findIndex((l) => TABLE.test(l));
  return i === -1 ? ls.length : i;
}

const keyLine = (key: string) => new RegExp(`^\\s*"?${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"?\\s*=`);

/** Set a top-level key (before the first table); `literal` is already TOML (e.g. tomlString(...), true, 42). */
export function setTomlKey(text: string, key: string, literal: string): string {
  const ls = text ? lines(text) : [];
  const end = topLevelEnd(ls);
  const i = ls.slice(0, end).findIndex((l) => keyLine(key).test(l));
  if (i !== -1) ls[i] = `${ls[i].match(/^\s*/)![0]}${key} = ${literal}`;
  else {
    // After the last top-level key, so it stays above the tables.
    let at = end;
    while (at > 0 && ls[at - 1].trim() === "") at--;
    ls.splice(at, 0, `${key} = ${literal}`);
  }
  return ls.join("\n") + "\n";
}

/** Remove a single-line top-level key. */
export function removeTomlKey(text: string, key: string): string {
  const ls = lines(text);
  const end = topLevelEnd(ls);
  return ls.filter((l, i) => i >= end || !keyLine(key).test(l)).join("\n") + "\n";
}

/** Replace the body of `[name]` (or remove the table when `body` is null); appended when missing. */
export function setTomlTable(text: string, name: string, body: string[] | null): string {
  const ls = text ? lines(text) : [];
  const header = new RegExp(`^\\s*\\[\\s*"?${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"?\\s*\\]\\s*(#.*)?$`);
  const start = ls.findIndex((l) => header.test(l));
  if (start === -1) {
    if (body === null) return ls.join("\n") + "\n";
    while (ls.length && ls[ls.length - 1].trim() === "") ls.pop();
    return [...ls, ...(ls.length ? [""] : []), `[${name}]`, ...body].join("\n") + "\n";
  }
  let end = ls.findIndex((l, i) => i > start && TABLE.test(l));
  if (end === -1) end = ls.length;
  const replacement = body === null ? [] : [ls[start], ...body, ""];
  ls.splice(start, end - start, ...replacement);
  return ls.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n+$/, "") + "\n";
}

export interface VelocityServer {
  name: string;
  /** host:port the proxy connects to. */
  address: string;
  /** Forced host for this server. */
  host?: string;
}

/**
 * velocity.toml with CraftPanel's settings applied: listen address, Mojang authentication,
 * modern forwarding with forwarding.secret, the servers in try order and forced hosts.
 * Everything else (MOTD, compression, …) is kept; a missing file gets Velocity's defaults on first start.
 */
export function velocityToml(existing: string | null, opts: { bind: string; onlineMode: boolean; servers: VelocityServer[]; motd?: string }): string {
  let t = existing ?? "# Velocity reads the rest of its settings from its defaults and writes them here on first start.\n";
  t = setTomlKey(t, "bind", tomlString(opts.bind));
  t = setTomlKey(t, "online-mode", String(opts.onlineMode));
  t = setTomlKey(t, "player-info-forwarding-mode", tomlString("modern"));
  t = setTomlKey(t, "forwarding-secret-file", tomlString("forwarding.secret"));
  if (opts.motd !== undefined) t = setTomlKey(t, "motd", tomlString(opts.motd));
  const servers = opts.servers.map((s) => `${tomlString(s.name)} = ${tomlString(s.address)}`);
  t = setTomlTable(t, "servers", [...servers, `try = [${opts.servers.map((s) => tomlString(s.name)).join(", ")}]`]);
  // Velocity writes "forced-hosts = {}" at the top when there are none; a table and a key would clash.
  t = removeTomlKey(t, "forced-hosts");
  const forced = opts.servers.filter((s) => s.host);
  if (forced.length) t = setTomlTable(t, "forced-hosts", forced.map((s) => `${tomlString(s.host!)} = [${tomlString(s.name)}]`));
  else {
    t = setTomlTable(t, "forced-hosts", null);
    t = setTomlKey(t, "forced-hosts", "{}");
  }
  return t;
}

// ---- Paper: config/paper-global.yml -------------------------------------------------------

const indentOf = (l: string) => l.match(/^ */)![0].length;
const yamlString = (s: string) => `'${s.replace(/'/g, "''")}'`;

/**
 * Turn on Velocity modern forwarding in Paper's global config (Paper 1.19+), keeping every
 * other setting and comment. Creates the section, or the file, when missing; Paper adds its
 * remaining defaults on the next start.
 */
export function paperVelocityConfig(existing: string | null, opts: { secret: string; onlineMode: boolean; enabled?: boolean }): string {
  const values: [string, string][] = [
    ["enabled", String(opts.enabled ?? true)],
    ["online-mode", String(opts.onlineMode)],
    ["secret", yamlString(opts.secret)],
  ];
  const ls = existing ? lines(existing) : [];
  const blockEnd = (start: number, indent: number) => {
    let i = start + 1;
    while (i < ls.length && (ls[i].trim() === "" || ls[i].trim().startsWith("#") || indentOf(ls[i]) > indent)) i++;
    // Trailing blank/comment lines belong to whatever follows.
    while (i > start + 1 && (ls[i - 1].trim() === "" || ls[i - 1].trim().startsWith("#"))) i--;
    return i;
  };
  const proxies = ls.findIndex((l) => /^proxies:\s*(#.*)?$/.test(l));
  if (proxies === -1) {
    while (ls.length && ls[ls.length - 1].trim() === "") ls.pop();
    ls.push("proxies:", "  velocity:", ...values.map(([k, v]) => `    ${k}: ${v}`));
    return ls.join("\n") + "\n";
  }
  const proxiesEnd = blockEnd(proxies, 0);
  const velocity = ls.findIndex((l, i) => i > proxies && i < proxiesEnd && /^\s+velocity:\s*(#.*)?$/.test(l));
  if (velocity === -1) {
    const child = ls.slice(proxies + 1, proxiesEnd).find((l) => l.trim() && !l.trim().startsWith("#"));
    const pad = " ".repeat(child ? indentOf(child) : 2);
    ls.splice(proxiesEnd, 0, `${pad}velocity:`, ...values.map(([k, v]) => `${pad}  ${k}: ${v}`));
    return ls.join("\n") + "\n";
  }
  const vIndent = indentOf(ls[velocity]);
  const vEnd = blockEnd(velocity, vIndent);
  const firstChild = ls.slice(velocity + 1, vEnd).find((l) => l.trim() && !l.trim().startsWith("#"));
  const pad = " ".repeat(firstChild ? indentOf(firstChild) : vIndent + 2);
  const missing: string[] = [];
  for (const [k, v] of values) {
    const i = ls.findIndex((l, j) => j > velocity && j < vEnd && new RegExp(`^\\s+${k}:`).test(l));
    if (i !== -1) ls[i] = `${pad}${k}: ${v}`;
    else missing.push(`${pad}${k}: ${v}`);
  }
  ls.splice(vEnd, 0, ...missing);
  return ls.join("\n") + "\n";
}

/** Read the Velocity settings back from paper-global.yml (for status display). */
export function readPaperVelocity(text: string | null): { enabled: boolean; secret: string | null } {
  if (!text) return { enabled: false, secret: null };
  const ls = lines(text);
  const proxies = ls.findIndex((l) => /^proxies:\s*(#.*)?$/.test(l));
  if (proxies === -1) return { enabled: false, secret: null };
  const velocity = ls.findIndex((l, i) => i > proxies && /^\s+velocity:\s*(#.*)?$/.test(l));
  if (velocity === -1) return { enabled: false, secret: null };
  const vIndent = indentOf(ls[velocity]);
  let enabled = false;
  let secret: string | null = null;
  for (let i = velocity + 1; i < ls.length && (ls[i].trim() === "" || indentOf(ls[i]) > vIndent); i++) {
    const m = /^\s+([a-z-]+):\s*(.*?)\s*$/.exec(ls[i]);
    if (!m) continue;
    if (m[1] === "enabled") enabled = m[2] === "true";
    if (m[1] === "secret") secret = m[2].replace(/^'(.*)'$/, (_, v: string) => v.replace(/''/g, "'")).replace(/^"(.*)"$/, "$1");
  }
  return { enabled, secret };
}

// ---- Fabric: FabricProxy-Lite --------------------------------------------------------------

/** config/FabricProxy-Lite.toml for modern forwarding; other keys a user changed are kept. */
export function fabricProxyLiteConfig(existing: string | null, opts: { secret: string; onlineMode: boolean }): string {
  let t = existing ?? "";
  t = setTomlKey(t, "hackOnlineMode", String(opts.onlineMode));
  if (!existing) {
    t = setTomlKey(t, "hackEarlySend", "false");
    t = setTomlKey(t, "hackMessageChain", "true");
    t = setTomlKey(t, "disconnectMessage", tomlString("This server can only be joined through its Velocity proxy."));
  }
  return setTomlKey(t, "secret", tomlString(opts.secret));
}
