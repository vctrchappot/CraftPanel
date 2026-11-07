# CraftPanel

**Self-hosted Minecraft server management.** Install CraftPanel on your PC, a spare computer, a Raspberry Pi or a VPS, open the dashboard in a browser, and create, run and manage real Minecraft Java servers. No accounts, no subscriptions, no cloud.

- Creates **Vanilla** and **Paper** servers for any published version, downloaded from Mojang and PaperMC and checksum-verified.
- Provisions the **right Java version automatically** (Eclipse Temurin 8/17/21/25 from Adoptium) for Windows, Linux and macOS on x64 and ARM64.
- **Live console** over WebSockets, real CPU/RAM/TPS/MSPT metrics, player tracking.
- Validated **server.properties editor**, version-aware **game rules**, whitelist/ops/bans.
- **Plugins** from Modrinth with compatibility checks, uploads, updates and a Vanilla→Paper migration.
- **Worlds, file manager, backups** (consistent live backups, verification, restore with automatic safety backup) and **scheduled tasks**.
- **LAN/WAN guidance** with diagnostics (CGNAT detection), optional DuckDNS.
- **Multi-user** with Owner / Administrator / Operator / Viewer roles and an audit log.

> Minecraft is a trademark of Mojang AB. CraftPanel is not affiliated with Mojang or Microsoft and never redistributes server software. It downloads it from official sources on your behalf after you accept the [Minecraft EULA](https://aka.ms/MinecraftEULA).

## Quick start

Requirements: **Node.js 22.13 or newer** (24 LTS recommended), **pnpm** (`corepack enable`, or `npm install -g pnpm` on Node 25+ where corepack is no longer bundled), Git, and an internet connection for downloads. Java is installed automatically.

```bash
git clone <this repository> craftpanel
cd craftpanel
corepack enable            # Node 25+: npm install -g pnpm
pnpm install
pnpm build
pnpm start
```

Open **http://127.0.0.1:8080**, create the owner account, and follow the wizard to create your first server.

### Running on another machine (second PC, Raspberry Pi, VPS)

By default the dashboard only listens on `127.0.0.1`. To manage CraftPanel from other devices on your network, bind it to the network:

```bash
CRAFTPANEL_HOST=0.0.0.0 pnpm start          # Linux / macOS
$env:CRAFTPANEL_HOST="0.0.0.0"; pnpm start  # Windows PowerShell
```

When the dashboard is reachable from the network, the first account can only be created with a **one-time setup token**. It is printed in the console on startup and saved as `setup-token.txt` in the data directory. Nobody else on your network can claim the owner account first.

For a permanent install on Linux (including Raspberry Pi OS 64-bit), use the systemd installer:

```bash
sudo ./deploy/install-linux.sh
```

See [docs/deployment](docs/deployment/README.md) for Windows, macOS, Raspberry Pi, VPS and reverse-proxy/HTTPS setups.

> **Do not port-forward the dashboard.** Only the Minecraft game port should be reachable from the internet. Use a VPN (WireGuard, Tailscale) or an HTTPS reverse proxy with care for remote administration.

## Configuration

All settings are environment variables. See [`.env.example`](.env.example).

| Variable | Default | Purpose |
| --- | --- | --- |
| `CRAFTPANEL_HOST` | `127.0.0.1` | Dashboard bind address |
| `CRAFTPANEL_PORT` | `8080` | Dashboard port |
| `CRAFTPANEL_DATA_DIR` | platform default | Servers, backups, Java runtimes, database |
| `CRAFTPANEL_SECURE_COOKIES` | `false` | Set `true` behind HTTPS |
| `CRAFTPANEL_TRUST_PROXY` | `false` | Set `true` behind a reverse proxy |
| `CRAFTPANEL_SESSION_TTL_HOURS` | `168` | Session lifetime |

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

See [docs/STATUS.md](docs/STATUS.md) for what is implemented, how it was verified, and known limitations.

## Security

CraftPanel runs Minecraft servers as **native processes without container isolation**. Plugins are arbitrary code running as the CraftPanel user. Read [docs/security](docs/security/README.md) before exposing anything to a network.

## License

[AGPL-3.0-or-later](LICENSE). See [docs/development](docs/development/README.md#license) for the reasoning and dependency license notes.
