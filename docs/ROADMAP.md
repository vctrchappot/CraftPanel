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
- [ ] Release workflow: on a `v*` tag, build once and publish `craftpanel-vX.Y.Z.tar.gz` (the self-contained `apps/api/dist` plus `deploy/`, `README.md`, `LICENSE`) with release notes. The bundle has no native add-ons, so one archive fits every OS and CPU.
- [ ] `deploy/install.sh` for Linux/Pi (`curl -fsSL …/install.sh | bash`): checks Node.js, downloads and verifies the release, installs to `/opt/craftpanel`, sets up the systemd service, prints the address and setup token. Re-running updates.
- [ ] `deploy/install.ps1` for Windows (`irm …/install.ps1 | iex`): same, with a scheduled task or service wrapper.
- [ ] Update notice in the dashboard (checks GitHub Releases; no auto-update), and let the update script use releases for non-git installs.
- [ ] Version bump process: single source of truth for the version (`package.json` → `CRAFTPANEL_VERSION`), changelog.
- [ ] Optional: multi-arch Docker image (amd64/arm64) with a data volume.

### 2. Quick platform wins
- [ ] Log4Shell protection for Minecraft 1.7–1.18 (JVM flag / patched log config), verify it is applied. Security-relevant, small.
- [ ] Fabric provider (Fabric meta API, server launcher jar; mods via the existing Modrinth integration).
- [ ] Purpur provider (Paper fork, same plugin handling).

### 3. Teams and security (Phase 2)
- [ ] Two-factor sign-in (TOTP), optionally required per role.
- [ ] Per-server permissions (e.g. a moderator who only manages one server).
- [ ] Session overview: signed-in devices, sign out remotely.
- [ ] Notifications via Discord webhook / e-mail: crash, failed backup, update available.

### 4. More platforms (Phase 3)
- [ ] NeoForge (run the installer with `--installServer`, start via its argument files).
- [ ] Modrinth modpacks (`.mrpack`) with one click.
- [ ] Velocity proxy (several servers behind one address).
- [ ] Bedrock Dedicated Server (x64 only, no ARM; the runtime already supports a custom launch command).
- [ ] Hangar as a second plugin source.

### 5. Comfort and optimisation (Phase 4)
- [ ] Measure first: panel idle CPU/RAM, startup time, backup duration, database growth on a Pi.
- [ ] Performance presets for Pi and small VPS (JVM flags, view/simulation distance, optional chunk pre-generation).
- [ ] Incremental/deduplicated backups and destinations such as USB drives or S3-compatible storage.
- [ ] German UI (i18n) and a checked mobile layout.
- [ ] Test on a physical Raspberry Pi 4/5.

### Later
- Several machines in one dashboard (remote agents; the `RuntimeAgent` interface already exists, only `LocalAgent` is implemented).
- Optional hosted tunnel so servers are reachable without port forwarding.
- Per-server process isolation (systemd sandboxing, later containers).

## Recommended order
1 → 2 → 3, then 4/5 depending on feedback. Announce publicly (r/admincraft, r/selfhosted) once release packages and one-line installers exist.
