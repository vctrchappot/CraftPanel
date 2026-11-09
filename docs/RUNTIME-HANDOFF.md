# Runtime separation handoff (updated 2026-11-09)

**The phase is not complete. Do not merge or release this branch.**

## Git

- Work on `wip/runtime-separation` (16 commits on top of `main` at `ce16c90`; `main` is unchanged).
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
- Legacy migration (Ubuntu) from the old combined process with real world and `server.properties` preservation, refusal without approval and rollback: `test-results/runtime-legacy-20261109/`.
- Real tests found and fixed: root-owned registry restore after runtime rollback; installation marked complete while runtime registration still held the lock; runtime defaulting to `.data` instead of the platform data directory.
- Windows: production deployment smoke and Chromium E2E (real Vanilla lifecycle, maintenance stop-all, the three update-preview states with controlled release metadata) pass. Elevated SCM scenarios pass in CI only (hosted runner): virtual-account identity, independent dashboard-task stop, unsupported archive, failed migrations, hanging startup, runtime update refusal/approval/rollback, SCM crash recovery, recovery retention. The cause of the earlier CI failure (`Failed to start service`, fixed by traversal/Node access grants) was inferred, not read from a service log. The local shell has no administrator token.
- `--deep-data` installer test fails on Windows because of the 260-character path limit; it passes on Linux.

## Remaining acceptance, in order

1. Graceful host reboot with autostart in a disposable VM/WSL environment, Linux and Windows. Never reboot the workstation; a runtime-service restart is not reboot evidence.
2. Windows real-player continuity (Paper + mineflayer) through dashboard restart, forced stop and dashboard-only update with an installed SCM service.
3. Dashboard-triggered update/rollback (not only controlled preview metadata) and concurrent installer runs.
4. Re-investigate if the intermittent disconnect returns: use the diagnostic reason codes, do not just widen poll intervals.
5. Split `3077ef7`, record final evidence in STATUS.md, tick ROADMAP.md, check CI, then merge into `main`.

Out of scope for this phase: reattaching to Java processes after a runtime crash (a live PID is held as orphaned). Follow-on phases: per-server isolation/resources, complete backups and host migration, multiple hosts.
