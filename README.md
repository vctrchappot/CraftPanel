# CraftPanel

[![CI](https://github.com/vctrchappot/CraftPanel/actions/workflows/ci.yml/badge.svg)](https://github.com/vctrchappot/CraftPanel/actions/workflows/ci.yml)

**Self-hosted Minecraft server management.** Install CraftPanel on your PC, a spare computer, a Raspberry Pi or a VPS, open the dashboard in a browser, and create, run and manage real Minecraft Java servers. No accounts, no subscriptions, no cloud.

- Creates **Paper**, **Purpur**, **Fabric** and **Vanilla** servers for any published version, downloaded from the official sources and checksum-verified. Minecraft 1.7–1.18 is protected against Log4Shell automatically.
- Provisions the **right Java version automatically** (Eclipse Temurin 8/17/21/25 from Adoptium) for Windows, Linux and macOS on x64 and ARM64.
- **Live console** over WebSockets, real CPU/RAM/TPS/MSPT metrics, player tracking.
- Validated **server.properties editor**, version-aware **game rules**, whitelist/ops/bans.
- **Plugins** (Paper, Purpur) and **Fabric mods** from Modrinth with compatibility checks, uploads, updates and a Vanilla→Paper migration.
- **Worlds, file manager, backups** (consistent live backups, verification, restore with automatic safety backup) and **scheduled tasks**.
- **LAN/WAN guidance** with diagnostics (CGNAT detection), optional DuckDNS.
- **Notifications** via Discord or e-mail when a server crashes, a backup fails or an update is available.
- **Multi-user** with Owner / Administrator / Operator / Viewer roles, per-server access (e.g. a moderator for one server), two-factor sign-in, a list of signed-in devices and an audit log.

> Minecraft is a trademark of Mojang AB. CraftPanel is not affiliated with Mojang or Microsoft and never redistributes server software. It downloads it from official sources on your behalf after you accept the [Minecraft EULA](https://aka.ms/MinecraftEULA).

## Install

**Ubuntu home server or second PC? Start with the [Ubuntu quickstart](docs/deployment/ubuntu.md).** It covers installation, automatic startup, opening the dashboard from another device, the setup token and firewall checks.

**Release installers require a published GitHub release.** Until the first release is published, use the Ubuntu quickstart or [run from source](#run-from-source). The commands below become available after a release is published.

The release installer keeps CraftPanel running in the background. Nothing is built on your machine, and Node.js is set up automatically if needed. Java is installed per Minecraft version.

**Linux, Raspberry Pi, VPS** (systemd; x64, ARM64, ARMv7):

```bash
curl -fsSL https://github.com/vctrchappot/CraftPanel/releases/latest/download/install.sh | sudo bash
```

**Windows 10/11** (PowerShell as administrator for the first install, using your normal Windows account):

```powershell
irm https://github.com/vctrchappot/CraftPanel/releases/latest/download/install.ps1 | iex
```

The installer prints the dashboard address and a one-time **setup token** for creating the owner account. Minecraft runs in an independent background service; on Windows the dashboard starts when you sign in. Dashboard-only updates preserve running games. Updates that change the runtime require explicit maintenance approval and save/stop affected servers. Failed updates restore the previous application and database. Options and recovery limits: [docs/deployment](docs/deployment/README.md#one-line-install-recommended).

Every release also has a plain `craftpanel-vX.Y.Z.tar.gz` for Node.js 22.13+: unpack it, start `node apps/api/dist/runtime.js` in one terminal, then `node apps/api/dist/index.js --profile lan` in another. Both processes must use the same data directory.

## Run from source

Requirements: **Node.js 22.13 or newer** (24 LTS recommended), **pnpm** (`corepack enable`, or `npm install -g pnpm` on Node 25+ where corepack is no longer bundled), Git, and an internet connection for downloads. Java is installed automatically.

```bash
git clone https://github.com/vctrchappot/CraftPanel.git craftpanel
cd craftpanel
corepack enable            # Node 25+: npm install -g pnpm
pnpm install
pnpm build
pnpm start:runtime
```

Keep the runtime running. In another terminal in the same folder, run `pnpm start` for the dashboard. Both use the same platform data directory by default; set `CRAFTPANEL_DATA_DIR` identically for both when overriding it. `pnpm dev` starts runtime, API and dashboard together for development.

Open **http://127.0.0.1:8080**, create the owner account, and follow the wizard to create your first server.

### Running on another machine (second PC, Raspberry Pi, VPS)

By default the dashboard only listens on this computer. To manage CraftPanel from other devices, start it with the `lan` profile:

```bash
pnpm start:lan
```

Which networks may connect (home network, VPN such as Tailscale, specific addresses) is set in **Settings → Remote access**.

When the dashboard is reachable from the network, the first account can only be created with a **one-time setup token**. It is printed in the console on startup and saved as `setup-token.txt` in the data directory. Nobody else on your network can claim the owner account first.

For a permanent install from a git checkout on Linux, `sudo ./deploy/install-linux.sh` builds it and sets up the same systemd service as the one-line installer.

See [docs/deployment](docs/deployment/README.md) for Windows, macOS, Raspberry Pi, VPS and reverse-proxy/HTTPS setups.

> **Do not port-forward the dashboard.** Only the Minecraft game port should be reachable from the internet. Use a VPN (WireGuard, Tailscale) or an HTTPS reverse proxy with care for remote administration.

## Updating

Installed with the one-line installer? Run the install command again (Linux also: `sudo /opt/craftpanel/update.sh`).

Running a git checkout? One command brings it to the newest version:

```bash
update.cmd        # Windows (in the CraftPanel folder)
./update.sh       # Linux / macOS / Raspberry Pi
```

It keeps your local changes and commits, installs dependencies, rebuilds, and on a Linux service install restarts the service. Your servers, worlds, backups and settings live in the data directory and are not touched; database changes are applied automatically on the next start. Restart CraftPanel afterwards if it was running.

<details>
<summary>Copy from before 7 November 2026 (no update script yet, or <code>git pull</code> fails)</summary>

The published history was reorganised once. Run this one time in the CraftPanel folder, then use the update script from then on:

```bash
git stash
git fetch origin
git reset --hard origin/main
```

`git stash` keeps any edits you made; nothing in your data directory is affected.
</details>

## Configuration

All settings are environment variables. Installed with the one-line installer, they go into `/etc/craftpanel/craftpanel.env` (Linux) or `config.env` in the install folder (Windows). See [`.env.example`](.env.example).

| Variable | Default | Purpose |
| --- | --- | --- |
| `CRAFTPANEL_PROFILE` | `local` | Start profile: `local`, `lan`, `proxy` or `headless` (also `pnpm start:<profile>`) |
| `CRAFTPANEL_HOST` | from profile | Dashboard bind address |
| `CRAFTPANEL_PORT` | `8080` | Dashboard port |
| `CRAFTPANEL_DATA_DIR` | platform default | Servers, backups, Java runtimes, database |
| `CRAFTPANEL_PUBLIC_URL` | — | Browser-facing HTTP(S) origin; use the external HTTPS address behind a proxy |
| `CRAFTPANEL_TRUSTED_PROXIES` | loopback in proxy mode | Comma-separated trusted proxy IPs/CIDRs |
| `CRAFTPANEL_SECURE_COOKIES` | from profile/TLS/public URL | Enabled automatically for HTTPS; cannot be disabled when HTTPS is configured |
| `CRAFTPANEL_TRUST_PROXY` | from profile | Legacy switch: `true` trusts loopback proxy peers only; prefer explicit trusted proxies |
| `CRAFTPANEL_TLS_CERT` / `CRAFTPANEL_TLS_KEY` | — | Serve HTTPS directly with these PEM files |
| `CRAFTPANEL_SESSION_TTL_HOURS` | `168` | Session lifetime |
| `CRAFTPANEL_LOG_LEVEL` / `CRAFTPANEL_LOG_FORMAT` | `info` / `pretty` | Logging (`debug` shows every request, `json` for log collectors) |
| `CRAFTPANEL_UPDATE_CHECK` | `true` | `false` never contacts GitHub for the update notice (also a switch in Settings) |

Who may open the dashboard from other devices is configured live in **Settings → Remote access** (see [docs/deployment](docs/deployment/README.md#remote-access-for-teams)).

For a checkout, load a configuration file explicitly: `node --env-file=.env apps/api/dist/index.js`. Copying `.env.example` to `.env` alone does not load it. Deployment diagnostics are available in Remote access and with `node --env-file=.env apps/api/dist/index.js doctor --json`; see [deployment diagnostics](docs/deployment/README.md#deployment-diagnostics).

## Development

```bash
pnpm install
pnpm dev          # API on :8080 (auto-reload) + dashboard on :3000, data in ./.data
pnpm test         # unit + integration tests (Vitest)
pnpm test:e2e     # end-to-end: real browser, real Minecraft server download & run (needs internet)
pnpm typecheck
pnpm db:generate  # after changing packages/database/src/schema.ts
```

Architecture, package layout and contribution notes: [docs/architecture](docs/architecture/README.md) and [docs/development](docs/development/README.md).

## Status

See [docs/STATUS.md](docs/STATUS.md) for what is implemented, how it was verified, and known limitations. What's planned next: [docs/ROADMAP.md](docs/ROADMAP.md).

## Security

CraftPanel runs Minecraft servers as **native processes without container isolation**. Plugins are arbitrary code running as the CraftPanel user. Read [docs/security](docs/security/README.md) before exposing anything to a network.

## Author

CraftPanel was created by **Victor** ([@vctrchappot](https://github.com/vctrchappot)) · [www.vctr.site](https://www.vctr.site).
Issues and ideas are welcome on [GitHub](https://github.com/vctrchappot/CraftPanel).

## License

Copyright © 2026 Victor ([@vctrchappot](https://github.com/vctrchappot)). Licensed under the [Functional Source License 1.1, ALv2 Future License (FSL-1.1-ALv2)](LICENSE). You may use, change and share CraftPanel for any purpose except offering it, or something substantially similar, as a commercial product or service that competes with it. Running it for yourself, your community or your own company is allowed. Each version becomes available under the Apache License 2.0 two years after its release. See [docs/development](docs/development/README.md#license) for details and dependency license notes.
