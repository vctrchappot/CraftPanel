# Roadmap

Where CraftPanel stands and what comes next. For what is implemented and how it was verified, see [STATUS.md](STATUS.md).

**Goal:** clone or download CraftPanel, run it on a second PC, a Raspberry Pi or a VPS, and create and manage Minecraft servers across platforms and versions from a browser, without needing to know Docker, Java or networking.

## Current state (2026-11-09)

**CraftPanel 1.0.0 is the first stable release.** Everything below "Done" and every ticked item ships in it, including the independent runtime service (games survive dashboard restarts, crashes and updates). Releases v0.1.0–v0.3.0 and v1.0.0 are on GitHub; 0.x installs update with the commands in the changelog. No known small issues are open.

- **Open verification gaps** (not blockers, listed honestly in STATUS.md): an actual Windows host shutdown on a disposable VM; dashboard-triggered updates and concurrent installers on Windows; the `curl | sudo bash` / `irm | iex` path on a physical Pi and a small VPS.
- **Current phase: per-server isolation and resource limits** (section below). Order: Linux isolation (done 2026-11-12) and Linux limits (done 2026-11-13), both verified on an installed Ubuntu service, and Windows limits (done 2026-11-13, verified with a dev-style runtime); next Windows isolation. Running the installers on a physical Pi and a small VPS and announcing (step 1) needs hardware and can happen in parallel. Bedrock, Pi/VPS measurements and the Velocity open points (step 4) remain planned.
- **AI assistant** (unreleased): optional bring-your-own-key assistant with approvals and per-user permissions, verified on Paper with a scripted model; a run against real providers (Claude, OpenAI, Ollama) is still open. Ideas: streaming answers, more tools (worlds, network, pre-generation), conversation export.
- **Player profiles** (unreleased): every player has a profile (Overview, Inventory, Statistics, Activity) built from CraftPanel's session log and Minecraft's per-player files; verified on Paper 1.21.4 and Vanilla 26.1 (`scripts/real-tests/player-profile.mjs`). Ideas not done: shulker box contents, per-world statistics, a server-wide leaderboard. **Player actions** (unreleased): an Actions view in every profile (manage, fun, access and player data) with a shared action catalog; verified on Paper, Vanilla and Fabric 1.21.4 (`scripts/real-tests/player-actions.mjs`). Ideas not done: reading scores of the scoreboard, plugin-specific lookups (EssentialsX, LuckPerms) from their commands, more pranks, a bulk action on several players.
- **Real-server test scenarios** used for the ✅ entries live in `scripts/real-tests/` (see its README).
- **Design and polish:** dashboard, website and docs share Inter, Mona Sans and Mona Sans Mono and the Signal/Amber/Ember/Ash palette. The website (home page and the Pi, Windows and friends guides) was redesigned on 2026-11-14 as one framed grid with the dashboard rebuilt in the hero and night-lit isometric scenes; locale, adapter labels, activity icons and console spacing are verified on a throwaway Paper instance. Rules and evidence: [design/README.md](design/README.md), [STATUS.md](STATUS.md).
- **Panel design-system reference:** a dedicated six-chapter docs section documents foundations, shared component APIs, responsive layouts, data presentation, states, accessibility review and implementation. Colour tables read the actual shared tokens; theme-aware examples accompany the reference. Existing design-system bookmarks remain valid.

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

### Minecraft-Laufzeit vom Dashboard trennen (done, one gap)

User outcome: the dashboard can close, restart or update while Minecraft continues;
afterwards its actual state, console and controls are available again.

- [x] Asynchronous runtime interface; orchestration depends on the contract.
- [x] Separate process owner, authenticated Unix socket / Windows named pipe, bounded history and protocol handshake (automated child-process tests).
- [x] Dashboard reconnect reconciles actual runtime snapshots, rejects controls while disconnected, and never retries expired or uncertain commands (automated integration tests).
- [x] Ubuntu/systemd installer migration and independent dashboard/runtime update transactions (isolated Ubuntu/systemd with real Paper worlds, legacy migration and rollbacks).
- [x] Windows installer parity: SCM service under a virtual account, updates, rollback, crash recovery and real-player continuity (CI on a hosted runner).
- [ ] Verify an actual Windows host shutdown and boot on a disposable VM (the shared stop path is verified; Windows does not let applications send preshutdown).
- [x] Explicit maintenance action and runtime-update interruption preview in the dashboard (real-server stop-all and controlled release-preview browser checks).
- [x] Prove a real player remains connected during dashboard restart/update and abrupt crash (isolated Ubuntu/systemd and Windows SCM in CI, Paper 1.21.4 + mineflayer).
- [x] Prove disconnect/replay handling, graceful host reboot/autostart, preserved worlds/configuration and recoverable update failure on installed services (Ubuntu/systemd including shutdown/boot of a disposable WSL host; Windows except an actual host shutdown).

Commit order: interface → service → reconnect → installers → failure/acceptance tests.
Do not mark this phase complete from mocked or child-process-only evidence.
Following phases: per-server isolation/resources → complete backups and host moves → multiple hosts.

