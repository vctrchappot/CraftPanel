# Roadmap

Where CraftPanel stands and what comes next. For what is implemented and how it was verified, see [STATUS.md](STATUS.md).

**Goal:** clone or download CraftPanel, run it on a second PC, a Raspberry Pi or a VPS, and create and manage Minecraft servers across platforms and versions from a browser, without needing to know Docker, Java or networking.

## Done

**Phase 0 – Verify and harden**
- GitHub Actions CI on every push: typecheck, tests and build on Linux, Windows and macOS; full browser flow with a real Minecraft server on Linux x64 and ARM64; the Linux installer including its update path; the committed info plugin must match its source.
- Linux verified end to end (Ubuntu 24.04 with systemd): installer, service, updates, Paper and Vanilla with automatic Java, a real player connecting over the network, kick/ban/whitelist.

**Parts of Phase 1 – Easy install and update**
- One-command update for existing checkouts: `update.cmd` / `./update.sh` (stashes local edits, keeps own commits on a backup branch, copes with rewritten history, rebuilds, restarts a Linux service).
- Start profiles (`local`, `lan`, `proxy`, `headless`), readable logs and a startup banner.
- Remote access for teams: live network policy (this computer / private networks and VPNs / anywhere + extra CIDRs), optional built-in HTTPS, address overview.
- In-game info command: `/craftpanel` (Paper plugin) and `/trigger craftpanel` (datapack), on by default, removable globally, per server or from the Plugins tab.

## Next

### 1. Release packages and one-line installers (finish Phase 1)
The biggest step for "run it on a Pi or VPS": no pnpm, no build on the target machine (a Next.js build on a Pi 4 is slow and memory-hungry).
- [x] Release workflow: on a `v*` tag, build once and publish `craftpanel-vX.Y.Z.tar.gz` with release notes from `CHANGELOG.md` and `SHA256SUMS`.
- [x] `deploy/install.sh` for Linux/Pi: verifies the release, private Node.js if needed, systemd service, settings file kept on updates, rollback if the new version doesn't start. Re-running (or `/opt/craftpanel/update.sh`) updates.
- [x] `deploy/install.ps1` for Windows: per-user install, scheduled task at sign-in, graceful stop via a local control channel, rollback.
- [x] Update notice in the dashboard (GitHub latest release, opt-out; shows the update command for the install method).
- [x] One-click update from the dashboard (systemd path unit / scheduled task run the installer; progress, reload, "What's new", rollback reported), local release folder for offline installs.
- [x] Version bump process: `package.json` is the single source, `node scripts/release.mjs bump X.Y.Z` dates the changelog, commits and tags.
- [ ] Publish the first release and run the real `curl | sudo bash` / `irm | iex` path against it (also on a physical Pi).
- [ ] macOS: a LaunchAgent installer (today: run the release archive with Node.js by hand).
- [ ] Optional: multi-arch Docker image (amd64/arm64) with a data volume.

### 2. Quick platform wins
- [x] Log4Shell protection for Minecraft 1.7–1.18 (JVM flag / patched log config), verified with a JNDI probe.
- [x] Fabric provider (Fabric meta API, server launcher jar; mods via the existing Modrinth integration).
- [x] Purpur provider (Paper fork, same plugin handling).
- [x] Software switch in the dashboard for every direction, version and build changes, with a preview of what happens, a downgrade guard and Paper's Nether/End folders moved back for Vanilla/Fabric.

### 3. Teams and security (Phase 2)
- [x] Two-factor sign-in (TOTP), optionally required per role.
- [x] Per-server permissions (e.g. a moderator who only manages one server).
- [x] Session overview: signed-in devices, sign out remotely.
- [x] Notifications via Discord webhook / e-mail: crash, failed backup, update available.

### 4. More platforms (Phase 3)
- [x] NeoForge (the installer runs with `--installServer`; servers start via its argument files), with NeoForge mods and modpacks from Modrinth.
- [x] Modrinth modpacks (`.mrpack`) with one click: Fabric, NeoForge and vanilla packs from the Modrinth catalogue or an uploaded file (Forge/Quilt packs are refused with a clear message).
- [ ] Velocity proxy (several servers behind one address). In progress, see below.
- [ ] Bedrock Dedicated Server (x64 only, no ARM; the runtime already supports a custom launch command).
- [x] Hangar as a second plugin source: search, install (Paper jar with SHA-256) and update checks for plugins installed from Hangar.

