# Implementation status

Legend: ✅ verified against real Minecraft servers / real services · 🧪 covered by automated tests (unit/integration, fake process) · 🟡 implemented, not yet verified end-to-end · ⏳ planned.

Verification environments so far: **Windows 11 x64, Node 26** and **Linux x64 (Ubuntu 24.04 under WSL 2 with systemd), Node 24**. **GitHub Actions CI** runs on every push: typecheck, unit/integration tests and a production build on Linux, Windows and macOS; the full browser flow with a real Minecraft server on Linux **x64 and ARM64** (the same architecture as a Raspberry Pi 4/5); and the Linux installer with its update path on a systemd host. A physical Raspberry Pi and a manual macOS run are still pending.

Linux run (WSL 2): `deploy/install-linux.sh` + systemd service, update by re-running the installer (graceful world save on restart), Paper 1.21.11 and Vanilla 26.3 with automatically downloaded Linux Java 21/25, a real player connection from another machine (mineflayer bot via the network), kick/ban/pardon/whitelist, the in-game info command, the remote-access policy over the network, and the dashboard in a browser (console auto-scroll, dark-mode dropdowns).

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
- ✅ Vanilla → Paper migration with pre-migration backup and old-jar cleanup (✅ also Vanilla 1.17.1 → Fabric via the API; `server.jar` is kept for the launcher). Rollback restores the DB metadata on failure; the failure path itself is 🟡

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

**Release packages and installers**: ✅ `scripts/release.mjs pack` → one `craftpanel-vX.Y.Z.tar.gz` + `SHA256SUMS`; `release.yml` publishes it on a `v*` tag (🟡 until the first tag is pushed). ✅ `deploy/install.sh` on Linux (WSL 2 Ubuntu, systemd): migration from a `install-linux.sh` service install, private Node.js download when none is installed (v24 from nodejs.org, checksum-verified), update in place, automatic rollback of a broken release within ~12 s with the old version running again; settings in `/etc/craftpanel/craftpanel.env` survive updates. ✅ `deploy/install.ps1` on Windows 11 (no admin): scheduled task at sign-in, update while a Paper 1.21.11 server was running (world saved via the local control channel, server back up with "Start with CraftPanel"), rollback of a broken release. 🧪 both installers in CI (install, update, uninstall keeps data). 🟡 Windows ARM64, physical Raspberry Pi, ARMv7, the `curl | sudo bash` path against a published release.

**Update notice**: 🧪 GitHub latest-release check (cached 6 h, errors and "no release yet" handled, opt-out by setting and `CRAFTPANEL_UPDATE_CHECK=false`), admin-only API, install-method detection for the update command; ✅ Settings → Security & about renders it in the browser. 🟡 the sidebar notice for an actual newer release.

**Deployment**: ✅ single-folder production bundle runs without `node_modules`, ✅ `pnpm dev`, ✅ `deploy/install-linux.sh` and the systemd unit (install and update), ✅ readable service logs, ✅ one-command update (`update.cmd` / `./update.sh`, tested from a diverged old copy on Windows and on a Linux service install), ✅ ARM64 and macOS in CI, 🟡 physical Raspberry Pi.

## Known limitations

- No container or user isolation per server (see [security](security/README.md)).
- Dashboard over plain HTTP unless you add a reverse proxy; no 2FA.
- Orphaned servers (CraftPanel killed hard) can be stopped but not commanded; on Windows that stop is a hard terminate.
- Game rule detection needs Minecraft 1.13+ and takes up to a minute per version on first use (cached).
- Vanilla before 1.20.3 has no TPS/MSPT; it's shown as unavailable.
- Inbound reachability from the internet cannot be tested without a third-party service; the UI says so.
- Modrinth is the only plugin marketplace; Hangar/Spigot are not integrated.
- Fabric: the dashboard only offers the Vanilla→Paper migration; other switches (e.g. to Fabric or Purpur) are API-only so far. Client-only mods are not filtered beyond Modrinth's `server_side` flag.
- UI is English-only; mobile layouts are responsive by design but were only checked at desktop width.

## Planned

Two-factor sign-in and per-server permissions for teams, NeoForge provider, Bedrock Dedicated Server adapter, S3-compatible backup storage, tunnel provider integrations, remote runtime agents for multiple hosts, container-based isolation, Hangar integration, i18n (German first).
