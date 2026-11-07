# Deployment

CraftPanel needs **Node.js 22.13+** (24 LTS recommended) on the host. Java is downloaded automatically per Minecraft version. A production build is a single folder, `apps/api/dist`, that contains the server bundle, database migrations and the dashboard. You can build on one machine and copy that folder to another.

```bash
corepack enable            # Node 25+: npm install -g pnpm
pnpm install
pnpm build            # → apps/api/dist
node apps/api/dist/index.js
```

## Choosing where the dashboard listens

| Scenario | Setting |
| --- | --- |
| Same computer only (default) | `CRAFTPANEL_HOST=127.0.0.1` |
| Manage from other devices at home | `CRAFTPANEL_HOST=0.0.0.0` (or the machine's LAN IP) |
| Remote administration over the internet | Keep the dashboard private and reach it through a VPN (WireGuard/Tailscale), or put it behind an HTTPS reverse proxy with `CRAFTPANEL_SECURE_COOKIES=true` and `CRAFTPANEL_TRUST_PROXY=true` |

When bound to anything other than loopback, first-run setup requires the token printed at startup and stored in `<data dir>/setup-token.txt`.

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
