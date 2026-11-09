# Implementation status

## Runtime separation WIP (2026-11-09)

Resume on `wip/runtime-separation`; read [RUNTIME-HANDOFF.md](RUNTIME-HANDOFF.md) before changing or deploying it. **Phase incomplete.**

- 🧪 Authenticated IPC now has bounded, credential-free diagnostics. Real transport-loss tests reject in-flight queries without replay, preserve the process through reconnect and restore autosave after a dashboard disconnect. Reconnect leaves active installations intact; installation completion waits for runtime registration.
- ✅ Isolated Ubuntu/WSL systemd acceptance with real Paper 1.21.4 and a mineflayer player: dashboard restart, SIGKILL/recovery, successful dashboard update, failed migration and invalid-unit rollback preserve the same Java/runtime PIDs and player connection, with commands and console replay working afterwards.
- ✅ Missing, expired and wrong-runtime approvals are refused without interrupting the player. Failed changed-runtime migration rolls back and preserves a gold-block world sentinel; an approved runtime update and graceful runtime-service restart preserve the world and restore auto-start. Testing found and fixed root-owned registry restoration; the recovery helper now preserves ownership/checksums and replaces files atomically without following links.
- ✅ Production deployment smoke covers shared default data paths, HTTPS proxy/rewritten Host, auth/WebSocket, direct TLS, readiness and doctor. Windows Chromium E2E passed a real Vanilla server lifecycle, the maintenance stop-all action and interruption preview states (controlled release metadata; no real UI-triggered update).
- 🧪 Windows typecheck and full suite: 261 passed, 4 Unix-specific skips. CI also found and fixed Unix socket-length failures for deep data paths; owned/validated short aliases keep the actual socket inside the protected runtime directory. macOS CI now passes typecheck, tests, build and production deployment smoke. The earlier intermittent disconnect did not reproduce in twelve complete suite runs; its original cause remains unproven.
- ✅ Ubuntu legacy migration from the combined process: real Paper world and configuration preserved, refusal without maintenance approval, rollback.
- 🟡 Windows SCM service under a virtual account (path grants for traversal and Node execution): the elevated installer, update, rollback and crash-recovery scenarios pass in CI on a hosted runner (run 42587950885, head 192ceb4), not yet on a real host with a connected player.
- ✅ Graceful host shutdown and boot on Ubuntu/systemd (disposable WSL clone, `scripts/real-tests/host-reboot.mjs`, two real Paper 1.21.4 servers): `systemctl poweroff` stopped the runtime unit in 1.5 s without SIGKILL, both Minecraft servers logged a graceful stop and world save, and after boot both units were enabled, only the auto-start server ran again (new Java PID), a player joined, and a block placed without an explicit save was preserved. This is a full systemd shutdown/boot of the distro, not a kernel or firmware reboot.
- ⏳ Windows host shutdown/boot, Windows real-player continuity, dashboard-triggered rollback and concurrent installers. A runtime-service restart is not host-reboot evidence. Phase incomplete; do not merge or release.


Legend: ✅ verified against real Minecraft servers / real services · 🧪 covered by automated tests (unit/integration, fake process) · 🟡 implemented, not yet verified end-to-end · ⏳ planned.

Verification environments so far: **Windows 11 x64, Node 26** and **Linux x64 (Ubuntu 24.04 under WSL 2 with systemd), Node 24**. **GitHub Actions CI** runs on every push: typecheck, unit/integration tests and a production build on Linux, Windows and macOS; the full browser flow with a real Minecraft server on Linux **x64 and ARM64** (the same architecture as a Raspberry Pi 4/5); and the Linux installer with its update path on a systemd host. A physical Raspberry Pi and a manual macOS run are still pending.

Linux run (WSL 2): `deploy/install-linux.sh` + systemd service, update by re-running the installer (graceful world save on restart), Paper 1.21.11 and Vanilla 26.3 with automatically downloaded Linux Java 21/25, a real player connection from another machine (mineflayer bot via the network), kick/ban/pardon/whitelist, the in-game info command, the remote-access policy over the network, and the dashboard in a browser (console auto-scroll, dark-mode dropdowns).

