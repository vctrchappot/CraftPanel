# CraftPanel – notes for Claude Code

Self-hosted Minecraft (Java) server manager: Fastify API + Next.js dashboard in a pnpm monorepo, SQLite via `node:sqlite` + Drizzle, no native add-ons. Start here:

- **What's done and how it was verified:** `docs/STATUS.md`
- **What's next:** `docs/ROADMAP.md` (work through "Next" in order unless told otherwise; tick items off as you finish them)
- Architecture, security, deployment, development: `docs/*/README.md`
- `apps/web/AGENTS.md`: this Next.js version differs from older ones; read its bundled docs before changing web code.

## Working agreements
- The owner writes in German; answer in German. Code, comments, commits and docs are in English.
- **Commit and push on your own whenever a stable state is reached**: typecheck clean, `pnpm test` green, and verified for real where it matters. Commit in logical chunks; don't push half-finished or failing work. Check that CI is green after pushing (`gh run list`, `gh run watch`).
- Commit identity: `vctrchappot <victor.chappot.haas@gmail.com>`. Never commit with another address. Set it per checkout with `git config user.email`.
- End commit messages with `Co-Authored-By: Claude <noreply@anthropic.com>` (or the attribution your environment specifies).
- Keep `docs/STATUS.md` honest (✅ verified / 🧪 tested / 🟡 untested) and update `docs/ROADMAP.md` when plans change.

## Commands
```bash
pnpm install
pnpm dev              # API :8080 + dashboard :3000, data in ./.data
pnpm typecheck
pnpm test             # Vitest, no network
pnpm build            # → apps/api/dist (self-contained: bundle, migrations, assets, web)
pnpm start            # or start:lan / start:proxy / start:headless
pnpm test:e2e         # Playwright, real Minecraft download + run (npx playwright install chromium once)
pnpm db:generate      # after changing packages/database/src/schema.ts; commit the generated migration
node scripts/build-info-plugin.mjs [--check]   # rebuild the /craftpanel plugin jar (needs JDK 17+, JAVA_HOME)
node scripts/release.mjs pack                   # release/ archive + installers + SHA256SUMS (after pnpm build)
node scripts/measure.mjs [--idle 60] [--json]   # startup, idle CPU/RAM, API latency, bundle sizes of the build (own port, temp data)
node scripts/release.mjs bump X.Y.Z && git push --follow-tags   # release: GitHub Actions publishes it
```

## Conventions
- Workspace packages export TypeScript sources directly; only the API is bundled (esbuild).
- Every route calls `requirePermission(...)`; add permissions in `packages/shared/src/roles.ts`.
- Errors: `AppError(status, code, message, hint)`; the UI shows message and hint.
- Never use a shell for processes (`spawn` with argv); never interpolate user input into commands.
- Filesystem access to server directories goes through `ServerSandbox`.
- The version lives only in the root `package.json` (read by `packages/shared/src/meta.ts`); author in `meta.ts`. Add user-facing changes to `CHANGELOG.md` under "Unreleased".
- Installers: `deploy/install.sh` (Linux) and `deploy/install.ps1` (Windows) install release archives; test them with `--archive` / `CRAFTPANEL_ARCHIVE` and, on Windows, `CRAFTPANEL_INSTALL_DIR`, `CRAFTPANEL_DATA_DIR`, `CRAFTPANEL_TASK_NAME`, `CRAFTPANEL_PORT` so a real install isn't touched.
- The plugin jar `apps/api/assets/CraftPanelInfo.jar` is committed and must match `plugins/craftpanel-info` (CI checks it).
- `.gitattributes` forces LF (CRLF for `*.cmd`/`*.ps1`); executable scripts need the git exec bit (`git update-index --chmod=+x`).

## Testing for real
- Prefer verifying against real Minecraft servers over mocks: create, install, start via the API or the dashboard, and read the server log.
- `scripts/real-tests/` has the API client and scenarios used for STATUS.md's ✅ entries; `run.sh <port> <data-dir> <scenario>` runs one against a throwaway instance of the current build. Add new scenarios there.
- Player-side checks: a headless [mineflayer](https://github.com/PrismarineJS/mineflayer) bot (offline mode) can join, chat, run commands and print received chat components. It lags the newest Minecraft versions; use a Paper version it supports.
- Linux on Windows: a WSL 2 distro with systemd works well for installer/service tests. Keep it alive with a background `wsl -d <distro> -- sleep infinity`, otherwise WSL stops it (and the service) between commands.
- Enter test credentials only on `localhost`; run browser tests inside the machine that hosts CraftPanel.
- Windows: very deep paths (> 260 chars) break pnpm/Next builds; test copies belong in a short path.
- Don't touch other CraftPanel instances or Minecraft servers already running on the machine (e.g. on ports 8080/25565); use other ports and a temporary `CRAFTPANEL_DATA_DIR`.
- WSL kills background processes when the `wsl …` call that started them returns: start the API and run the scenario inside one call (`run.sh` does).

## Working in this repo with an agent
- Where things stand and what's next: "Current state" at the top of `docs/ROADMAP.md`. Update it before handing over.
- Parallel work: give a subagent its own git worktree and branch, let it commit there (not push), then merge into `main` yourself and resolve conflicts (CHANGELOG, STATUS, ROADMAP usually conflict).
- Unfinished work that must survive a device switch goes to a pushed `wip/<topic>` branch, never to `main`.
- Edits through a shell on Windows (Git Bash, `node -e`, heredocs) can silently drop regex backslashes: use the Edit/Write tools, or write a transform script to a file first, and grep changed regexes afterwards. In such scripts use `s.replace(a, () => b)`, since `$'`, `` $` `` and `$&` in a replacement string are special.
