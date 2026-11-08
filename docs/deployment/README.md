# Deployment

CraftPanel needs **Node.js 22.13+** (24 LTS recommended) on the host. Java is downloaded automatically per Minecraft version. A production build is a single folder, `apps/api/dist`, that contains the server bundle, database migrations and the dashboard. It has no native add-ons, so one build runs on every OS and CPU.

**Installing on a fresh Ubuntu machine? Follow the [Ubuntu quickstart](ubuntu.md).** It installs a permanent background service from the repository and explains how to open the dashboard on another device. This route also works before the first GitHub release is published.

## One-line install (recommended)

Every release on GitHub publishes `craftpanel-vX.Y.Z.tar.gz` (the built app plus these docs), the two installers and `SHA256SUMS`. The installers download the release, verify its checksum, and set CraftPanel up to run in the background.

The download commands below require a published release. If GitHub has no release yet, use the Ubuntu quickstart above or a git checkout instead.

**Linux** (Debian, Ubuntu, Raspberry Pi OS, other systemd distributions; x64, ARM64, ARMv7):

```bash
curl -fsSL https://github.com/vctrchappot/CraftPanel/releases/latest/download/install.sh | sudo bash
```

- App in `/opt/craftpanel`, data in `/var/lib/craftpanel`, service `craftpanel` running as the unprivileged `craftpanel` user (hardened unit, see below).
- Uses the system Node.js if it is 22.13 or newer and installed system-wide; otherwise downloads the current Node.js LTS from nodejs.org (checksum-verified) into `/opt/craftpanel/node`. Your system Node.js is not changed.
- Settings: `/etc/craftpanel/craftpanel.env` (port, profile, HTTPS, …). It is created once and kept on updates; apply changes with `sudo systemctl restart craftpanel`. If you move the data directory, also add it to `ReadWritePaths` with `sudo systemctl edit craftpanel`.
- Update: run the command again or `sudo /opt/craftpanel/update.sh`. Options: `--version 0.2.0` (a specific release, also to go back), `--archive file.tar.gz` (offline; verified if `SHA256SUMS` is next to it), `--port 8090`, `--uninstall` (keeps data and settings). Pass them as `curl … | sudo bash -s -- --port 8090`.

**Windows 10/11** (x64, ARM64):

```powershell
irm https://github.com/vctrchappot/CraftPanel/releases/latest/download/install.ps1 | iex
```

- App in `%LOCALAPPDATA%\Programs\CraftPanel`, data in `%LOCALAPPDATA%\CraftPanel`, no administrator rights needed. A scheduled task named `CraftPanel` starts it hidden when you sign in; a Start-menu entry opens the dashboard. Logs: `%LOCALAPPDATA%\CraftPanel\logs\craftpanel.log`.
- Uses an installed Node.js 22.13+ or downloads one into the install folder.
- Settings: `config.env` in the install folder. Options are environment variables set before running the command: `$env:CRAFTPANEL_PORT = "8090"`, `CRAFTPANEL_PROFILE` (`lan` or `local`), `CRAFTPANEL_INSTALL_VERSION`, `CRAFTPANEL_ARCHIVE`, `CRAFTPANEL_UNINSTALL = "1"` (keeps data).
- Update: run the command again, or `update.ps1` in the install folder (the dashboard shows the exact command).
- CraftPanel runs only while you are signed in. For a dedicated machine, prefer the Linux systemd installation or run `start.ps1` through a Windows service manager configured with a dedicated account.

