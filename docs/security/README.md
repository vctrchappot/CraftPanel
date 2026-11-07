# Security

## Threat model

CraftPanel administers processes and files on the host. Whoever controls an Owner or Administrator account can run arbitrary code through plugins and can read or modify all server files. Protecting dashboard access is therefore critical.

## What CraftPanel does

**Authentication & sessions**
- Local accounts only. Passwords are hashed with scrypt (N=2¹⁵, r=8, p=1) and a per-user salt, and compared in constant time. Unknown users get a dummy hash comparison so timing doesn't reveal which accounts exist.
- Random 256-bit session tokens in an `HttpOnly`, `SameSite=Strict` cookie (`Secure` when `CRAFTPANEL_SECURE_COOKIES=true`). Only the SHA-256 of the token is stored. Sessions slide and expire, and are revoked on logout, password change, role change or account disablement. Open WebSockets for those sessions are closed.
- First-run setup on network-exposed installs requires a one-time token readable only on the host. The token file is deleted once the owner account exists.
- Network access policy (Settings → Remote access): by default only private networks and VPNs may reach the dashboard, even when it listens on all interfaces. Checked before anything else on every request and WebSocket upgrade; the host itself is always allowed, and changes that would lock out the requester are refused.
- Optional built-in HTTPS (`CRAFTPANEL_TLS_CERT`/`CRAFTPANEL_TLS_KEY`) turns on Secure cookies automatically.
- Login and setup are rate-limited (10/min per IP), and the whole API is limited to 600/min.
- Two-factor sign-in (TOTP, RFC 6238: SHA-1, 6 digits, 30 s, ±1 step). After the password the API returns only a short-lived challenge (5 minutes, in memory, 5 attempts); the session cookie is set after the code. Each time step is accepted once (replay protection). Ten single-use recovery codes are shown once and stored as SHA-256 hashes. Enabling it signs out the user's other devices. Owners can require it per role; users of such a role can only enroll until it is set up (API answers `two_factor_required`, WebSocket refused). An owner can reset a user's second factor.
- Signed-in devices (Settings → Account): users see their sessions (address, browser, last activity) and can end single ones or all others; owners can see and end a user's sessions. Sessions are identified by a 16-character prefix of the token hash, never the token.

**Request integrity**
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
- Server software, Java and plugins are downloaded only over HTTPS from an allowlist of official hosts (Mojang, PaperMC, Adoptium/GitHub releases, Modrinth) and verified against published SHA-1/SHA-256/SHA-512 checksums.
- No plugin or installer script is ever executed by CraftPanel. Plugins only run inside the Minecraft server, and the UI warns that they are executable code.

**Privacy**
- No telemetry and no third-party requests from the dashboard. Fonts are self-hosted and player avatars aren't fetched. External calls happen only for downloads, Modrinth searches, Mojang UUID lookups and, when you click it, the public-IP check.
- Audit log of logins, configuration changes, console commands, file operations, backups and user management.

## Known limitations (be aware)

- **No process isolation.** Minecraft servers and plugins run as the CraftPanel OS user, not in containers. Run CraftPanel under a dedicated unprivileged account (the Linux installer does). Never run it as root/Administrator.
- **Plain HTTP by default.** On a LAN, credentials travel unencrypted. Use HTTPS (reverse proxy) or a VPN for anything beyond a trusted home network.
- **Orphaned processes** (left over after CraftPanel was killed hard) can be stopped but not commanded. On Windows, stopping one terminates it without a world save.
- Rate limiting is per process and in memory.
- Secrets such as the DuckDNS token and TOTP secrets are stored in the SQLite database in plain text, protected by filesystem permissions. Anyone who can read the data directory can also generate codes.
- Pending two-factor sign-ins live in memory; a restart in the middle of one asks for the password again.

## Reporting vulnerabilities

Please report security issues privately to the maintainers rather than opening a public issue.