## Professional deployment foundation (2026-11-08)

- 🧪 Canonical public origins, explicit trusted proxy IP/CIDR peers, server-side HTTPS requirements for public access, and setup-token protection for loopback backends exposed through a proxy. Tests cover spoofed and missing forwarding metadata, browser-facing versus backend TLS, public CIDR ranges and HTTP/WebSocket origins.
- 🧪 Deployment diagnostics in Remote access and the read-only `doctor --json` command; missing data directories are not initialized. Readiness is distinct from liveness and includes startup/shutdown state and database availability.
- ✅ Standalone recovery helper: all eleven recovery tests passed on Ubuntu/WSL2, including WAL preservation, schema restore, validation, live-process refusal and symlink replacement. Windows passes the nine applicable tests; two Unix-specific tests are skipped.
- ✅ Real isolated Linux systemd package tests: unsupported archive leaves the original process running; failed migration, invalid unit and hanging startup restore the database and startup configuration; subsequent valid updates and two-successful-snapshot retention work. A proxy listener bound to a specific LAN interface remains reachable to local maintenance probes. The existing normal CraftPanel service was unchanged.
- ✅ Real isolated Windows scheduled-task package tests: unsupported archive, failed migration and hanging startup, restoration of schema/task configuration, subsequent valid updates and snapshot retention. Testing found that Task Scheduler alone left Node children alive; the new suspended-start/kill-on-close Job Object launcher fixed the failure. The updated descendant and bad-launcher fixtures are also registered in CI; dashboard-triggered rollback and concurrent installers still need explicit end-to-end scenarios.
- ✅ `scripts/real-tests/deployment.mjs`: production package tested on Windows 11 (Node 26) and Ubuntu 24.04/WSL2 (Node 24) with a real HTTPS proxy, rewritten Host, setup token, Secure cookies, authenticated WebSocket upgrade and direct TLS. An HTTP browser edge is rejected even when the proxy-to-backend hop uses TLS. The Remote access UI and deployment checks were verified in Chromium on Windows. A physical separate-host proxy is not yet tested.
- ⏳ Per-server process isolation, full application backups, host migration, persistent monitoring/jobs and remote agents. Current update recovery does not restore worlds or server files.

## Core flow (primary success criterion)

| Step | Status | Evidence |
| --- | --- | --- |
| Install, open dashboard, create owner | ✅ | Playwright e2e (`tests/e2e/full-flow.spec.ts`) |
| Create Vanilla server via wizard | ✅ | e2e; Minecraft 26.3, jar SHA-1 verified, Java 25 downloaded from Adoptium |
| Accept EULA, start | ✅ | e2e; start refused without EULA (🧪 API test) |
| Connect from Minecraft on LAN | ✅ | Bot client joined a Paper 1.21.11 server over the network (Windows → Linux VM); chat, live player list, offline UUID, session history |
| Console commands | ✅ | e2e (`say` echoed by the server); WebSocket streaming verified |
| Change settings | ✅ | e2e (validated properties editor) |
| Manage worlds and players | ✅ | API: world export/import, offline whitelist with Mojang UUID lookup; join/leave parsing 🧪 |
| Stop, back up, restore | ✅ | e2e + API: live backup (save-off/flush/save-on), integrity check, restore with safety backup, change reverted |

## Feature checklist