### Per-server isolation and resource limits (current phase)

User outcome: a malicious or broken plugin/mod cannot read the panel database, the runtime token or other servers' files, and one server cannot starve the host or its neighbours.

Today the dashboard, the runtime and every Minecraft process run as the same account (`craftpanel` on Linux; on Windows the runtime's virtual account has Modify on the whole data directory), so a plugin can read `craftpanel.db` (password hashes, sessions, AI provider keys) and the runtime token. Isolation therefore comes first.

- [x] Linux: every server runs under its own game account (`<service>-game-NN`, created by the installer). The runtime holds `CAP_SETUID/SETGID/CHOWN/FOWNER/KILL` (bounded set, `NoNewPrivileges` on) and starts Java through `setpriv` without capabilities or groups. Database, secrets, runtime token, backups and other servers are unreadable for game processes; the dashboard shares files through the game group (setgid directories, `UMask=0007`) and asks the runtime to share Java's private 0600 files. Leftover processes die with their server. Details: [architecture/runtime.md](architecture/runtime.md#per-server-accounts-linux).
- [ ] Linux follow-ups: an upgrade from 1.0.0 with existing servers on a real install (permissions of old files are fixed on each server's next start, untested there); show the isolation state in the dashboard (Remote access / `doctor --json`); move `.craftpanel-map.json` out of the server directory (the game can't read it, but can replace it).
- [x] Resource limits per server: memory cap (heap plus headroom), CPU share and process count, stored in the database, sent with the launch spec, edited in the Performance tab and applied live. Default for new and existing servers: protective limits only (4,096 tasks, heap + max(1 GB, half the heap), no CPU limit).
- [x] Linux limits through cgroup v2 delegation (`Delegate=memory cpu pids`, one child cgroup per server with `memory.max` + `memory.swap.max=0`, `cpu.max`, `pids.max`); an OOM kill is reported as "Memory limit reached" from `memory.events`. Verified with `scripts/real-tests/limits.mjs`.
- [x] Windows limits through one nested job object per server, held by a small C# helper the runtime compiles with the Windows `csc.exe` (no native add-ons). Verified with `scripts/real-tests/limits-windows.mjs`; 🟡 the installed service (virtual account) still needs an elevated run.
- [x] The runtime reports what the host supports; dev mode, Windows, macOS, cgroup v1 or a missing memory controller (some Pi kernels) show "not enforced" with the reason instead of failing. 🟡 A Pi kernel without the memory controller is untested.
- [ ] Windows isolation: spike an AppContainer per server (loopback, network capabilities, JVM behaviour); fall back to a restricted token with narrower data-directory ACLs; document what remains in STATUS.md.
  - Spike 2026-11-14 (Windows 11, normal user, Paper 1.21.4 copy, `internetClient`/`internetClientServer`/`privateNetworkClientServer`): a process starts in an AppContainer only once its profile exists (`CreateAppContainerProfile` works without admin; a derived SID alone fails with "file not found"). Java 21 runs inside, but Paperclip's `toRealPath` lists every ancestor of the server directory, so the container needs list/traverse on all of them, including `C:\Users`, which only an elevated installer can grant (a capability SID like other sandboxes on this host use). Inbound loopback (127.0.0.1 and the host's own addresses) to a listener in the container times out: local players, the dashboard's status ping and a Velocity proxy on the same host would not reach the server without a loopback exemption, which needs admin. Inbound from another machine was inconclusive (the host firewall also blocks an unconfined listener from WSL).
  - Repeated 2026-11-14 in Windows Sandbox as administrator: with `(S,RD,X,RA)` for the container SID on every ancestor (synchronize is required: `FindFirstFile` fails with only `RD,X,RA`), RX on Java and Modify on the server directory, Paper 1.21.4 starts fully and stops cleanly; no low integrity label is needed. Another machine reaches it through an inbound firewall rule. Loopback stays blocked even with `CheckNetIsolation LoopbackExempt`, which only lets a container connect out: the dashboard's status ping, a Velocity proxy and players on the same host could never reach an isolated server. AppContainer is therefore out.
  - Next: the restricted token (per-server restricting SID granted on the server directory and Java; network and loopback unchanged), verified in Windows Sandbox.
- [ ] Real evidence (`scripts/real-tests/`): Paper on Ubuntu/systemd and Windows; a probe running as a game process cannot read the database or token; a server over its memory limit is stopped and reported; players stay connected. The runtime fingerprint changes, so updating needs the maintenance restart.

### Professional deployments

