# Real-server test scenarios

Scripts that drive a throwaway CraftPanel instance through its HTTP API against real Minecraft downloads and servers. They complement `pnpm test` (no network) and `pnpm test:e2e` (Playwright). STATUS.md entries marked ✅ were verified with scenarios like these.

```bash
pnpm build
scripts/real-tests/run.sh <api-port> <data-dir> <scenario.mjs> [args…]
```

Linux scenarios that need root, systemd or an installed service run in a throwaway WSL distro (from Windows):

```bash
node scripts/real-tests/wsl-sandbox.mjs [--keep] -- "cd /mnt/c/…/CraftPanel && node scripts/real-tests/limits.mjs test-results/limits craftpanel-ops-lim 19687"
```

It imports a fresh Ubuntu 24.04 (systemd, Node 22, root) from a cached base image, runs the command in one `wsl` call and unregisters the distro afterwards (`--keep` leaves it for a look).

Windows scenarios that need administrator rights (service installs, ACLs, firewall, network isolation) run in Windows Sandbox (enable the optional feature `Containers-DisposableClientVM` once, as administrator, and reboot):

```powershell
node scripts/real-tests/windows-sandbox.mjs [--offline] [--keep] [--timeout 30] [--map <dir>]... --script scenario.ps1
node scripts/real-tests/windows-sandbox.mjs -- "bash scripts/real-tests/run.sh 19690 C:/cp-test perf.mjs; exit `$LASTEXITCODE"
```

The PowerShell command runs as the sandbox's administrator in the checkout, with Node and Git Bash on `PATH`; the checkout, Node, Git and every `--map` folder are mapped read-only at their host paths, and `$env:SANDBOX_OUT` is the only writable host folder. End the script with an explicit `exit <code>`: that code becomes the runner's. On a timeout or Ctrl+C the runner asks the sandbox to stop the command and shut down (closing the window alone leaves the VM running), then deletes its folder. One sandbox runs at a time.

`run.sh` copies `apps/api/dist`, starts it on `127.0.0.1:<api-port>` with its own data dir, runs the scenario and stops the API (servers are stopped gracefully). The first sign-in creates a throwaway owner account (`client.mjs`, overridable with `CP_USER`/`CP_PASSWORD`). Use local test instances only.

| Scenario | Args | What it checks |
|---|---|---|
| `live-map.mjs` | `[mcVersion] [mcPort] [--browser]` | Activate BlueMap on Paper, automatic setup/start and delayed page visibility, real protected viewer/assets, 2D settings, hidden dimensions and players, pause/resume, public password access. Optional Chromium check starts the actual WebGL viewer. `CP_MAP_SERVER` reuses a throwaway server fixture. |
| `assistant.mjs` | `[mcPort] [modelPort]` | AI assistant on Paper with a scripted OpenAI-compatible model on localhost: status read without approval, an approved `list` returns the real console answer, an approved whitelist change, a declined ban, audit entries as "owner (AI assistant)". `KEEP_OPEN=<file>` keeps the instance up for a browser look. |
| `software-switch.mjs` | – | A block placed in Paper's Nether survives Paper → Vanilla → Fabric → Paper; downgrade guard. |
| `info-card.mjs` | `<phase> <state-file> <tools-dir> [mcVersion] [mcPort]` | `/craftpanel` card with a real player (mineflayer): current version and software, read from the running game; two phases around a dashboard-only restart. |
| `host-fit.mjs` | `[mcVersion] [mcPort]` | Host detection (board, usable memory, cores) in `/api/system` and the hardware fit of a server plan against this machine. |
| `player-profile.mjs` | `<tools-dir> [mcVersion] [mcPort] [software]` | Player profile with a mineflayer bot: statistics, advancements, inventory with enchantments, armor, XP, position and last death read from the world folder; sessions, heatmap, kick in the player's activity, roster; unknown and path-like names refused. Run on Paper 1.21.4 and Vanilla 26.1. |
| `player-actions.mjs` | `<tools-dir> [mcVersion] [mcPort] [software]` | The player Actions API with two mineflayer bots on Paper 1.21.4: the inspect endpoint (live flags, tags, effects, saved-file fallback) and every action read back from the running game (heal, game mode, items, XP, teleports into other dimensions and to a player, private and fake-operator messages, title, effect, launch, lightning, clear inventory, kill); what the game refuses comes back as a 422 with its own words; injected line breaks, extra command words and out-of-range values are refused; offline players are a 409. |
| `appearance.mjs` | `<tools-dir> [mcVersion] [mcPort] [software]` | Server icon and two-line message of the day: sets both through the API, restarts a real server and checks, with a server list ping like the game's, that it announces a 64×64 PNG icon and both lines with colour and bold; removing the icon removes it from the announcement. |
| `motd-rotation.mjs` | `<tools-dir> [mcVersion] [mcPort] [software]` | Rotating server list messages: sets two messages through the API, starts a real Paper server and pings it every 0.7 s to check that both are announced in turn (with a smooth colour), that an edit shows without a restart and that removing them brings back the `server.properties` message. |
| `performance.mjs` | `[software] [mcVersion] [mcPort]` | Wizard preset applied (JVM flags, distances), preset switch, Chunky install and pre-generation with pause/continue/cancel. |
| `world-transfer.mjs` | `[mcVersion] [mcPort]` | World export while running, import as a new active world with Nether and End, boot from it; taken names and archives without or with several worlds refused cleanly; a world in a wrapper folder. |
| `performance-tab.mjs` | `[mcVersion] [mcPort]` | The Performance tab's data: metric history from live sampling (equal to the stream), a fresh series after restart, memory/JVM and performance properties saved, bad distance refused. `KEEP_RUNNING=1` leaves the server up for a browser check. |
| `neoforge.mjs` | `<mcVersion> <mcPort>` | NeoForge catalogue, install, start, Chunky as a NeoForge mod, mod list from `neoforge.mods.toml`, pre-generation, switch preview. |
| `neoforge-update.mjs` | `[mcVersion] [mcPort]` | In-place NeoForge update from the second-newest to the newest build: old version folder removed, shared libraries kept, server starts. |
| `modpack.mjs` | `search <query>` or `run <modrinthProjectId> <mcPort> [versionId]` | Modrinth modpack search; prepare, create, install, start, mods loaded. |
| `modpack-upload.mjs` | `<mcPort>` | `.mrpack` upload: overrides vs. the server's port/EULA, Forge pack and junk refused, a used pack can't be reused. Needs `python3`. |
| `modpack-fix-crash.mjs` | – | After `modpack.mjs run` with a pack that crashes (`KEEP_DATA=1`): the crash names the mod, disabling it via the mod list lets the server start. |
| `velocity.mjs` | `[proxyPort] [paperVersion]` | Velocity proxy with a Paper backend: wiring, forwarding ready, secret not in the console; with `mineflayer` in the working directory a bot joins through the proxy and a direct join to the backend is refused. |

## Deployment package smoke test

`deployment.mjs` tests the built package using real HTTP, HTTPS and WebSocket connections, without downloading or running Minecraft. It starts only temporary instances on free loopback ports and leaves existing services untouched.

```bash
pnpm build
node scripts/real-tests/deployment.mjs
# Optional: inspect the Remote access page in installed Playwright Chromium and save a screenshot.
node scripts/real-tests/deployment.mjs --browser
# A separate checkout or worktree can test another checkout's production artifact:
node scripts/real-tests/deployment.mjs --dist /path/to/CraftPanel/apps/api/dist
```

OpenSSL must be available (`openssl` on Linux/macOS; Git for Windows' `C:/Program Files/Git/usr/bin/openssl.exe` by default on Windows). Set `OPENSSL` to override its executable. A temporary self-signed localhost certificate is generated for each run; TLS verification is disabled only inside this isolated test harness. The optional browser check requires an already-installed Playwright Chromium; it does not install or download a browser.

The test checks setup-token enforcement, Secure cookies, a reverse proxy that rewrites `Host`, public-client access rules, a real authenticated WebSocket upgrade and foreign-origin rejection, built-in TLS, local readiness, `doctor --json`, and rejection of an HTTP browser connection even when the proxy uses TLS to the backend. Instances are stopped through their local control tokens and their temporary data and certificates are removed. With `--browser`, the screenshot remains at `test-results/screens/deployment-proxy.png`.

## Per-server accounts (Linux)

`isolation.mjs` installs a release fixture as an isolated service (root, systemd, a `craftpanel-ops-*` instance with four game accounts), creates two Paper 1.21.4 servers and checks that they run under separate game accounts without capabilities, that a game account cannot read the database, tokens, backups or the other server, that the dashboard still reads, writes, backs up, downloads and exports, that leftover processes die with their server, and that a restored server and a runtime restart keep the accounts. It uninstalls the instance and removes its accounts afterwards; an existing `craftpanel` service is left alone.

```bash
pnpm build
node scripts/real-tests/installer-fixtures.mjs test-results/isolation craftpanel-ops-iso   # on Windows from PowerShell (Windows tar)
sudo node scripts/real-tests/isolation.mjs test-results/isolation craftpanel-ops-iso 19686 [JAVA_PATH]
```

`limits.mjs` (same fixtures with `craftpanel-ops-lim`, port 19687) checks per-server resource limits on such an install: the server's cgroup and its memory, swap, CPU and process limits, CPU throttling under chunk generation, live changes without a restart, refusal of a cap below the heap, an out-of-memory stop (injected by squeezing the cgroup as root) reported as "Memory limit reached", and cleanup after stop.

`limits-windows.mjs` (Windows, `run.sh <port> <data-dir> limits-windows.mjs` from Git Bash after `pnpm build`) checks the job object limits with a real Paper server: Java in a job held by the helper, a live CPU cap and its removal measured from Java's CPU time, refusal of a cap below the heap, a live memory cap below what Java has committed reported in the console and as "Memory limit reached", and the helper ending with the server.

## Installer recovery tests

After `pnpm build`, generate controlled release archives. The fixtures deliberately change the SQLite schema and then crash or hang; another has an invalid systemd unit/Windows launcher and one lacks the recovery protocol.

Linux (root, systemd; a separately named temporary service, user and data directory):

```bash
node scripts/real-tests/installer-fixtures.mjs test-results/installer-recovery craftpanel-ops-test
sudo bash scripts/real-tests/installer-linux.sh test-results/installer-recovery craftpanel-ops-test 19685
```

Windows (temporary per-user tasks, separate app/data directories and a free port):

```powershell
node scripts/real-tests/installer-fixtures.mjs test-results/installer-recovery
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/real-tests/installer-windows.ps1 -Fixtures test-results/installer-recovery
```

Use a new fixture directory per run. Existing normal CraftPanel instances are not changed. Windows service tests require an elevated shell under the dashboard owner's account. Tests cover unsupported archives, failed migrations, hanging startup and descendants, subsequent updates and snapshot retention. Linux also checks a specific-interface proxy listener and an invalid unit. Windows checks an invalid dashboard entry point, SCM identity/recovery and changed-runtime rollback. Failed Windows test artifacts are retained for diagnosis.

## Installed runtime/player continuity (Linux)

Generate fixtures with a fresh isolated name, then run as root on a disposable systemd test host with mineflayer already installed in a separate tools directory:

```bash
node scripts/real-tests/installer-fixtures.mjs test-results/runtime-acceptance craftpanel-ops-runtime-test
sudo node scripts/real-tests/runtime-continuity.mjs test-results/runtime-acceptance craftpanel-ops-runtime-test 19689 /path/to/test-tools [/path/to/java]
```

The optional Java executable is copied into this instance's data directory; the original installation is read-only. The harness installs real Paper 1.21.4, holds a real offline player through dashboard restart/crash, successful dashboard update and migration/unit rollback, and checks unchanged PIDs, player connection, console replay and working commands. It also checks missing/expired/mismatched runtime approvals, changed-runtime rollback and successful maintenance update using a gold block in the real world, and graceful runtime-service restart with auto-start. That final scenario is not an actual host reboot. JSON evidence and installer logs remain in the fixture directory. Services are uninstalled even on failure; data is retained for diagnosis. Fixture names and ports must be unused. Playwright output is confined to `test-results/playwright` so it cannot delete these archives.

## Dashboard-triggered updates and concurrent installers (Linux)

```bash
node scripts/real-tests/installer-fixtures.mjs test-results/dashboard-update craftpanel-ops-dash-test
sudo node scripts/real-tests/dashboard-update.mjs test-results/dashboard-update craftpanel-ops-dash-test 19697
```

The scenario installs an isolated instance and points its settings file at a local release folder (`CRAFTPANEL_RELEASE_DIR`). It then updates through the dashboard API as "Update now" does, and the systemd path unit runs the installer. Checks:
- A release with a failing migration rolls back. The dashboard shows the result and log after its restart, and the runtime is not restarted.
- A runtime-changing release is refused without approval and installs with the exact approval.
- Of two installers started at the same time, one is refused by the install lock.

The instance is uninstalled afterwards. Fixture archives keep the real `craftpanel-vX.Y.Z` names, because the dashboard reads `craftpanel-vX.Y.Z/release.json` from them. Only service, user and path names are isolated.

## Installed runtime/player continuity (Windows)

Run in an elevated shell under the account that will own the dashboard, on a disposable machine (CI uses the hosted Windows runner):

```powershell
node scripts/real-tests/installer-fixtures.mjs test-results/installer-recovery
npm install --prefix C:\path\to\test-tools mineflayer@4.39.0
node scripts/real-tests/runtime-continuity-windows.mjs test-results/installer-recovery C:\path\to\test-tools
```

It installs into a temporary directory with its own scheduled task, SCM service and ports. A real Paper 1.21.4 server and offline player are kept through a dashboard task restart, a forced dashboard kill, a dashboard-only update and a failed-migration rollback. The scenario checks unchanged Java and service PIDs, commands and console replay. It also checks the boot start mode and preshutdown timeout. A service stop must save the world, including a block change without an explicit save, and exit with code 0. Starting the service again must bring back the auto-start server and its world. The wrapper handles stop and preshutdown with the same code, but Windows does not let applications send preshutdown, so this is not a host reboot. On failure, the scenario prints dashboard, runtime and Minecraft logs.

## Graceful host shutdown and boot (Linux)

`host-reboot.mjs` powers off its host between two phases, so run it only on a disposable systemd host. On Windows, clone the WSL test distro and remove the clone afterwards:

```powershell
wsl --export craftpanel-test C:\cpwsl\craftpanel-test.tar
wsl --import craftpanel-reboot C:\cpwsl\reboot C:\cpwsl\craftpanel-test.tar
wsl -d craftpanel-reboot -u root -- systemctl disable --now craftpanel   # keep the cloned instance off its ports
# keep the clone alive in another terminal: wsl -d craftpanel-reboot -u root -- sleep infinity
wsl -d craftpanel-reboot -u root -- node scripts/real-tests/host-reboot.mjs prepare FIXTURES craftpanel-ops-NAME PORT /path/to/test-tools [/path/to/java]
wsl -d craftpanel-reboot -u root -- systemctl poweroff
# boot it again (start the keep-alive), then:
wsl -d craftpanel-reboot -u root -- node scripts/real-tests/host-reboot.mjs verify FIXTURES craftpanel-ops-NAME PORT /path/to/test-tools
wsl --unregister craftpanel-reboot
```

Run the `node` commands from the checkout (`/mnt/c/...`). Generate fixtures with `installer-fixtures.mjs` as above. `prepare` installs the instance and two real Paper 1.21.4 servers, one with auto-start and one without. It connects a player, flushes a gold block and then places a diamond block without a save. `verify` checks for a new systemd boot (PID 1 start time; WSL journal boot IDs follow the shared kernel). It checks the journal since preparation for a runtime stop without SIGKILL or stop timeout and the previous Minecraft logs for a graceful stop and world save. It also checks that both units are enabled, only the auto-start server is running again, a player can join, and both blocks still exist. It then uninstalls the instance and writes `host-reboot-evidence.json`. A WSL distro poweroff is a full systemd shutdown and boot, not a kernel or firmware reboot.

## Conventions

- Ports: don't use 8080/25565 or anything a real instance on the machine uses. Pick e.g. 8130+ for the API and 25820+ for Minecraft.
- Linux checks on a Windows machine: a WSL 2 distro with systemd. Run `run.sh` inside a single `wsl -d <distro> -- bash -lc '…'` call (WSL kills background processes when the call that started them returns) and keep the distro alive with a separate background `wsl -d <distro> -- sleep infinity`. Running the scripts from the Windows checkout (`/mnt/c/…`) works; copy the data dir into the Linux file system (e.g. `$HOME/cp-test`) for realistic speed.
- Player-side checks: `npm i mineflayer` in the directory you call `run.sh` from (scenarios look for it there); a headless bot in offline mode can join, chat and run commands (it lags the newest Minecraft versions).
- Browser checks: `npm i playwright` (and `npx playwright install chromium`); sign in with the throwaway owner and screenshot the pages.
- Long scenarios (downloads, world generation) take several minutes; run them in the background and read the log afterwards.