#### Velocity — work in progress
- **Done (code, typecheck and unit tests green):**
  - Software `velocity` (`SOFTWARE_INFO.proxy`), installed from PaperMC's Fill API (project `velocity`, SHA-256), with the Java minimum from Fill (4.3.1 needs Java 25).
  - `ProxyService` (`apps/api/src/services/proxy.ts`): backends in `.craftpanel-proxy.json`, the secret in `forwarding.secret`, and `velocity.toml` rewritten before every proxy start.
  - Backends are reconfigured before every backend start:
    - Paper/Purpur: `online-mode=false` and `proxies.velocity.{enabled,online-mode,secret}` in `config/paper-global.yml`.
    - Fabric: FabricProxy-Lite plus Fabric API from Modrinth, and `config/FabricProxy-Lite.toml`.
  - Optional bind of backends to 127.0.0.1. Removing a backend reverts it.
  - Routes `GET`/`PUT /api/servers/:id/proxy` and `GET`/`POST …/proxy/secret`.
  - Proxies get 409 on worlds, players, game rules and server.properties, and no TPS sampling or save-all before backups.
  - Velocity plugins come from Modrinth with loader `velocity` and are read from `velocity-plugin.json`.
  - Dashboard: a "Velocity proxy" choice in the wizard (no World/Gameplay steps) and a Proxy tab. The Players and Worlds tabs and the properties/game rules/performance settings are hidden for proxies.
- **Verified for real:** Velocity 4.3.1 started by hand in WSL only.
  - The console format is Paper-like (`[19:00:54 INFO]: Done (0.69s)!`), so the existing parser recognises "running", and `stop` shuts it down.
  - Velocity accepts a partial `velocity.toml` without `config-version`. It fills in defaults and rewrites the file in its own layout: keys reordered, tables tab-indented, and `forced-hosts = {}` as a top-level key when there are none.
  - It warns once about a "deprecated configuration version", which is harmless.
- **Not yet verified:** a proxy and two Paper backends via the API, joining with a mineflayer bot, `/server` switching, the backend start hook on a fresh Paper (whether a `paper-global.yml` containing only `proxies.velocity` is accepted), `velocity reload` after saving, and the UI screenshots.
- **Missing / next:**
  - NeoForge backends: only a note for now. Proxy Compatible Forge is on Modrinth as `vDyrHl8l`; its config isn't written.
  - Velocity plugins from Hangar (platform `VELOCITY`).
  - Player join/leave detection from Velocity's `[connected player] Name (/ip) has connected` lines.
  - A backend's port change while the proxy runs needs a proxy restart.
  - Paper older than 1.19 (`paper.yml` `settings.velocity-support`) is refused.

### 5. Comfort and optimisation (Phase 4)
- [x] Measure first: `scripts/measure.mjs` (startup, idle CPU/RAM, API latency, bundle sizes); first fixes from it: minified API bundle, precompressed dashboard with long-lived caching, cached host info in `/api/system` (numbers in STATUS.md).
- [ ] Run `scripts/measure.mjs` on a Pi and a small VPS; add backup duration and database growth over weeks of activity.
- [x] Performance presets for Pi and small VPS (JVM flags, view/simulation distance) with a recommendation per machine, and chunk pre-generation with Chunky.
- [ ] Incremental/deduplicated backups and destinations such as USB drives or S3-compatible storage.
- [ ] German UI (i18n) and a checked mobile layout.
- [ ] Test on a physical Raspberry Pi 4/5.

### Later
- Several machines in one dashboard (remote agents; the `RuntimeAgent` interface already exists, only `LocalAgent` is implemented).
- Optional hosted tunnel so servers are reachable without port forwarding.
- Per-server process isolation (systemd sandboxing, later containers).

## Recommended order
1 → 2 → 3, then 4/5 depending on feedback. Announce publicly (r/admincraft, r/selfhosted) once release packages and one-line installers exist.
