# Runtime separation handoff (updated 2026-11-09)

**The phase is not complete. Do not merge or release this branch.** The continuation below supersedes the old next-step list; earlier evidence is retained for context.

## Continuation (2026-11-09)

- Continue on `wip/runtime-separation`; main remains unchanged. New logical commits follow the earlier imperative English titles, explanatory bodies and Codex attribution: `44452dc` runtime recovery/path access, `8b2f9a5` safe registry rollback, `b43f616` installed-service/player acceptance.
- Windows typecheck and full unit/integration suite passed: **260 passed, 3 Unix-specific skipped**. The original disconnect did not reproduce in twelve complete suite runs; its original cause is still unproven. Transport/persistence failures now report bounded reason/error codes without payloads, tokens or raw exception messages. IPC-loss coverage checks rejection without replay, reconnection and autosave restoration.
- Real tests found/fixed two defects: root-owned registry restoration after a changed-runtime rollback, and installation marked complete while runtime registration still held the install lock. Registry snapshot/restore now uses the standalone recovery helper, preserves original ownership/checksum and atomically replaces files without following links. Active installations survive an IPC reconnect.
- The Windows path-preparation helper asks the service to probe chosen storage/Java paths under its real identity, grants access only when needed and probes again. The installer records its virtual service account, waits for wrapper exit before replacement and leaves an unchanged executable alone during dashboard rollback. **Local elevated SCM execution remains unavailable; no administrator token.** Extended Windows service/update/recovery checks are in CI.
- Production deployment smoke passed on Windows, including a regression proving that runtime and dashboard share their platform default data directory without an explicit override. The runtime previously defaulted to `.data` while the dashboard used the platform directory.
- Windows Chromium E2E passed the real Vanilla lifecycle plus the maintenance stop-all action and all three update-preview states. Release metadata is controlled for preview checks; an actual UI-triggered installer transaction is not covered. One later attempt failed because GitHub returned HTTP 504 for Java; the successful expanded run reused the JDK provisioned by the earlier successful real-server E2E.
- `scripts/real-tests/runtime-continuity.mjs` passed on isolated Ubuntu/systemd (`craftpanel-test`, Node 24.22.2), with actual Paper 1.21.4 and mineflayer: dashboard restart, forced dashboard crash/recovery, successful dashboard-only update, failed schema migration and invalid-unit rollback retained the same Java/runtime PIDs and connected player. Commands and console replay remained usable. Missing, expired and wrong-runtime approvals left the player connected. Failed changed-runtime migration rolled back; an approved runtime update and a graceful runtime-service restart preserved a gold-block world sentinel and restored auto-start.
- Latest successful fixture/evidence: ignored `test-results/runtime-verified-20261109/runtime-continuity-evidence.json` (`ok: true`), with installer logs beside it. `test-results/runtime-legacy-20261109/runtime-continuity-evidence.json` (`ok: true`) proves legacy migration with real world sentinel and server.properties preservation, refusal without maintenance approval and rollback. Older failing fixture sets retain diagnoses. Services are uninstalled by the harness; temporary data remains for diagnosis. The original service PID is checked within each run. Do not reuse instance names/data or mistake a service restart for a host reboot.
- Playwright output now lives under `test-results/playwright`. Its old default cleared the whole `test-results` directory and deleted a concurrently generated fixture set; that fixture generation and acceptance attempt were repeated.
- CI was dispatched against `0fe5377`: [run 42583393310](https://github.com/vctrchappot/CraftPanel/actions/runs/42583393310). Windows installer failed because the virtual service account lacked traversal permissions across the user profile and execution access on external Node. Fixed by granting traversal on profile ancestors and RX on external Node.

Remaining acceptance: actual host reboot/autostart in a disposable environment, Windows real-player continuity and elevated service results in CI, actual dashboard-triggered rollback/concurrent installer scenarios, and investigation if the intermittent disconnect returns. The workstation must not be rebooted for testing. Documentation is aligned with the separate runtime; keep the phase incomplete until its remaining acceptance is satisfied.

## Git

- Resume on `wip/runtime-separation`; `main` remains at `ce16c90`.
- Three reviewed foundation commits precede the WIP installer/update commit:
  - `b0f700c` Make Minecraft process control asynchronous.
  - `79fe787` Add a standalone Minecraft runtime with protected local IPC.
  - `f66d120` Reconnect the dashboard to running Minecraft servers.
- Those three originally had poor messages/missing attribution; only these unpublished commits were recreated with identical trees, descriptive bodies and the Codex co-author trailer. Do not rewrite other agents' commits.
- Keep commit titles consistent with the existing plain-English history, describe behavior and validation, and include `Co-Authored-By: Codex <noreply@openai.com>`. Split the WIP changes into reviewed logical commits before merging.
- Other pre-existing worktrees include runtime-ipc/runtime-services/runtime-tests branches. They were not used or modified in this turn. Inspect before reusing; do not assume they are active agents.

## Implemented foundation

- `RuntimeAgent` uses asynchronous mutation acknowledgements. API consumers await acceptance.
- `RuntimeService` owns children/stdin/state/players/metrics/history without a TCP port. Unix socket is private; Windows pipe authenticates using a random private token.
- Handshake enforces protocol version. Commands carry epoch, per-connection session, strict sequence and dispatch deadline. No reconnect command queue/retry; lost acknowledgements are uncertain results.
- Console history is capped at 2,000 lines/512 KiB in the runtime. Snapshots and subscriptions restore control after replacing the dashboard connection.
- Production API uses `RuntimeClient`; API shutdown disconnects without stopping games. Tests can inject `LocalAgent`. Disconnection shows unknown state and liveness-dependent mutations fail closed.
- Runtime registry stores launch/auto-start policy independently of SQLite. Latest source also registers a never-started installed server and updates its next-boot launch specification.
- A dropped connection restores save-on when it had paused saves for a live backup.

## WIP in the final commit

- Runtime identity/manifest fingerprints include the bundle plus host-wrapper/service sources; dashboard-only releases compare equal. API maintenance/update preview binds interruption approval to the exact target runtime hash and expires it.
- Dashboard maintenance action and runtime interruption preview reuse existing UI components. Browser QA remains pending.
- Linux installer provisions `craftpanel-runtime.service` separately from the dashboard, preserves an unchanged runtime during dashboard updates/rollback, requires `--allow-runtime-restart` for changed-runtime/legacy migration maintenance, and saves/restores runtime registry for runtime updates.
- Windows installer WIP provisions a virtual-account SCM service, compiled from `deploy/windows-runtime-service.cs` plus the existing job owner. It accepts preshutdown/stop, invokes the protected runtime shutdown CLI and runs independently of the dashboard's per-user scheduled task. Initial service registration needs an elevated install by the same Windows user. **Not service-tested yet.**
- Release packaging, development launcher, deployment/installer fixtures and Playwright launcher were adapted to start a runtime.

## Evidence and exact limits

- Final source `pnpm typecheck`: passed.
- Earlier full `pnpm test`: 253 passed, 2 skipped.
- Final full suite run **concurrently with typecheck**: 252 passed, 2 skipped, 1 failure. `service.test.ts` continuity test observed `unknown` instead of `running` inside the default poll interval. A subsequent isolated run passed all 7 runtime tests. **Treat this as an unresolved intermittent disconnect; do not claim the final suite is clean. Investigate/log the disconnect cause before merge.** Last source change before that run enabled cross-account Windows pipe access (readableAll/writableAll), still protected by the private token.
- Full `pnpm build` passed before the latest registry/configure and cross-account pipe additions. An API-only rebuild later passed and `node scripts/real-tests/deployment.mjs` passed HTTPS proxy, rewritten Host, auth/WebSocket, built-in TLS, readiness and doctor checks with the independent runtime. **Rebuild the final source before reusing packages.**
- The packaged runtime initially failed because bundled CommonJS dependencies needed createRequire. Fixed by adding the same esbuild banner used by the API; production deployment smoke then passed.
- Windows host C# compiled successfully with the Windows .NET Framework compiler. PowerShell 7 Add-Type cannot emit an EXE; installer now invokes Framework csc.exe with absolute paths. Syntax check passed before that small compiler replacement. Actual SCM install/start/stop/recovery has not been verified. Current shell has no Windows administrator token.
- Ubuntu/systemd recovery harness passed in WSL distro `craftpanel-test` (root, Node 24.22.2), isolated instance `craftpanel-ops-runtime`, port 19686: initial install, specific-interface proxy probes, unsupported archive rejection, failed migration rollback, invalid dashboard unit rollback, hanging startup/descendant cleanup, later successful reinstalls and recovery retention. Harness cleaned up its test services/user/data and confirmed the original craftpanel service PID was unchanged.
- Linux fixture set `test-results/runtime-linux-r2` was built **before the latest configure/pipe additions** and contains **no real Minecraft server or connected player**. This is installer regression evidence, not player continuity or final-build acceptance. Older diagnostic fixtures also exist in test-results. They are ignored/untracked artifacts, not the deliverable.
- No actual host reboot, real-player continuity test, legacy migration with worlds, changed-runtime rollback, elevated Windows service test or final browser QA has run. No existing real CraftPanel/Minecraft instance was intentionally changed.

## Next steps, in order

1. Investigate the intermittent runtime disconnect under the complete suite. Add bounded diagnostic detail on transport/service persistence errors; do not just increase polling until it passes. Re-run typecheck, tests, final build.
2. Review Windows service registration/virtual-account file and pipe permissions before elevated testing. Existing installer test can run under a one-time elevated shell with isolated paths/tasks. Extend its cleanup to handle a partially installed runtime service. Check custom server directories created after installation, custom Java paths, service-host file locks on replacement, update/recovery access as a non-elevated dashboard owner, and restore/remove service configuration on rollback. Do not test by rebooting the user's workstation.
3. Rebuild isolated fixtures from final source and extend acceptance harness to hold a real Paper server plus mineflayer player through dashboard restart, SIGKILL/Windows forced dashboard stop, successful dashboard-only update, failed dashboard update and reconnection. Assert the same Java PID/player connection, console replay and working commands. Use free ports and throwaway data.
4. Exercise actual IPC loss/reconnect with pending commands; assert no late/duplicate controls. Add changed-runtime approval/stale approval/rollback and legacy installation migration with world/config hashes.
5. Prove graceful host shutdown/autostart in a disposable VM/WSL environment, including Windows parity. Runtime crash reattachment itself is outside the dashboard-crash guarantee; a live Java PID left by a runtime crash is held orphaned.
6. Review the new Playwright multi-process launcher and update remaining deployment/architecture instructions (architecture README still describes one process). Add exact evidence to STATUS and tick ROADMAP only after verification. Then split/review WIP, push checked commits, check CI and merge only a completed phase.

See the original user requirements and `docs/ROADMAP.md` for all six acceptance scenarios and follow-on phases (isolation/resources, full backup/host migration, multiple hosts).