**Updates in both installers:** installers reject concurrent runs and unsupported recovery protocols before stopping the existing installation. CraftPanel then stops gracefully (running Minecraft servers save and stop), a consistent database recovery point is created, and the new application must pass its readiness check. Post-swap failures trigger restoration of the previous database, application and saved startup artifacts before the old version is restarted. If recovery fails, CraftPanel stays stopped. Servers with "Start with CraftPanel" come back automatically. See [update recovery](#update-recovery).

## Build it yourself

```bash
corepack enable            # Node 25+: npm install -g pnpm
pnpm install
pnpm build            # → apps/api/dist
node apps/api/dist/index.js
```

## Start profiles

Pick how CraftPanel starts with a profile: `pnpm start:<profile>`, `node apps/api/dist/index.js --profile <profile>` or `CRAFTPANEL_PROFILE=<profile>`. Individual `CRAFTPANEL_*` variables still override parts of it (see `.env.example`).

| Profile | Dashboard | Use it when |
| --- | --- | --- |
| `local` (default) | This computer only (`127.0.0.1`) | You manage servers on the machine you're sitting at, or through an SSH tunnel |
| `lan` | All interfaces (`0.0.0.0`) | You manage a Pi, home server or second PC from other devices at home, or over a VPN |
| `proxy` | `127.0.0.1`, Secure cookies, trusts loopback proxy peers | An HTTPS reverse proxy (Caddy, nginx, Cloudflare Tunnel) publishes the dashboard; configure explicit peers for a separate proxy host |
| `headless` | API and WebSocket only, no web UI | Automation and scripts; base for future remote agents |

First-run setup requires the token printed at startup when the dashboard binds beyond loopback, trusts a proxy, or has a configured public URL. A loopback backend behind a reverse proxy is not a local-only installation. The token is also saved in `<data dir>/setup-token.txt` and deleted once the owner exists.

## Remote access for teams

Where the dashboard *listens* is set by the profile; *who may connect* is set live in **Settings → Remote access**, without restarting (running Minecraft servers keep running):

- **This computer only** — everything else gets an "access not allowed" page.
- **Private networks and VPNs** (default) — LANs (10/8, 172.16/12, 192.168/16), Tailscale/CGNAT (100.64/10), link-local and private IPv6. Requests from public addresses are refused, so an accidental port forward doesn't expose the dashboard.
- **Anywhere** — requires an HTTPS connection and Secure cookies.
- **Additional addresses** — IPs or CIDR ranges allowed in addition to the selected network policy, e.g. an office's public IP. Public ranges still require HTTPS and Secure cookies.

Local maintenance probes remain available, and CraftPanel refuses a network-policy change that would lock out the person making it. The page shows the configured public address separately from internal listener addresses and reports whether the current browser connection uses HTTPS. Proxy mode or Secure cookies alone do not prove that connection is encrypted.

Recommended setups for a team on different networks:

1. **VPN (simplest, most secure):** install Tailscale (or WireGuard) on the host and team devices, start with the `lan` profile, keep the default rule. Nothing is exposed to the internet.
2. **HTTPS reverse proxy:** Caddy/nginx with a real certificate, the `proxy` profile and an explicit `CRAFTPANEL_PUBLIC_URL`. Open the HTTPS address before allowing "Anywhere" or the team's public addresses. A Cloudflare Tunnel works without opening ports when its connector is configured to supply the required forwarding headers.
3. **Built-in HTTPS:** set `CRAFTPANEL_TLS_CERT` and `CRAFTPANEL_TLS_KEY` to PEM files (e.g. `tailscale cert <name>` or Let's Encrypt). Secure cookies switch on automatically.

Give every person their own account with the lowest role that fits.

## Linux from a git checkout (Debian/Ubuntu/Raspberry Pi OS, x64 and arm64)

```bash
# Node.js 24 (NodeSource) — or use a system-wide distribution package
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs git
git clone https://github.com/vctrchappot/CraftPanel.git craftpanel
cd craftpanel
sudo ./deploy/install-linux.sh
```

The installer builds and packages the checkout, then uses the release installer's transaction and recovery path. It creates a `craftpanel` system user, installs to `/opt/craftpanel`, stores data in `/var/lib/craftpanel`, and enables `deploy/craftpanel.service` (hardened systemd unit, initially listening on `0.0.0.0:8080`). Existing `/etc/craftpanel/craftpanel.env` settings are preserved. Logs: `journalctl -u craftpanel -f`.

**Raspberry Pi notes.** Use a 64-bit OS (Temurin provides aarch64 builds). A Pi 4/5 with 4–8 GB RAM runs a small Paper server well; allocate 1.5–3 GB and keep view distance around 6–8. Prefer an SSD over an SD card for worlds and backups.

**Firewall.** `sudo ufw allow 25565/tcp` for each game port. Allow `8080/tcp` only from your LAN: `sudo ufw allow from 192.168.0.0/16 to any port 8080`.

## Windows from a git checkout

1. Install Node.js 24 LTS from nodejs.org, and Git.
2. In PowerShell: `corepack enable` (on Node 25+ use `npm install -g pnpm` instead), then `pnpm install; pnpm build`.
3. Run `node apps\api\dist\index.js`. Windows Defender Firewall asks to allow Java the first time a server starts. Allow **private networks** only.
4. To run at logon, create a Task Scheduler task ("At log on", action `node.exe` with argument `C:\path\to\craftpanel\apps\api\dist\index.js`, "Start in" the repository folder). For a background service, wrap it with a service manager such as NSSM or WinSW. Make sure it stops with Ctrl+C/SIGINT semantics so servers shut down gracefully.

Data lives in `%LOCALAPPDATA%\CraftPanel` by default.

## macOS

```bash
brew install node git
npm install -g pnpm && pnpm install && pnpm build
node apps/api/dist/index.js
```

Data lives in `~/Library/Application Support/CraftPanel`. To start at login, create a LaunchAgent plist that runs `node /path/to/apps/api/dist/index.js`.

## VPS

Same as Linux. Two important differences:

- The **game port** is public by design. Open it in the provider's firewall.
- Keep dashboard administration on a **VPN or SSH tunnel**, or deliberately publish it through an **HTTPS reverse proxy** with strong passwords and appropriate access rules. For an SSH tunnel, keep the local profile and use `ssh -L 8080:127.0.0.1:8080 user@vps`.

## Reverse proxies and HTTPS

`CRAFTPANEL_HOST` controls the internal listener. `CRAFTPANEL_PUBLIC_URL` is the browser-facing origin, including scheme and port. Path prefixes, credentials, queries and fragments are not supported. Browser origins for HTTP changes and WebSocket upgrades must match that origin, even if a proxy rewrites the backend Host header.

### Caddy on the CraftPanel host

CraftPanel service configuration:

```dotenv
CRAFTPANEL_PROFILE=proxy
CRAFTPANEL_PUBLIC_URL=https://panel.example.com
```

Caddyfile:

```caddy
panel.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

Caddy forwards WebSockets automatically. Restart CraftPanel after changing its environment, open `https://panel.example.com`, and configure network access under **Settings → Remote access**. The proxy profile trusts `127.0.0.1` and `::1`; it does not trust every peer.

### nginx on a separate host

Example: CraftPanel uses private/VPN address `10.20.0.3`, nginx uses `10.20.0.2`, and users open `https://panel.example.com`.

CraftPanel service configuration:

```dotenv
CRAFTPANEL_PROFILE=proxy
CRAFTPANEL_HOST=10.20.0.3
CRAFTPANEL_PUBLIC_URL=https://panel.example.com
CRAFTPANEL_TRUSTED_PROXIES=10.20.0.2
```

In nginx's `http` block:

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    '' close;
}
```

Inside the TLS-enabled `server` block for `panel.example.com`:

```nginx
location / {
    proxy_pass http://10.20.0.3:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_read_timeout 3600s;
}
```

Configure nginx's certificate and HTTP-to-HTTPS redirect separately. Restrict `10.20.0.3:8080` to the nginx host in the host firewall. Use an encrypted VPN between hosts or configure and verify upstream TLS: the HTTP upstream above does not encrypt that connection.

**Required forwarding headers:** trusted proxies must overwrite `X-Forwarded-For` with the client address and `X-Forwarded-Proto` with the browser-facing protocol. Missing or invalid client metadata is rejected. For multiple proxy hops, define the trusted chain explicitly. TLS between the proxy and CraftPanel does not prove that the browser-to-proxy hop uses HTTPS. Trust only actual proxy peers, not an entire LAN merely because it is private.

`CRAFTPANEL_TRUST_PROXY=true` is a compatibility switch that trusts loopback peers only. Prefer `CRAFTPANEL_TRUSTED_PROXIES` for an explicit configuration; unrestricted `/0` trust ranges are rejected.

## Deployment diagnostics

**Settings → Remote access → Deployment checks** reports the current connection transport, trusted proxy peers, data-directory access, free disk space, TLS certificate validity and SQLite integrity.

The same checks can run without starting CraftPanel:

```bash
node apps/api/dist/index.js doctor
node --env-file=.env apps/api/dist/index.js doctor --json
```

Use the same environment and OS account as the service. A shell does not inherit systemd's `EnvironmentFile`; supply the service settings explicitly when running doctor manually. Exit code `1` means a check failed; warnings alone return `0`. The command does not run migrations, initialize missing data directories, download software or restart servers. CLI checks cannot verify the browser-to-proxy connection; check the external HTTPS address in the dashboard.

`GET /api/health` checks that the HTTP process answers. `GET /api/ready` returns `200` after startup recovery completes and the database is accessible, or `503` while starting, shutting down or unable to query the database. Local maintenance probes work even when the external dashboard requires HTTPS.

## Updating CraftPanel

Installed with a one-line installer: click **Update now** in the dashboard (sidebar notice or Settings → Security & about), or run the installer again (see above). The dashboard shows the release notes and which running servers will restart, follows the installer through the restart and reloads into the new version; a failed update is rolled back and reported in the dashboard, the activity log and notifications.

How the button works without giving CraftPanel more rights:

- **Linux:** CraftPanel can only create `/var/lib/craftpanel/update/requested`. The root unit `craftpanel-update.path` sees it and starts `craftpanel-update.service`, which runs `/opt/craftpanel/update.sh --from-dashboard`. That mode ignores the file's content, installs only a release newer than the installed one, verifies its checksum as usual and writes its output to `/var/log/craftpanel/update.log` and the outcome to `update-result.json` next to it.
- **Windows:** the installer registers a second scheduled task, "CraftPanel Update", without a trigger. The dashboard starts it; it runs `update.ps1 --from-dashboard` outside CraftPanel's own task and logs to `logs\update.log` in the data folder.

The update check only reads the latest release from the GitHub API and can be turned off in Settings or with `CRAFTPANEL_UPDATE_CHECK=false`.

**Without access to GitHub** (offline networks, your own mirror): put `craftpanel-vX.Y.Z.tar.gz` and its `SHA256SUMS` into a folder and set `CRAFTPANEL_RELEASE_DIR=/that/folder` in `/etc/craftpanel/craftpanel.env` (Windows: `config.env` in the install folder). The dashboard then offers the newest archive in that folder, with its own changelog as release notes, and both installers install from it.

Git checkout, from the CraftPanel folder:

```bash
./update.sh       # Linux / macOS (update.cmd on Windows)
```

The script (`scripts/update.mjs`) fetches the newest version, stashes local edits and keeps your own commits on a `backup/before-update-…` branch, also copes with rewritten published history, installs dependencies and rebuilds. On a service install (`deploy/install-linux.sh`) it re-runs the installer, which replaces `/opt/craftpanel` and restarts the service; otherwise it tells you whether a running CraftPanel needs a restart.

Manual equivalent: `git pull && pnpm install && pnpm build`, then restart (service installs: `git pull && sudo ./deploy/install-linux.sh`).

Database migrations run automatically on start. Running Minecraft servers are stopped gracefully during the restart. Enable "Start with CraftPanel" on servers that should come back automatically.

### Update recovery

The target package must provide `apps/api/dist/recovery.js` with recovery protocol `craftpanel-recovery-v1`. Installers check this before stopping the existing application. The helper is separate from the API entry point and cannot accidentally start the dashboard while preparing recovery.

Run the current release installer once to upgrade an older installed updater. An updater installed before this mechanism does not provide the new snapshot and recovery guarantees for its first update. Unsupported target packages are refused by the new installers; use a compatible recovery package or a deliberate manual recovery procedure when returning to an older release.

Recovery points are `state-*` directories under the installation directory. They include a consistent SQLite snapshot, including committed WAL data, plus startup artifacts needed by the installer. They contain account information and other secrets; protect them like the data directory. Installers keep the latest two successful recovery points. Failed-update recovery points are retained until manually removed after investigation.

The standalone database helper also supports manual recovery. Stop CraftPanel first, create the destination's parent directory, use a new snapshot directory outside the existing data directory, and run with an account that can read the source and write the destination:

```bash
node apps/api/dist/recovery.js --protocol
node apps/api/dist/recovery.js snapshot /var/lib/craftpanel /secure/path/recovery-point
node apps/api/dist/recovery.js restore /var/lib/craftpanel /secure/path/recovery-point
```

Use the installed Node.js executable if CraftPanel has a private Node.js installation. Service data and root-owned recovery points normally require administrator access on Linux. The helper refuses state changes while the recorded application process is alive and validates the recovery point before restoration.

Database recovery points belong to the original absolute data-directory path. They restore the panel database and schema, not Minecraft worlds, plugins or server files. The manual helper does not restore installer startup artifacts. Update recovery is not a full backup or host-migration format, and it does not make arbitrary downgrades after a successful update safe.

## Backups of CraftPanel itself

Back up the whole data directory while CraftPanel is stopped, or at least `craftpanel.db` plus the `servers/` and `backups/` folders.

Also preserve service configuration, certificates and keys separately. A copy of only the main database file while CraftPanel is running can omit committed data in SQLite's WAL; use the recovery helper for a consistent database snapshot or stop CraftPanel before copying the complete data directory. Test restoration to a separate location before relying on a backup. Complete application backup/restore and a host-migration assistant are planned.