- [x] Canonical browser-facing origin (`CRAFTPANEL_PUBLIC_URL`), explicit trusted proxy peers, HTTPS checks for public clients and public access-rule changes, and setup-token protection behind reverse proxies.
- [x] Deployment diagnostics in Remote access and the read-only `doctor --json` command; separate liveness and readiness endpoints.
- [x] Standalone recovery protocol, consistent database snapshots and startup-artifact rollback verified through isolated Linux/Windows package installs, including failed migrations, unsupported targets and hanging startup. Linux also covers an invalid systemd unit. Source installs share the release installer transaction.
- [x] Real HTTPS reverse-proxy, built-in TLS and WebSocket package tests on Windows and Ubuntu/WSL2, plus the Remote access UI in Chromium.
- [x] Dashboard-triggered update with rollback and runtime approval, and concurrent installers (Ubuntu/systemd, `dashboard-update.mjs`).
- [ ] The same on Windows, and a physical separate-host HTTPS proxy; keep STATUS.md evidence specific to each environment.
- [x] Separate the runtime service from the API so panel updates do not stop game servers and reconnect restores control.
- [ ] Add per-server OS isolation and resource limits.
- [ ] Add complete application backup/restore and host migration, including configuration and secrets outside the panel database.
- [ ] Add persistent monitoring and recoverable background jobs, then authenticated remote agents and multiple hosts.

Database recovery is a foundation for failed-update handling, not full world rollback or a general downgrade mechanism. Existing TOTP, per-server roles and session controls remain in place; SSO and scoped automation credentials can follow the runtime and recovery work.

### 1. Release packages and one-line installers (finish Phase 1)
The biggest step for "run it on a Pi or VPS": no pnpm, no build on the target machine (a Next.js build on a Pi 4 is slow and memory-hungry).
- [x] Release workflow: on a `v*` tag, build once and publish `craftpanel-vX.Y.Z.tar.gz` with release notes from `CHANGELOG.md` and `SHA256SUMS`.
- [x] `deploy/install.sh` for Linux/Pi: verifies the release, private Node.js if needed, systemd service, settings file kept on updates, rollback if the new version doesn't start. Re-running (or `/opt/craftpanel/update.sh`) updates.
- [x] `deploy/install.ps1` for Windows: per-user install, scheduled task at sign-in, graceful stop via a local control channel, rollback.
- [x] Update notice in the dashboard (GitHub latest release, opt-out; shows the update command for the install method).
- [x] One-click update from the dashboard (systemd path unit / scheduled task run the installer; progress, reload, "What's new", rollback reported), local release folder for offline installs.
- [x] Version bump process: `package.json` is the single source, `node scripts/release.mjs bump X.Y.Z` dates the changelog, commits and tags.
- [x] Publish releases (v0.1.0–v0.3.0, stable v1.0.0); a v0.1.0 → v0.2.0 Windows package update was verified in an isolated install.
- [ ] Run the real `curl | sudo bash` / `irm | iex` path against a release on a physical Pi and a small VPS.
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
- [x] Velocity proxy (several servers behind one address): Velocity from Fill, backends in try order with forced hosts, modern forwarding with a generated secret, Paper/Purpur and Fabric (FabricProxy-Lite) backends configured on start, optional bind to 127.0.0.1.
- [ ] Bedrock Dedicated Server (x64 only, no ARM; the runtime already supports a custom launch command).
- [x] Hangar as a second plugin source: search, install (Paper jar with SHA-256) and update checks for plugins installed from Hangar.

#### Velocity — open points
- NeoForge backends: only a note for now. Proxy Compatible Forge is on Modrinth as `vDyrHl8l`; its config isn't written.
- Fabric backends (FabricProxy-Lite) are unit-tested but not yet run for real.
- Velocity plugins from Hangar (platform `VELOCITY`).
- Player join/leave detection from Velocity's `[connected player] Name (/ip) has connected` lines.
- A backend's port change while the proxy runs needs a proxy restart.
- Paper older than 1.19 (`paper.yml` `settings.velocity-support`) is refused.
- Velocity warns once about a "deprecated configuration version" on the first start because CraftPanel writes a partial `velocity.toml`; harmless, Velocity rewrites the file.

### 5. Comfort and optimisation (Phase 4)
- [x] Measure first: `scripts/measure.mjs` (startup, idle CPU/RAM, API latency, bundle sizes); first fixes from it: minified API bundle, precompressed dashboard with long-lived caching, cached host info in `/api/system` (numbers in STATUS.md).
- [ ] Run `scripts/measure.mjs` on a Pi and a small VPS; add backup duration and database growth over weeks of activity.
- [x] Performance presets for Pi and small VPS (JVM flags, view/simulation distance) with a recommendation per machine, and chunk pre-generation with Chunky. A Performance tab per server with insights, live charts and all tuning in one place (history in memory; persistent monitoring stays under "Professional deployments").
- [ ] Incremental/deduplicated backups and destinations such as USB drives or S3-compatible storage.
- [ ] German UI (i18n) and a checked mobile layout.
- [ ] Test on a physical Raspberry Pi 4/5.

### Later
- Several machines in one dashboard (remote agents; the `RuntimeAgent` interface already exists, only `LocalAgent` is implemented).
- Optional hosted tunnel so servers are reachable without port forwarding.
- Per-server process isolation (systemd sandboxing, later containers).

## Recommended order
1 → 2 → 3, then 4/5 depending on feedback. Announce publicly (r/admincraft, r/selfhosted) once release packages and one-line installers exist.
