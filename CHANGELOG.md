# Changelog

All notable changes to CraftPanel. Versions follow [semantic versioning](https://semver.org); while the version starts with 0, minor versions may change behaviour.

`scripts/release.mjs <version>` turns the "Unreleased" section into the release notes for that version.

## Unreleased

### Added
- Transactional Linux and Windows updates: verify recovery support before stopping, snapshot the database and startup artifacts, restore on installation failures, reject concurrent installers and retain two successful recovery points. Source-based Linux installs use the same installer path.
- Windows process supervisor with suspended startup and a kill-on-close Job Object so scheduled-task shutdown also owns Node and its descendants.
- Browser-facing dashboard origins (`CRAFTPANEL_PUBLIC_URL`) and explicit trusted proxy peers (`CRAFTPANEL_TRUSTED_PROXIES`), including proxies on another host.
- Deployment checks in Remote access, a read-only `doctor` command with JSON output, and `/api/ready` for startup/database readiness.
- Release packages: every `v*` tag publishes one archive that runs on every OS and CPU (no build on the target machine), with SHA-256 checksums.
- One-line installers: `install.sh` for Linux and Raspberry Pi (systemd service, private Node.js if needed) and `install.ps1` for Windows (runs at sign-in, no admin rights needed). Re-running them updates; a failed update rolls back.
- Update notice in the dashboard when a newer release is available, with the right update command for the install.
- Settings in `/etc/craftpanel/craftpanel.env` (Linux service) survive updates.
- Purpur servers (Paper fork; same plugins, TPS/MSPT and `/craftpanel` command).
- NeoForge servers with a choice of NeoForge version (the official installer runs during installation); NeoForge mods from Modrinth (search, install, updates, upload) with dependency checks from `neoforge.mods.toml`.
- When NeoForge fails to load a mod, the crash reason names the jar (and says when it is a client-only mod) instead of a generic "Failed to start the minecraft server".
- Fabric servers with a choice of loader version; Fabric mods from Modrinth (search, install, updates, upload) with dependency checks by mod id.
- Log4Shell protection for Minecraft 1.7–1.18: CraftPanel adds Mojang's JVM flag or patched logging config on every start and shows it in the wizard and the server's runtime settings.
- Two-factor sign-in with an authenticator app (TOTP) and recovery codes; owners can require it per role and reset it for a user.
- Signed-in devices: see and sign out your sessions; owners can sign a user out everywhere.
- Per-server access: give users a role on single servers, or limit them to selected servers (e.g. a moderator for one server).
- Settings → Software & version: switch between Paper, Purpur, Fabric, NeoForge and Vanilla in any direction, change the Minecraft version or build, with a preview of what will happen (backup, world upgrade, add-ons that stop loading). Downgrades need an explicit confirmation.
- Update CraftPanel from the dashboard: "Update now" shows the release notes and which servers restart, follows the update through the restart and reloads into the new version, with "What's new" afterwards. Failed updates are rolled back and reported in the dashboard, the activity log and notifications. Works for installs made with `install.sh` (systemd) and `install.ps1`; run the installer once more to enable it.
- Performance presets (Raspberry Pi / small VPS, Balanced, Powerful machine): Aikar's garbage collector flags sized for the server's memory plus view and simulation distance. The wizard picks the one recommended for this machine; Settings → Performance switches between them and keeps your other JVM arguments.
- World pre-generation with Chunky (Paper, Purpur, Fabric, NeoForge): install it with one click, choose a radius around spawn, follow the progress, pause, continue or cancel.
- Servers from a modpack: search Fabric and NeoForge modpacks on Modrinth (or upload a `.mrpack`) in the wizard; CraftPanel picks the Minecraft and loader version from the pack, downloads its server-side files with checksum checks, applies its overrides and keeps your port and EULA settings.
- Hangar (PaperMC's plugin repository) as a second plugin source for Paper and Purpur: switch between Modrinth and Hangar under Plugins → Browse; installs are checked against Hangar's SHA-256, and plugins installed from Hangar show up under Updates.
- `CRAFTPANEL_RELEASE_DIR`: update from a local folder of release archives instead of GitHub.
- Velocity proxy: several servers behind one address. Create a Velocity server in the wizard, add servers on its Proxy tab in the order players should try them (optionally with a forced host), and CraftPanel writes `velocity.toml`, sets up modern forwarding with a generated secret and configures Paper/Purpur backends (and Fabric backends via FabricProxy-Lite) on their next start. Backends can be bound to this computer so players can only join through the proxy. Velocity plugins from Modrinth.
- Notifications via Discord webhook and e-mail (SMTP) when a server crashes or fails to start, a backup or scheduled task fails, or a CraftPanel update is available; with a test button.

### Changed
- License: CraftPanel is now under the PolyForm Strict License 1.0.0 (free for personal and noncommercial use; no selling, changes or redistribution) instead of AGPL-3.0-or-later.
- The version lives only in `package.json`.
- Faster and smaller: the dashboard is sent brotli/gzip-compressed (about 1.2 MB of JavaScript → 0.3 MB) and cached by the browser; the panel starts about 15% faster and uses less memory; the release archive no longer ships the 8 MB source map.
- The system view answers in about 2 ms instead of 9 ms on Windows.
- Downloads (Minecraft, Java, mods) retry twice on temporary server errors such as an HTTP 504 from GitHub instead of failing the installation.

### Fixed
- Concurrent first-run requests can create only one owner account. Windows task shutdown now owns the entire managed process tree, including failed startup before a control token exists.
- Reverse-proxy setup requires the host's setup token even when the backend listens on loopback. Public clients require HTTPS and Secure cookies; missing proxy client-IP headers and ambiguous transport headers are rejected.
- HTTP and WebSocket origin checks include the scheme and support an external origin when the proxy rewrites Host. Backend TLS and Secure cookies are no longer presented as proof of browser HTTPS.
- The server section navigation can no longer be scrolled vertically by a pixel; it only scrolls sideways when the sections do not fit.
- Two servers installing at the same time no longer break each other's Java download.
- Switching from Paper or Purpur (Minecraft 1.21 and older) to Vanilla or Fabric no longer loses the Nether and the End: their folders are moved back into the world.
- The Worlds tab shows the Nether and the End for Minecraft 26.x worlds.
- Dashboard links no longer request missing prefetch files (404s in the browser console); page changes are faster.
- The Linux installer could report a failed update although the rollback had worked (systemd's restart counter from the broken version was counted again).
- On Windows the dashboard could miss how CraftPanel was installed (`install.json` with a byte order mark), so it showed no update command.
- Development mode (dashboard on its own port) rejected PUT/PATCH/DELETE requests because of the CORS defaults.
- Invalid HTML nesting in the dashboard (a loading placeholder inside a paragraph) that caused hydration warnings, and a WebSocket warning in development.

## 0.1.0 – 2026-11-07

First public version.

- Vanilla and Paper servers for any published version, checksum-verified downloads, automatic Java.
- Live console, metrics (CPU, RAM, TPS/MSPT), players, whitelist/ops/bans, settings and game rules editors.
- Plugins from Modrinth, worlds, file manager, backups with verification and restore, scheduled tasks.
- Start profiles (`local`, `lan`, `proxy`, `headless`), network access policy, optional built-in HTTPS.
- Multi-user with roles and an audit log, setup token for network-exposed installs.
- In-game `/craftpanel` info command.
- Linux systemd installer for git checkouts and the `update.cmd` / `./update.sh` update script.