**Runtime & lifecycle**
- ✅ Native subprocess execution without a shell, graceful stop, explicit force-kill
- ✅ Crash detection (Java killed externally → `crashed` with reason)
- ✅ Startup reconciliation when the stored PID is dead (`crashed`/"stopped while CraftPanel was not running")
- 🟡 Orphan adoption when the stored PID is still a live Java process (logic implemented; in the test sandbox child processes die with the parent, so this branch wasn't exercised)
- ✅ Graceful shutdown of all servers on SIGINT/SIGTERM (code path), 🧪 stop-timeout never auto-kills
- ✅ Port conflict, RAM and disk checks before start
- ✅ Auto-start with CraftPanel (code path used by recovery; not restarted-with-autostart in tests) 🟡

**Software & Java**
- ✅ Vanilla (Mojang manifest, SHA-1), Paper (Fill v3 API, SHA-256, build selection)
- ✅ Purpur (Purpur API v2, MD5 from the API, SHA-256 recorded): 1.21.11 build 2568 started, `version` confirmed Purpur, LuckPerms installed from Modrinth, `/craftpanel` plugin loaded
- ✅ Fabric (Fabric meta: game versions, loader selection, server launcher; vanilla `server.jar` pre-downloaded with SHA-1): 1.21.11 with loader 0.20.1 started; Fabric API + Lithium installed from Modrinth and loaded after a restart. 🟡 the launcher jar has no published checksum (HTTPS from meta.fabricmc.net only)
- ✅ Log4Shell protection (Mojang guidance: flag for 1.17–1.18.0, patched config for 1.7–1.16.5, config downloaded from Mojang with SHA-1). Verified with a JNDI probe (`say ${jndi:ldap://127.0.0.1:…}` and a local listener): unprotected Vanilla 1.16.5 made 3 connections; protected Vanilla 1.16.5, 1.17.1, 1.8.9, Paper 1.16.5 and Fabric 1.17.1 made none. Own `-Dlog4j…` JVM arguments turn it off
- ✅ Automatic Java provisioning: Java 25 for 26.x and Java 21 for 1.21.x were downloaded side by side and chosen correctly
- 🧪 Java compatibility policy (legacy 8, 16/17, 21+)
- ✅ Software switch in every direction from Settings → Software & version (WSL 2 Ubuntu, real servers): a gold block placed in the Nether of Paper 1.21.11 was still there after Paper → Vanilla → Fabric → Paper (`execute in minecraft:the_nether if block …` → "Test passed"); Paper's `world_nether/DIM-1` and `world_the_end/DIM1` were moved back to `world/` for Vanilla and Paper split them again on the way back. Paper 26.x uses the Vanilla layout (`world/dimensions/minecraft/…`), checked on Vanilla/Paper/Fabric 26.3, so nothing moves there. Build change (#132 → #131) ✅, downgrade refused without confirmation (409) ✅, preview dialog and downgrade confirmation in the browser ✅. 🧪 dimension moves, conflicts and version ordering. Rollback restores the DB metadata on failure; the failure path itself is 🟡

**Performance presets & pre-generation** (WSL 2 Ubuntu, Paper 1.21.11 and Fabric 1.21.11): ✅ created with the low-power preset from the wizard (GC flags next to an own `-Dfile.encoding`, view/simulation distance 6/4 kept by Minecraft), switched to Balanced while running (restart required, detected as active after the restart). ✅ Chunky installed from Modrinth with one click (Fabric: with Fabric API), loaded after a restart; radius 500 generated 4225 chunks to 100 % (Paper 23–46 s, Fabric 93 s on this machine); pause, continue and cancel recognised from Chunky's real console output. ✅ Settings → Performance and the wizard's preset choice in the browser. 🧪 flag replacement (also a conflicting `-XX:+UseZGC`), preset detection, recommendation per machine, Chunky output parsing. 🟡 Speeds on a Raspberry Pi.

**NeoForge** (WSL 2 Ubuntu and Windows 11, Minecraft 1.21.1, NeoForge 21.1.265): ✅ versions from NeoForge's Maven (both numbering schemes, 1.20.2 up to 26.3), installer downloaded with its SHA-256 and run with `--installServer` (34 s on Linux, 70 s on Windows), started through `@…/unix_args.txt` on Linux and `win_args.txt` on Windows, "running" recognised from NeoForge's console format, stopped cleanly. ✅ Chunky installed from Modrinth as a NeoForge mod, listed from its `neoforge.mods.toml`, pre-generation of 1521 chunks to 100 %. ✅ Modrinth search filtered to NeoForge mods; switch preview to Fabric warns that the mods won't load. ✅ NeoForge modpack from Modrinth (Create+ 6.0.0 Alpha f, NeoForge 21.1.233 from the pack): 106 server files in 34 s; the pack wrongly ships a client-only mod as server-side, the start failed with "Mod loading failed: statuseffectbars-1.21.1-NeoForge-1.0.2.jar. It uses client-only code … Disable it on the Mods tab", and after disabling that mod in the mod list the server started. 🧪 version mapping, argument-file launch per OS, `neoforge.mods.toml` parsing, NeoForge log lines (also with a localised date). 🟡 NeoForge on a Raspberry Pi, upgrading NeoForge in place (the installer leaves old libraries behind).
**Hangar** (Windows 11, built release on its own port, Paper 1.21.11): ✅ search (ViaVersion found with Paper 1.21.11 compatibility), versions with releases before snapshots, install of ViaVersion 5.12.1 from hangarcdn.papermc.io with SHA-256 check, update check offered 5.12.2 from Hangar and updated it (old jar replaced), after that no further update offered (Hangar-installed jars are no longer also checked against Modrinth, which had suggested a snapshot); the server started and loaded ViaVersion 5.12.2. ✅ Invalid project/version ids refused, Fabric servers get a clear 409. ✅ Plugins → Browse with the Modrinth/Hangar switch and the install dialog in the browser, no third-party requests. 🧪 project/version mapping, release-first ordering, refusal of external-only downloads, odd file names and missing checksums. 🟡 A real external-only Hangar project (refusal only unit-tested).

**Velocity proxy** (WSL 2 Ubuntu, built release on its own port, Velocity 4.3.1 build 45 with Java 25, two Paper 1.21.4 backends): ✅ created and installed via the API (jar from Fill with SHA-256), proxy directory with `velocity.toml`, `forwarding.secret` and the backend list; worlds, players, properties and game rules answer 409. ✅ Saving two backends marked both "ready", bound them to 127.0.0.1 and wrote them into `velocity.toml` in try order; on the next backend start `config/paper-global.yml` got `proxies.velocity` (enabled, online-mode, secret) while Paper's own defaults and `_version` stayed, and `online-mode=false`. ✅ A mineflayer bot joined through the proxy, landed on the first backend with the forwarded UUID and switched with `/server survival`; a direct join to a backend was kicked with "This server requires you to connect with Velocity". ✅ Reordering while the proxy runs sent `velocity reload` ("successfully reloaded"), and the next bot landed on the new first backend. ✅ The secret is not in the proxy console; removing a backend released it (bind reset, forwarding off, `online-mode=true`). ✅ Proxy tab, settings and the wizard's "Velocity proxy" choice (no World/Gameplay steps, "Requires Java 25") in the browser, no third-party requests. 🧪 `velocity.toml`, `paper-global.yml` and FabricProxy-Lite editors, backend addresses, `velocity-plugin.json` dependencies. 🟡 Fabric backends via FabricProxy-Lite, Velocity plugins installed from Modrinth on a running proxy. ⏳ NeoForge backends (only a note), Velocity plugins from Hangar, player join/leave on the proxy.

**Modpacks** (WSL 2 Ubuntu): ✅ Modrinth search and versions in the wizard; Vanilla Perfected 1.0.0+26.3 prepared in under 1 s, created as Fabric 26.3 with loader 0.19.5 from the pack, 62 server files downloaded and SHA-512-checked in 10 s (46 client-only files skipped), started with 123 mods loaded ("Done" after 11 s). ✅ Uploaded `.mrpack` (vanilla 1.21.11): overrides and server-overrides applied, the pack's `server.properties` kept its MOTD but got the server's own port back, its `eula=false` was replaced, the server started; a used pack can't be created twice. ✅ A Forge pack and a non-zip file are refused with a clear message. ✅ Wizard flow in the browser without third-party requests. 🧪 index validation (loaders, paths, hosts, checksums), override order. 🟡 Packs that download from GitHub/GitLab, very large packs.

**Monitoring**
- ✅ CPU and RAM per process (Windows via a persistent PowerShell probe; Linux `/proc`, macOS `ps` 🟡)
- ✅ Paper TPS/MSPT (20.0 / 0.5 ms observed); vanilla MSPT via `tick query` (1.20.3+), marked unavailable otherwise
- ✅ Uptime, players, storage (directory-size undercount bug found and fixed, regression test added)
- ✅ Metrics sampled only while someone is viewing; internal queries hidden from the console

**Console**: ✅ live streaming, replay, reconnect, command history, search/filter, levels, timestamps, auto-scroll, copy/download, clear view, audit logging.

**Configuration**: ✅ grouped validated editor with restart flags, raw editor, import/export. ✅ Game rules detected per version from Mojang's data generator (59 rules on 26.3), read and set live.

**Players**: ✅ online list, whitelist (live and offline; non-whitelisted player rejected), ops, kick/ban/pardon with reasons (verified with a connected client), IP bans 🟡, session history ✅, Mojang UUID lookup ✅.

**In-game info command**: ✅ `/craftpanel` on Paper via a bundled 2 KB plugin (verified with a player; disabling it in the Plugins tab is remembered), ✅ `/trigger craftpanel` datapack, enabled by default and removable in Settings. Verified with a player on Paper 1.21.11 (colors, click/hover link, sound) and loaded without errors on Vanilla 26.3 (no client for 26.3 available).

**Plugins**: ✅ Modrinth search with compatibility badges and verified install (LuckPerms loaded on Paper 1.21.11), ✅ enable/disable/remove/upload paths 🟡 in UI, 🟡 update check (Modrinth hash API), ✅ executable-code warnings.

**Worlds & files**: ✅ list/select/create/delete (with automatic backup)/export/import, 🧪 sandbox (traversal, junction/symlink escape, binary detection), ✅ file browser/editor/upload/zip extract/download.

**Backups**: ✅ manual, ✅ scheduled (run-now verified), retention 🟡, configurable destination 🟡, ✅ verification, ✅ restore, 🧪 zip-slip/symlink/zip-bomb protection.

**Networking**: ✅ LAN address detection and copyable addresses, ✅ local port diagnostics, 🟡 public IP and CGNAT check, 🟡 DuckDNS updater, ⏳ tunnel providers (interface only), ⏳ UPnP (intentionally not automatic).

**Automation**: ✅ cron schedules with presets and next-run preview, run history, 🧪 de-duplication (one timer per job, unique run slot per minute, no overlap).

**Remote access**: ✅ start profiles (local/lan/proxy/headless), live network access policy (this computer / private networks and VPNs / anywhere + extra CIDRs) verified over the network, lock-out protection 🧪, address overview with LAN/VPN detection. Built-in HTTPS (`CRAFTPANEL_TLS_*`) 🟡 not yet run with a real certificate.

**Security**: 🧪 scrypt hashing, sessions, CSRF, Origin checks (HTTP and WS ✅), RBAC matrix for all four roles, rate limiting, setup token for network-exposed installs, audit log.

**Teams**: ✅ two-factor sign-in in the dashboard (Playwright with real TOTP codes: QR/key, enable, recovery codes, sign-in with code, wrong code rejected; RFC 6238 test vectors and replay/lockout/recovery-code tests 🧪). ✅ required 2FA per role (a viewer was forced to enroll on the next page load). ✅ signed-in devices list. ✅ per-server access: a moderator limited to one server saw only that server and no application settings; API tests cover 404 for other servers, filtered activity/schedules/backups, extra rights on one server and immediate effect of changes 🧪. 🧪 WebSocket broadcasts are filtered per user (unit test).

**Notifications**: ✅ e-mail end to end: configured in the dashboard against a local SMTP server, test message sent, then a real Vanilla 1.8.9 server's Java process was killed and the "Server crashed - v189" mail arrived. 🧪 SMTP login/wrong password against a real SMTP server in tests; Discord embeds (no @mentions), crash-loop de-duplication, categories and once-per-version update notices with a fake webhook. 🟡 Discord against a real webhook (needs a Discord server).

**Release packages and installers**: ✅ `scripts/release.mjs pack` → one `craftpanel-vX.Y.Z.tar.gz` + `SHA256SUMS`; `release.yml` publishes it on a `v*` tag (🟡 until the first tag is pushed). ✅ `deploy/install.sh` on Linux (WSL 2 Ubuntu, systemd): migration from a `install-linux.sh` service install, private Node.js download when none is installed (v24 from nodejs.org, checksum-verified), update in place, automatic rollback of a broken release within ~12 s with the old version running again; settings in `/etc/craftpanel/craftpanel.env` survive updates. ✅ `deploy/install.ps1` on Windows 11 (no admin): scheduled task at sign-in, update while a Paper 1.21.11 server was running (world saved via the local control channel, server back up with "Start with CraftPanel"), rollback of a broken release. 🧪 both installers in CI (install, update, uninstall keeps data). 🟡 Windows ARM64, physical Raspberry Pi, ARMv7, the `curl | sudo bash` path against a published release.

**Updates from the dashboard**: ✅ one-click update on Linux (WSL 2 Ubuntu, systemd, release installed with `install.sh`) and Windows 11 (`install.ps1` into a separate folder, task name and port), each with a local release folder holding a test build v0.1.1: sidebar notice → dialog (running servers and whether they come back) → Update now → progress → automatic reload → "What's new" from the new version's changelog; a running Vanilla server with "Start with CraftPanel" was saved, stopped and running again afterwards; activity shows "Updating…" and "CraftPanel updated from 0.1.0 to 0.1.1". ✅ Rollback: a release that exits at start was installed from the dashboard on both systems; the previous version came back, the dialog said so with the installer output, and "update failed" reached the activity log. 🧪 helper detection (also with a UTF-8 BOM), request file and task start without a shell, release folder, progress steps, results recorded once, changelog sections, transcript filtering. 🧪 GitHub latest-release check (cached 6 h, errors and "no release yet" handled, opt-out by setting and `CRAFTPANEL_UPDATE_CHECK=false`). 🟡 against a real GitHub release (none published yet).

**Deployment**: ✅ single-folder production bundle runs without `node_modules`, ✅ `pnpm dev`, ✅ `deploy/install-linux.sh` and the systemd unit (install and update), ✅ readable service logs, ✅ one-command update (`update.cmd` / `./update.sh`, tested from a diverged old copy on Windows and on a Linux service install), ✅ ARM64 and macOS in CI, 🟡 physical Raspberry Pi.

**Performance** (`node scripts/measure.mjs`, Windows 11, Ryzen AI Max+ 395, Node 26, fresh data directory, no Minecraft server running): startup 331 ms until `/api/health` answers, idle 0.3–0.5% of one core, 92 MB resident, database 205 KB after setup; API latency p50 1–2 ms for every endpoint (`/api/system` was 8.6 ms: `os.networkInterfaces()` takes ~7 ms on Windows and is now cached for 5 s). ✅ Minified API bundle: 4.2 MB → 2.2 MB; A/B over 5 starts each, median startup 444 → 381 ms and 104 → 99 MB resident. ✅ Dashboard served precompressed (brotli/gzip chosen by `Accept-Encoding`, checked with curl): 1175 KB JS → 308 KB transferred; hashed `_next/static` files are `immutable`, HTML is `no-cache`. ✅ Release archive without the source map: 2.2 MB. 🟡 Numbers on a Raspberry Pi and a small VPS.

## Known limitations

- No container or user isolation per server (see [security](security/README.md)).
- Dashboard over plain HTTP unless you add a reverse proxy or set `CRAFTPANEL_TLS_*`.
- Orphaned servers (CraftPanel killed hard) can be stopped but not commanded; on Windows that stop is a hard terminate.
- Game rule detection needs Minecraft 1.13+ and takes up to a minute per version on first use (cached).
- Vanilla before 1.20.3 has no TPS/MSPT; it's shown as unavailable.
- Inbound reachability from the internet cannot be tested without a third-party service; the UI says so.
- Modrinth is the only plugin marketplace; Hangar/Spigot are not integrated.
- Fabric: client-only mods are not filtered beyond Modrinth's `server_side` flag.
- UI is English-only; mobile layouts are responsive by design but were only checked at desktop width.

## Planned

Performance presets for Pi and small VPS, NeoForge provider, Bedrock Dedicated Server adapter, S3-compatible backup storage, tunnel provider integrations, remote runtime agents for multiple hosts, container-based isolation, Hangar integration, i18n (German first).
