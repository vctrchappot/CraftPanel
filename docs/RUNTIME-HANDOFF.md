# Runtime separation handoff (updated 2026-11-09)

**The phase is not complete. Do not merge or release this branch.**

## Git

- Work on `wip/runtime-separation` (on top of `main` at `ce16c90`; `main` is unchanged).
- Last CI run with all jobs green: [42587950885](https://github.com/vctrchappot/CraftPanel/actions/runs/42587950885) on `192ceb4`. Later commits only change documentation.
- `3077ef7` is still a combined `WIP:` commit (installer, updates, maintenance action, Windows service). Split it into reviewed logical commits before merging; do not rewrite the other, already descriptive commits.
- The earlier feature worktrees and branches (`feat/runtime-*`, `test/runtime-reconnect`, `feat/database-recovery-helper`, `docs/professional-deployment`, `test/deployment-package`) were removed. Their content is in this branch; their uncommitted early drafts are archived as patches in `../CraftPanel-worktrees/_archive-20261109/`.
- Commit attribution follows `CLAUDE.md` and the active agent's environment.

## What is implemented

- `RuntimeAgent` uses asynchronous mutation acknowledgements; `RuntimeService` (process owner, no TCP port) holds children, stdin, state, players, metrics and bounded console history (2,000 lines / 512 KiB). Protocol and recovery boundary: [architecture/runtime.md](architecture/runtime.md).
- IPC: private Unix socket (validated short alias for long paths) or Windows named pipe with a random private token. Handshake checks the protocol version; commands carry epoch, session, strict sequence and dispatch deadline. No replay or retry after a lost connection; lost acknowledgements are reported as uncertain. Transport/persistence failures report bounded reason codes without payloads or secrets.
- The dashboard uses `RuntimeClient`, reconnects from snapshots and fails closed while disconnected. Shutting down the dashboard does not stop games. A dropped connection restores save-on if it had paused saves for a backup.
- `runtime/servers.json` stores launch specifications and auto-start policy independently of SQLite.
- Installers fingerprint runtime code and service wrappers. Dashboard-only updates leave the runtime untouched; runtime changes require an explicit, expiring approval for the target fingerprint (`--allow-runtime-restart` on Linux, maintenance action and interruption preview in the dashboard). The recovery helper snapshots and restores the runtime registry with original ownership.
- Linux: separate `craftpanel-runtime.service`. Windows: `CraftPanel Runtime` SCM service under a virtual account (wrapper compiled from `deploy/windows-runtime-service.cs` with the .NET Framework `csc.exe`, preshutdown handling), independent of the dashboard's per-user scheduled task. Path preparation probes storage and Java paths under the service identity and grants access only where needed.

## Evidence

- Windows typecheck and full suite: 261 passed, 4 Unix-specific skipped. The intermittent disconnect seen once under a concurrent typecheck did not reproduce in twelve complete runs; its cause is unproven.
- Ubuntu/systemd (WSL distro `craftpanel-test`, Node 24.22.2), `scripts/real-tests/runtime-continuity.mjs` with real Paper 1.21.4 and a mineflayer player: dashboard restart, forced crash/recovery, dashboard-only update, failed migration and invalid-unit rollback keep the same Java/runtime PIDs and player connection; commands and console replay work afterwards. Missing, expired and wrong-runtime approvals leave the player connected. A failed changed-runtime migration rolls back; an approved runtime update and a graceful runtime-service restart preserve a world sentinel and restore auto-start. Evidence (ignored): `test-results/runtime-verified-20261109/`.
- Host shutdown/boot (Ubuntu, disposable WSL clone of `craftpanel-test`, `scripts/real-tests/host-reboot.mjs`): `systemctl poweroff` stopped the runtime in 1.5 s without SIGKILL; both Paper servers logged a graceful stop and world save; after boot only the auto-start server ran (new Java PID), the manual one stayed stopped, a player joined, and a block placed without explicit save survived (no autosave had run yet). Systemd-level shutdown/boot of the distro, not a kernel/firmware reboot. Evidence (ignored): `test-results/host-reboot-20261109/`. Lesson: in WSL `journalctl -b -1` does not separate distro boots (journal boot IDs follow the shared kernel).
- Legacy migration (Ubuntu) from the old combined process with real world and `server.properties` preservation, refusal without approval and rollback: `test-results/runtime-legacy-20261109/`.
- Real tests found and fixed: root-owned registry restore after runtime rollback; installation marked complete while runtime registration still held the lock; runtime defaulting to `.data` instead of the platform data directory.
- Windows: production deployment smoke and Chromium E2E (real Vanilla lifecycle, maintenance stop-all, the three update-preview states with controlled release metadata) pass. Elevated SCM scenarios pass in CI only (hosted runner): virtual-account identity, independent dashboard-task stop, unsupported archive, failed migrations, hanging startup, runtime update refusal/approval/rollback, SCM crash recovery, recovery retention. The cause of the earlier CI failure (`Failed to start service`, fixed by traversal/Node access grants) was inferred, not read from a service log. The local shell has no administrator token.
- Windows real-player continuity, in CI only (run [42597968685](https://github.com/vctrchappot/CraftPanel/actions/runs/42597968685), head `a5994b0`, `scripts/real-tests/runtime-continuity-windows.mjs`): Paper 1.21.4 + mineflayer kept the same Java/service PIDs and player through dashboard task restart, forced dashboard kill, dashboard-only update and failed-migration rollback; console replay works. `Stop-Service` (same wrapper path as preshutdown) exits 0 after Minecraft saved an unsaved block; `Start-Service` restores the auto-start server and world. The first run found a real defect: Paperclip's `toRealPath` needs list access to every ancestor, and the service account only had traversal on `%LOCALAPPDATA%`'s parents, so Paper could never start in a default Windows install. Fixed in `a5994b0` (non-inherited `RD` grant, and the service path probe now checks ancestor listing).
- `--deep-data` installer test fails on Windows because of the 260-character path limit; it passes on Linux.

## Remaining acceptance, in order

1. Windows graceful host shutdown/boot with autostart on a real or disposable virtual machine (Linux is done; CI covers the shared stop path but cannot send preshutdown or reboot). Never reboot the workstation.
2. Dashboard-triggered update/rollback (not only controlled preview metadata) and concurrent installer runs.
3. Re-investigate if the intermittent disconnect returns: use the diagnostic reason codes, do not just widen poll intervals.
4. Split `3077ef7`, record final evidence in STATUS.md, tick ROADMAP.md, check CI, then merge into `main`.

Out of scope for this phase: reattaching to Java processes after a runtime crash (a live PID is held as orphaned). Follow-on phases: per-server isolation/resources, complete backups and host migration, multiple hosts.
