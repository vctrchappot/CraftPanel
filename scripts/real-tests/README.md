# Real-server test scenarios

Scripts that drive a throwaway CraftPanel instance through its HTTP API against real Minecraft downloads and servers. They complement `pnpm test` (no network) and `pnpm test:e2e` (Playwright). STATUS.md entries marked ✅ were verified with scenarios like these.

```bash
pnpm build
scripts/real-tests/run.sh <api-port> <data-dir> <scenario.mjs> [args…]
```

`run.sh` copies `apps/api/dist`, starts it on `127.0.0.1:<api-port>` with its own data dir, runs the scenario and stops the API (servers are stopped gracefully). The first sign-in creates a throwaway owner account (`client.mjs`, overridable with `CP_USER`/`CP_PASSWORD`). Use local test instances only.

| Scenario | Args | What it checks |
|---|---|---|
| `software-switch.mjs` | – | A block placed in Paper's Nether survives Paper → Vanilla → Fabric → Paper; downgrade guard. |
| `performance.mjs` | `[software] [mcVersion] [mcPort]` | Wizard preset applied (JVM flags, distances), preset switch, Chunky install and pre-generation with pause/continue/cancel. |
| `neoforge.mjs` | `<mcVersion> <mcPort>` | NeoForge catalogue, install, start, Chunky as a NeoForge mod, mod list from `neoforge.mods.toml`, pre-generation, switch preview. |
| `modpack.mjs` | `search <query>` or `run <modrinthProjectId> <mcPort> [versionId]` | Modrinth modpack search; prepare, create, install, start, mods loaded. |
| `modpack-upload.mjs` | `<mcPort>` | `.mrpack` upload: overrides vs. the server's port/EULA, Forge pack and junk refused, a used pack can't be reused. Needs `python3`. |
| `modpack-fix-crash.mjs` | – | After `modpack.mjs run` with a pack that crashes (`KEEP_DATA=1`): the crash names the mod, disabling it via the mod list lets the server start. |
| `velocity.mjs` | `[proxyPort] [paperVersion]` | Velocity proxy with a Paper backend: wiring, forwarding ready, secret not in the console; with `mineflayer` in the working directory a bot joins through the proxy and a direct join to the backend is refused. |

## Conventions

- Ports: don't use 8080/25565 or anything a real instance on the machine uses. Pick e.g. 8130+ for the API and 25820+ for Minecraft.
- Linux checks on a Windows machine: a WSL 2 distro with systemd. Run `run.sh` inside a single `wsl -d <distro> -- bash -lc '…'` call (WSL kills background processes when the call that started them returns) and keep the distro alive with a separate background `wsl -d <distro> -- sleep infinity`. Running the scripts from the Windows checkout (`/mnt/c/…`) works; copy the data dir into the Linux file system (e.g. `$HOME/cp-test`) for realistic speed.
- Player-side checks: `npm i mineflayer` in the directory you call `run.sh` from (scenarios look for it there); a headless bot in offline mode can join, chat and run commands (it lags the newest Minecraft versions).
- Browser checks: `npm i playwright` (and `npx playwright install chromium`); sign in with the throwaway owner and screenshot the pages.
- Long scenarios (downloads, world generation) take several minutes; run them in the background and read the log afterwards.
