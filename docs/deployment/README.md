# Deployment

CraftPanel needs **Node.js 22.13+** (24 LTS recommended) on the host. Java is downloaded automatically per Minecraft version. A production build is a single folder, `apps/api/dist`, that contains the server bundle, database migrations and the dashboard. It has no native add-ons, so one build runs on every OS and CPU.

## One-line install (recommended)

Every release on GitHub publishes `craftpanel-vX.Y.Z.tar.gz` (the built app plus these docs), the two installers and `SHA256SUMS`. The installers download the release, verify its checksum, and set CraftPanel up to run in the background.

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
- CraftPanel runs only while you are signed in. For a dedicated machine, turn on automatic sign-in, or wrap `start.ps1` in a service manager.

**Updates in both installers:** CraftPanel is stopped gracefully first (every running Minecraft server saves its world and stops; on Windows through a local control channel secured by a token in the data directory), the new version replaces the old one, and the installer waits until it answers. If it doesn't start, the previous version is put back and started again. Servers with "Start with CraftPanel" come back up automatically.

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
| `proxy` | `127.0.0.1`, Secure cookies, trusts `X-Forwarded-For` | An HTTPS reverse proxy (Caddy, nginx, Cloudflare Tunnel) on the same machine publishes the dashboard |
| `headless` | API and WebSocket only, no web UI | Automation and scripts; base for future remote agents |

When the dashboard listens on anything other than loopback, first-run setup requires the token printed at startup (also in `<data dir>/setup-token.txt`, deleted once the owner exists).

## Remote access for teams

Where the dashboard *listens* is set by the profile; *who may connect* is set live in **Settings → Remote access**, without restarting (running Minecraft servers keep running):

- **This computer only** — everything else gets an "access not allowed" page.
- **Private networks and VPNs** (default) — LANs (10/8, 172.16/12, 192.168/16), Tailscale/CGNAT (100.64/10), link-local and private IPv6. Requests from public addresses are refused, so an accidental port forward doesn't expose the dashboard.
- **Anywhere** — only together with HTTPS.
- **Additional addresses** — IPs or CIDR ranges that are always allowed, e.g. an office's public IP.

The host itself is always allowed, and CraftPanel refuses a change that would lock out the person making it. The page also lists every address the dashboard is reachable at (LAN, VPN) with copy buttons.

Recommended setups for a team on different networks:

1. **VPN (simplest, most secure):** install Tailscale (or WireGuard) on the host and team devices, start with the `lan` profile, keep the default rule. Nothing is exposed to the internet.
2. **HTTPS reverse proxy:** Caddy/nginx with a real certificate in front, `proxy` profile, then allow "Anywhere" or the team's addresses. A Cloudflare Tunnel works without opening ports.
3. **Built-in HTTPS:** set `CRAFTPANEL_TLS_CERT` and `CRAFTPANEL_TLS_KEY` to PEM files (e.g. `tailscale cert <name>` or Let's Encrypt). Secure cookies switch on automatically.

Give every person their own account with the lowest role that fits.

## Linux from a git checkout (Debian/Ubuntu/Raspberry Pi OS, x64 and arm64)

```bash
# Node.js 24 (NodeSource) — or use your distribution / nvm
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs git
git clone <repository> craftpanel && cd craftpanel
sudo ./deploy/install-linux.sh
```

The installer builds the checkout, creates a `craftpanel` system user, installs to `/opt/craftpanel`, stores data in `/var/lib/craftpanel`, and enables `deploy/craftpanel.service` (hardened systemd unit, listening on `0.0.0.0:8080`). Logs: `journalctl -u craftpanel -f`.

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
- The **dashboard must not be public**. Either keep `CRAFTPANEL_HOST=127.0.0.1` and use an SSH tunnel (`ssh -L 8080:127.0.0.1:8080 user@vps`) or a VPN, or put it behind HTTPS with strong passwords.

## Reverse proxy (HTTPS) example: Caddy

```
panel.example.lan {
    reverse_proxy 127.0.0.1:8080
}
```

Then set `CRAFTPANEL_SECURE_COOKIES=true` and `CRAFTPANEL_TRUST_PROXY=true`. WebSockets are proxied automatically by Caddy; for nginx add the `Upgrade`/`Connection` headers for `/api/ws`.

## Updating CraftPanel

Installed with a one-line installer: run it again (see above). The dashboard shows a notice with the right command when a new release is out; it only reads the latest release from the GitHub API and can be turned off in Settings or with `CRAFTPANEL_UPDATE_CHECK=false`.

Git checkout, from the CraftPanel folder:

```bash
./update.sh       # Linux / macOS (update.cmd on Windows)
```

The script (`scripts/update.mjs`) fetches the newest version, stashes local edits and keeps your own commits on a `backup/before-update-…` branch, also copes with rewritten published history, installs dependencies and rebuilds. On a service install (`deploy/install-linux.sh`) it re-runs the installer, which replaces `/opt/craftpanel` and restarts the service; otherwise it tells you whether a running CraftPanel needs a restart.

Manual equivalent: `git pull && pnpm install && pnpm build`, then restart (service installs: `git pull && sudo ./deploy/install-linux.sh`).

Database migrations run automatically on start. Running Minecraft servers are stopped gracefully during the restart. Enable "Start with CraftPanel" on servers that should come back automatically.

## Backups of CraftPanel itself

Back up the whole data directory while CraftPanel is stopped, or at least `craftpanel.db` plus the `servers/` and `backups/` folders.
