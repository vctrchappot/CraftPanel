# Development

```bash
corepack enable            # Node 25+: npm install -g pnpm
pnpm install
pnpm dev            # runtime + API :8080 (tsx watch) + Next.js :3000; data in ./.data
```

In development the dashboard calls the API cross-origin (`NEXT_PUBLIC_API_URL`), and the API allows that origin via `CRAFTPANEL_CORS_ORIGINS` (set by `scripts/dev.mjs`). In production both are served from the same origin.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm dev` | API + dashboard with reload |
| `pnpm build` | Static export of the dashboard, then the bundled API in `apps/api/dist` |
| `pnpm start:runtime` | Start the independent production Minecraft runtime |
| `pnpm start` | Start the production dashboard/API in another terminal, using the same data directory |
| `pnpm test` | Vitest: unit + integration tests (no network required) |
| `pnpm test:e2e` | Playwright: full user flow against the production build with a real Minecraft server (needs internet, ~1 min after the first download). Run `npx playwright install chromium` once. |
| `pnpm typecheck` | `tsc` for every package |
| `pnpm db:generate` | Generate a migration after editing `packages/database/src/schema.ts` |

## Tests

- `packages/server-runtime/test`: lifecycle state machine with a fake Minecraft process (`fake-minecraft.mjs`): graceful stop, crash detection, spawn errors, stop timeout without auto-kill, player tracking, internal queries, newline rejection. Also log parsing (vanilla/Paper/26.x) and sandbox traversal/symlink escapes.
- `packages/backup/test`: archive round-trip, tamper detection, zip-slip, symlink entries and zip-bomb limits (hand-crafted malicious zips).
- `packages/config/test`: lossless `server.properties` editing, escapes, unicode, validation.
- `packages/minecraft-providers/test`: gamerule extraction, Java version parsing and compatibility policy, plugin.yml parsing, download host allowlist.
- `apps/api/test`: authentication, CSRF, Origin checks, the RBAC matrix for all roles, input validation, file-manager traversal, EULA enforcement, audit log, setup-token protection.
- `tests/e2e`: the primary success path in a browser: setup → wizard → install → EULA → start → console command → settings → backup → stop → restore.

## Conventions

- Workspace packages export TypeScript sources directly (no per-package build). The API is bundled by esbuild, and Next transpiles `@craftpanel/shared` and `@craftpanel/ui`.
- API errors are `AppError(status, code, message, hint)`, and the dashboard shows `message` and `hint`.
- Every route calls `requirePermission(req, "<permission>")`. Add new permissions to `packages/shared/src/roles.ts`.
- Never interpolate user input into shell commands; never call `spawn` with `shell: true`.

## License

CraftPanel is licensed under the **PolyForm Strict License 1.0.0** (source-available, not open source): anyone may download and run it for personal and other noncommercial purposes (including charities, schools and public institutions); selling it, changing it, building other works on it and redistributing it are not allowed without the author's permission. Earlier commits (up to the switch in November 2026) were published under AGPL-3.0-or-later and stay available under it.

Dependency notes: runtime dependencies are MIT, ISC, Apache-2.0 or BSD licensed (Fastify and its plugins, Drizzle ORM, Zod, croner, yauzl/yazl, tar, React, Next.js, Radix UI, Tailwind CSS, lucide, sonner, cmdk, TanStack Query, Fontsource Inter/JetBrains Mono under OFL-1.1). Their licenses allow use in a project under these terms; their notices ship with the release archive's `node_modules`. Minecraft server software, Paper and Java are **not** bundled; they are downloaded by the user's installation from their official sources under their own licenses (Minecraft EULA, GPL-3.0 for Paper, GPLv2+CE for Temurin).
