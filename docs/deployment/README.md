# Deployment

CraftPanel needs **Node.js 22.13+** (24 LTS recommended) on the host. Java is downloaded automatically per Minecraft version. A production build is a single folder, `apps/api/dist`, that contains the server bundle, database migrations and the dashboard. You can build on one machine and copy that folder to another.

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

## Linux (Debian/Ubuntu/Raspberry Pi OS, x64 and arm64)

```bash
# Node.js 24 (NodeSource) — or use your distribution / nvm
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs git
git clone <repository> craftpanel && cd craftpanel
sudo ./deploy/install-linux.sh
```

The installer creates a `craftpanel` system user, installs to `/opt/craftpanel`, stores data in `/var/lib/craftpanel`, and enables `deploy/craftpanel.service` (hardened systemd unit, listening on `0.0.0.0:8080`). Logs: `journalctl -u craftpanel -f`.

**Raspberry Pi notes.** Use a 64-bit OS (Temurin provides aarch64 builds). A Pi 4/5 with 4–8 GB RAM runs a small Paper server well; allocate 1.5–3 GB and keep view distance around 6–8. Prefer an SSD over an SD card for worlds and backups.

**Firewall.** `sudo ufw allow 25565/tcp` for each game port. Allow `8080/tcp` only from your LAN: `sudo ufw allow from 192.168.0.0/16 to any port 8080`.

## Windows

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

Installed with `deploy/install-linux.sh` (runs from `/opt/craftpanel`):

```bash
git pull && sudo ./deploy/install-linux.sh   # rebuilds, replaces /opt/craftpanel, restarts the service
```

Running from the repository (`pnpm start` or your own service):

```bash
git pull && pnpm install && pnpm build
# then restart CraftPanel
```

Database migrations run automatically on start. Running Minecraft servers are stopped gracefully during the restart. Enable "Start with CraftPanel" on servers that should come back automatically.

## Backups of CraftPanel itself

Back up the whole data directory while CraftPanel is stopped, or at least `craftpanel.db` plus the `servers/` and `backups/` folders.
