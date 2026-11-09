# Changelog

All notable changes to CraftPanel. Versions follow [semantic versioning](https://semver.org): from 1.0.0 on, minor and patch releases keep existing installs, data and settings working, and changes that need manual steps come only with a new major version. (Before 1.0, minor versions could change behaviour.)

`scripts/release.mjs <version>` turns the "Unreleased" section into the release notes for that version.

## Unreleased

### Changed
- New logo: an isometric block with a console prompt, in the dashboard, favicon and website. The dashboard uses lighter weights and shares its design tokens with the website: warmer greys, Signal green for brand and running, Amber/Ember/Ash for other states, neutral focus and active controls, and smaller corners.
- Landing page polish: clearer heading hierarchy (72/48/22/16 px), connected bento displays with one outer frame and shared dividers, solid rules, active-only offset shadows, copy button and shell prerequisites in the full install terminal, `#macos` tab deep-linking in the installation guide, consistent software cards, a plugin search preview, a complete six-item feature list, and a factual project/source section.
- More detailed original isometric hardware and block-world artwork, plus a unified interactive showcase of panel updates and rollbacks keeping the Minecraft runtime and connected players online.
- Slightly tighter Sans letter spacing across the dashboard, website and docs; commands and console output retain their normal Mono spacing.
- The website's isometric scenes and demos move: the Pi's world floats with data rising to it, drive lights blink, players walk and chimneys smoke during the panel-update demo, the dashboard link pulses until an update starts, feature tiles settle in on scroll and the plugin search types itself. Scenes pause off-screen and stand still with reduced motion.
- Website server-software section: the panel mockup keeps its tab bar on one line (scrolling with a fade when narrow), scales the memory value to its tile so it never overflows, shows a block icon instead of the plug for Fabric and NeoForge, and the trust icons are outlined at one stroke width and centred on their titles. Card descriptions use balanced line breaks.
- New process band under the hero: seven steps from install to update (checksum, Java, software, port, players, backup, update) in a datasheet frame labelled "runs on your hardware", with your browser and your players outside it. The steps sit on one line and are tagged with who does them (you, CraftPanel, players); the line fills as the band plays through, and a note says which three steps are yours. It introduces outlined isometric drawings and frame marks as a second drawing register next to the filled Minecraft scenes. It stacks vertically on narrow screens and stands still with reduced motion.
- Website "Project & source" section: a "View on GitHub" button, one link style, a wider facts table with larger, higher-contrast labels, a release badge with a release-notes link, and a stacked layout under 700 px.
- New type system: Inter for text, Mona Sans for headers, titles and the wordmark, Mona Sans Mono for the console, commands and technical labels. All self-hosted; Geist Serif stays for release notes.

### Fixed
- The plugin/mod browser no longer marks removed or never-installed entries as "Installed". The badge is derived from the live plugin list instead of the search result's snapshot (which lingered while a search refreshed), the list refreshes when switching tabs, a jar from a marketplace is only matched by its project id rather than a similar name, and marketplace records of jars deleted outside CraftPanel are dropped.
- Signed-in devices no longer pile up: signing in again from a browser that is already signed in replaces its session, and a user keeps at most 20 sessions (the longest-idle ones end first).
- `stop` or `restart` typed in the server console no longer shows the server as crashed. A stop is recognised as intended, a clean exit after startup (an in-game `/stop`) counts as a shutdown too, and `restart` starts the server again. A clean exit during startup, such as an unaccepted EULA, is still reported.
- On Windows, removing, disabling or updating a plugin or mod the running server has loaded now says to stop the server first (409) instead of failing with a filesystem error, and a refused update no longer leaves a second copy of the jar behind.
- Dashboard dates and relative times use the English UI locale instead of mixing in the browser's language.
- Connection addresses list real LAN adapters first and label known VPN, WSL, Hyper-V, Docker and VirtualBox adapters separately.
- Activity events have icons and status colours by event kind; updates and installs stay neutral. Console output has more space above the first line and uses shared status colours.
- Compact recent-event lists scroll within the neighbouring column's height on desktop and cap at 320 px on mobile. The latest events remain first, with immediate overview refreshes when server events arrive.

## 1.0.0 – 2026-11-09

### Upgrading
First stable release. From 0.3.x, update from the dashboard or re-run the installer. From 0.2.x or older, follow "Upgrading from 0.2.x" under 0.3.0 once.

### Fixed
- Plugin and mod updates from Modrinth no longer suggest beta or alpha versions for an installed stable release; installs that already run a beta keep getting the newest one.
- Updating NeoForge to another version removes the previous version's libraries instead of leaving them in `libraries/`.
- Removing a plugin installed from Hangar also forgets it in `plugins/.craftpanel-hangar.json`.
- The software switch preview says "It stays in the folder" for a single mod or plugin.

## 0.3.0 – 2026-11-09

### Upgrading from 0.2.x
This release moves Minecraft into its own runtime service. The first update saves and stops running servers once (servers with auto-start come back) and needs your explicit approval, so it can't be started from the dashboard of 0.2.x:
- **Linux / Raspberry Pi:** `curl -fsSL https://github.com/vctrchappot/CraftPanel/releases/latest/download/install.sh | sudo bash -s -- --allow-runtime-restart`
- **Windows:** in PowerShell **as administrator** (once, to register the runtime service; same Windows account): `$env:CRAFTPANEL_ALLOW_RUNTIME_RESTART = "1"; irm https://github.com/vctrchappot/CraftPanel/releases/latest/download/install.ps1 | iex`
- **Checkout:** `update.cmd` / `./update.sh`, then `pnpm start` as before; it now starts the runtime too.

Later dashboard-only updates keep your servers running.

### Added
- Independent Minecraft runtime service with authenticated local IPC, console replay and dashboard reconnection. Dashboard-only updates preserve running servers; runtime changes require explicit maintenance approval. Windows service registration needs one elevated installation under the dashboard owner's account.
- `pnpm start` in a checkout starts the runtime and the dashboard together, or reuses a runtime that already runs for the same data directory.

### Fixed
- Runtime-update rollback preserves registry ownership and boot policy. Dashboard rollback leaves an unchanged Windows runtime host untouched. Manual runtime/dashboard starts share the same default data directory, and server installation is not reported complete before runtime registration is acknowledged.

## 0.2.1 – 2026-11-09

### Changed
- Settings lists its sections on the left on wide screens and as a swipeable row on narrow ones, instead of a tab bar that needed horizontal and vertical scrollbars.

### Fixed
- Windows: running `update.ps1` of an installation by hand always acts on that installation. Before, an installation in a custom folder updated (or, with `CRAFTPANEL_UNINSTALL=1`, removed) the default installation unless the same `CRAFTPANEL_*` variables were set again; a conflicting `CRAFTPANEL_INSTALL_DIR` is now refused.
- Windows: a first install with `CRAFTPANEL_PORT` no longer fails with "Another CraftPanel is running" when a different CraftPanel uses port 8080.

## 0.2.0 – 2026-11-09

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
- License: CraftPanel is now under the Functional Source License 1.1 with Apache 2.0 future license (FSL-1.1-ALv2) instead of AGPL-3.0-or-later. Use, changes and redistribution are allowed for any purpose except a competing commercial product or service, and each version becomes Apache-2.0 two years after its release. (An interim switch to PolyForm Strict 1.0.0 was never released.)
- The version lives only in `package.json`.
- `update.cmd` / `./update.sh` show one line per step with its duration instead of the full pnpm and build output. That output goes to `update.log` and is shown only if a step fails; `--verbose` shows it live.
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
