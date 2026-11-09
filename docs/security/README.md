# Security

## Threat model

CraftPanel administers processes and files on the host. Whoever controls an Owner or Administrator account can run arbitrary code through plugins and can read or modify all server files. Protecting dashboard access is therefore critical.

## What CraftPanel does

**Authentication & sessions**
- Local accounts only. Passwords are hashed with scrypt (N=2¹⁵, r=8, p=1) and a per-user salt, and compared in constant time. Unknown users get a dummy hash comparison so timing doesn't reveal which accounts exist.
- Random 256-bit session tokens in an `HttpOnly`, `SameSite=Strict` cookie (`Secure` when `CRAFTPANEL_SECURE_COOKIES=true`). Only the SHA-256 of the token is stored. Sessions slide and expire, and are revoked on logout, password change, role change or account disablement. Open WebSockets for those sessions are closed.
- First-run setup on network-exposed installs requires a one-time token readable only on the host, including a loopback backend behind a trusted proxy or a configured public URL. The token file is deleted once the owner account exists.
- Network access policy (Settings → Remote access): by default only private networks and VPNs may reach the dashboard, even when it listens on all interfaces. Checked before anything else on every request and WebSocket upgrade; the host itself is always allowed, and changes that would lock out the requester are refused.
- Optional built-in HTTPS (`CRAFTPANEL_TLS_CERT`/`CRAFTPANEL_TLS_KEY`) turns on Secure cookies automatically.
- Login and setup are rate-limited (10/min per IP), and the whole API is limited to 600/min.
- Two-factor sign-in (TOTP, RFC 6238: SHA-1, 6 digits, 30 s, ±1 step). After the password the API returns only a short-lived challenge (5 minutes, in memory, 5 attempts); the session cookie is set after the code. Each time step is accepted once (replay protection). Ten single-use recovery codes are shown once and stored as SHA-256 hashes. Enabling it signs out the user's other devices. Owners can require it per role; users of such a role can only enroll until it is set up (API answers `two_factor_required`, WebSocket refused). An owner can reset a user's second factor.
- Signed-in devices (Settings → Account): users see their sessions (address, browser, last activity) and can end single ones or all others; owners can see and end a user's sessions. Sessions are identified by a 16-character prefix of the token hash, never the token.

