# Implementation status

Legend: ✅ verified against real Minecraft servers / real services · 🧪 covered by automated tests (unit/integration, fake process) · 🟡 implemented, not yet verified end-to-end · ⏳ planned.

Verification environment so far: **Windows 11 x64, Node 26**. Linux, macOS and Raspberry Pi use the same code paths (no native add-ons, platform-specific process metrics for each OS) but have **not yet been run**.

## Core flow (primary success criterion)

| Step | Status | Evidence |
| --- | --- | --- |
| Install, open dashboard, create owner | ✅ | Playwright e2e (`tests/e2e/full-flow.spec.ts`) |
| Create Vanilla server via wizard | ✅ | e2e; Minecraft 26.3, jar SHA-1 verified, Java 25 downloaded from Adoptium |
| Accept EULA, start | ✅ | e2e; start refused without EULA (🧪 API test) |
| Connect from Minecraft on LAN | 🟡 | Server binds `*:port` and LAN addresses are shown; no game client was available in the test environment |
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
- ✅ Automatic Java provisioning: Java 25 for 26.x and Java 21 for 1.21.x were downloaded side by side and chosen correctly
- 🧪 Java compatibility policy (legacy 8, 16/17, 21+)
- ✅ Vanilla → Paper migration with pre-migration backup and old-jar cleanup. Rollback restores the DB metadata on failure; the failure path itself is 🟡

**Monitoring**
- ✅ CPU and RAM per process (Windows via a persistent PowerShell probe; Linux `/proc`, macOS `ps` 🟡)
- ✅ Paper TPS/MSPT (20.0 / 0.5 ms observed); vanilla MSPT via `tick query` (1.20.3+), marked unavailable otherwise
- ✅ Uptime, players, storage (directory-size undercount bug found and fixed, regression test added)
- ✅ Metrics sampled only while someone is viewing; internal queries hidden from the console

**Console**: ✅ live streaming, replay, reconnect, command history, search/filter, levels, timestamps, auto-scroll, copy/download, clear view, audit logging.

**Configuration**: ✅ grouped validated editor with restart flags, raw editor, import/export. ✅ Game rules detected per version from Mojang's data generator (59 rules on 26.3), read and set live.

**Players**: ✅ online list, whitelist (live and offline), ops, kick/ban with reasons, IP bans 🟡, session history 🧪, Mojang UUID lookup ✅.

**Plugins**: ✅ Modrinth search with compatibility badges and verified install (LuckPerms loaded on Paper 1.21.11), ✅ enable/disable/remove/upload paths 🟡 in UI, 🟡 update check (Modrinth hash API), ✅ executable-code warnings.

**Worlds & files**: ✅ list/select/create/delete (with automatic backup)/export/import, 🧪 sandbox (traversal, junction/symlink escape, binary detection), ✅ file browser/editor/upload/zip extract/download.

**Backups**: ✅ manual, ✅ scheduled (run-now verified), retention 🟡, configurable destination 🟡, ✅ verification, ✅ restore, 🧪 zip-slip/symlink/zip-bomb protection.

**Networking**: ✅ LAN address detection and copyable addresses, ✅ local port diagnostics, 🟡 public IP and CGNAT check, 🟡 DuckDNS updater, ⏳ tunnel providers (interface only), ⏳ UPnP (intentionally not automatic).

**Automation**: ✅ cron schedules with presets and next-run preview, run history, 🧪 de-duplication (one timer per job, unique run slot per minute, no overlap).

**Security**: 🧪 scrypt hashing, sessions, CSRF, Origin checks (HTTP and WS ✅), RBAC matrix for all four roles, rate limiting, setup token for network-exposed installs, audit log.

**Deployment**: ✅ single-folder production bundle runs without `node_modules`, ✅ `pnpm dev`, 🟡 `deploy/install-linux.sh` and the systemd unit (not executed), 🟡 macOS.

## Known limitations

- No container or user isolation per server (see [security](security/README.md)).
- Dashboard over plain HTTP unless you add a reverse proxy; no 2FA.
- Orphaned servers (CraftPanel killed hard) can be stopped but not commanded; on Windows that stop is a hard terminate.
- Game rule detection needs Minecraft 1.13+ and takes up to a minute per version on first use (cached).
- Vanilla before 1.20.3 has no TPS/MSPT; it's shown as unavailable.
- Inbound reachability from the internet cannot be tested without a third-party service; the UI says so.
- Modrinth is the only plugin marketplace; Hangar/Spigot are not integrated.
- UI is English-only; mobile layouts are responsive by design but were only checked at desktop width.

## Planned

Fabric and NeoForge providers (mods via Modrinth), Bedrock Dedicated Server adapter, S3-compatible backup storage, tunnel provider integrations, remote runtime agents for multiple hosts, container-based isolation, 2FA, Hangar integration, i18n (German first).