**Request integrity**
- Browser origins are compared using scheme, hostname and port. `CRAFTPANEL_PUBLIC_URL` defines the external origin even if a proxy rewrites the backend Host header.
- Forwarding headers are accepted only from configured proxy IPs/CIDRs. The proxy profile and legacy `TRUST_PROXY=true` trust loopback peers, never every connecting device. Trusted proxies must overwrite `X-Forwarded-For` and `X-Forwarded-Proto`; a missing/invalid client address is rejected.
- Public clients require HTTPS and Secure session cookies independently of stored network rules. Public access rules and additional public ranges cannot be enabled over HTTP. TLS between a proxy and the backend does not prove that the browser-to-proxy connection is encrypted.
- Every state-changing request needs a per-session CSRF token header, and cross-origin requests are rejected by `Origin`. WebSocket upgrades check `Origin` as well.
- All input is validated with Zod. Commands, properties values and ban reasons must be single lines, so newlines can't smuggle in extra console commands or properties keys.
- Security headers: `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, and `Cache-Control: no-store` on the API.

**Authorization**
- Role-based access control (Owner > Administrator > Operator > Viewer) is enforced server-side on every route and WebSocket action (`packages/shared/src/roles.ts`). The UI hides controls, but the API is the source of truth.
- Per-server roles: a user either works on all servers with their role (optionally with a higher role on single servers), or only on selected servers with a role per server. Routes under `/api/servers/:id` check the role on that server automatically; backups and schedules are checked against their server. Servers a user can't see answer 404, lists (servers, backups, schedules, activity) and WebSocket broadcasts are filtered, and limited users get no application-wide rights (creating servers, settings, users, audit log). Changing someone's access closes their open WebSockets so they reconnect with the new rights.
- Minecraft operator status is separate from dashboard roles. Granting `op` requires Administrator.

**Process execution**
- No shell is ever used. Java and its arguments are passed as an argv array. JVM arguments are restricted to `-` options without shell metacharacters, and `-jar`/`-cp`/memory flags are managed by CraftPanel.
- The browser can send only Minecraft console commands to a server's stdin. There is no host terminal.
- Force-kill requires an explicit, confirmed action by an Administrator.

**Filesystem**
- Each server is confined to its directory via `ServerSandbox`: lexical containment, rejection of absolute and UNC paths, drive letters and NUL bytes, real-path checks of the deepest existing ancestor, and symlinks are neither listed nor followed.
- Archive extraction rejects absolute paths, `..` segments and symlink entries, enforces entry-count and size limits, and verifies declared sizes while streaming.
- Writes are atomic (temp file + rename). Server directories are deleted only if they carry CraftPanel's marker file.

**Supply chain**
- Server software, Java and plugins are downloaded only over HTTPS from an allowlist of official hosts (Mojang, PaperMC, Fabric, NeoForge, Adoptium/GitHub releases, Modrinth) and verified against published SHA-1/SHA-256/SHA-512 checksums.
- Hangar plugins come from hangar.papermc.io / hangarcdn.papermc.io and are checked against Hangar's SHA-256; versions Hangar only links to elsewhere are not installed.
- Modpacks (`.mrpack`): every server-side file must come from a host the format allows (cdn.modrinth.com, github.com, raw.githubusercontent.com, gitlab.com), is checked against the pack's SHA-512 and may only land in folders such as `mods/` or `config/`; overrides are extracted with the same rules as world imports (no absolute paths, `..` or symlinks). Mods are code: only use packs you trust.
- CraftPanel never executes plugins, mods or installer scripts itself, with one exception: for NeoForge it runs the official NeoForge installer jar (from maven.neoforged.net, checked against the SHA-256 published there) with `--installServer` inside the server directory, as a Java child process without a shell. The installer downloads Minecraft and its libraries itself. Plugins and mods only run inside the Minecraft server, and the UI warns that they are executable code.
- Updates from the dashboard don't give CraftPanel more rights. On Linux the unprivileged service can only create a request file in its own data folder; a root systemd path unit then runs the installed `update.sh`, which removes the file without following it, ignores its content, installs only a release newer than the installed one and verifies its SHA-256 checksum. The installer's log and result live in a root-owned folder that the service can read but not write. On Windows the dashboard can only start the "CraftPanel Update" scheduled task, which runs as the same user. Only Administrators and Owners can start an update; it is recorded in the audit log.

**Velocity proxy**
- Modern forwarding with a random 192-bit secret per proxy, stored in the proxy's `forwarding.secret` and copied into each backend's config on start. It is never written to the activity log or console; the dashboard shows or regenerates it only for users with `server.configure` (served with `no-store`).
- Backends behind a proxy run with `online-mode=false` and rely on the forwarding secret, so they should not be reachable directly: the Proxy tab can bind them to 127.0.0.1 (on by default), and Paper refuses players who don't come through Velocity. Removing a backend from the proxy turns forwarding off, restores `online-mode=true` and resets the bind.
- Changing a proxy's server list rewires every backend involved (forwarding, `online-mode`, bind address), so it needs `server.configure` on the proxy and on each backend being added or removed; a moderator of the proxy alone can't take over other servers.

**Privacy**
- No telemetry and no third-party requests from the dashboard. Fonts are self-hosted. Player skins and item pictures are fetched by the API process, never by the browser: a skin from Mojang's session server (only for Mojang-issued, version 4 UUIDs; the texture URL must be `textures.minecraft.net`, the file a 64×64 or 64×32 PNG of at most 64 KB), item textures from the game client of the server's version, which is downloaded from Mojang (checksum-verified, then only the item and block PNGs are kept and the jar is deleted). Both are cached under the data directory and served from the dashboard's own origin to signed-in users. External calls happen only for downloads, Modrinth searches, Mojang UUID, skin and texture lookups and, when you click it, the public-IP check.
- Audit log of logins, configuration changes, console commands, file operations, backups and user management.

## Known limitations (be aware)

- **No process isolation.** Minecraft servers and plugins run as the CraftPanel OS user, not in containers. Run CraftPanel under a dedicated unprivileged account (the Linux installer does). Never run it as root/Administrator.
- **Plain HTTP by default.** On a LAN, credentials travel unencrypted. Use HTTPS (reverse proxy) or a VPN for anything beyond a trusted home network.
- **Orphaned processes** (left over after CraftPanel was killed hard) can be stopped but not commanded. On Windows, stopping one terminates it without a world save.
- Rate limiting is per process and in memory.
- Secrets such as the DuckDNS token and TOTP secrets are stored in the SQLite database in plain text, protected by filesystem permissions. Anyone who can read the data directory can also generate codes.
- Pending two-factor sign-ins live in memory; a restart in the middle of one asks for the password again.
- Notifications: the Discord webhook URL and SMTP password are stored like other secrets and never sent back to the browser. Only `discord.com` webhook URLs are accepted, and messages can't mention @everyone or roles. Messages contain server names and log excerpts; choose recipients accordingly.
- Update recovery restores the panel database and saved startup artifacts after a failed installation. It does not restore Minecraft worlds or server files and is not a full backup or a host-migration mechanism. Recovery snapshots contain credentials and other secrets and need the same protection as the data directory.
- A separate runtime service owns the Minecraft processes; restarting or updating the dashboard leaves them running. The dashboard controls it over a private Unix socket or a Windows named pipe, authenticated with a random token in the protected `runtime/` data directory. Anyone with access to the runtime's service account or that token can control all servers. On Windows the runtime's virtual service account gets modify access to the data directory and server directories, read/execute access to the program and Java files, and non-inherited list/traverse access to their parent folders. It can therefore see the names, but not the contents, of entries in folders such as `%LOCALAPPDATA%`. Minecraft servers still run under the same account as the runtime; per-server process isolation is planned.

## Reporting vulnerabilities

Please report security issues privately to the maintainers rather than opening a public issue.
