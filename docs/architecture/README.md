# Architecture

CraftPanel is a TypeScript monorepo (pnpm workspaces). In production it is **one Node.js process on one port**: the Fastify Control API serves the statically exported Next.js dashboard, the REST API and a WebSocket, and owns the Minecraft child processes through an in-process runtime agent.

```
Browser ──HTTP/WS──▶ Control API (Fastify) ──▶ RuntimeAgent (LocalAgent) ──spawn──▶ java -jar server.jar nogui
   ▲                      │        │                    │
   │ static export        │        └─ SQLite (node:sqlite + Drizzle)
   └──────────────────────┘        └─ Providers: Mojang · PaperMC · Adoptium · Modrinth
```

## Packages

| Package | Responsibility |
| --- | --- |
| `apps/web` | Next.js 16 / React 19 dashboard, Tailwind v4, built with `output: "export"`. Client-side only; talks to the API via fetch and one WebSocket. |
| `apps/api` | Control API: auth, sessions, CSRF, RBAC, validation, persistence, orchestration (`services/*`), REST routes, WebSocket hub, static file serving, startup recovery and graceful shutdown. |
| `packages/shared` | Zod schemas, API/WS types, roles & permission matrix, error type. Shared by API and web. |
| `packages/ui` | shadcn-style primitives on Radix (buttons, dialogs, menus, tabs, forms, layout). |
| `packages/database` | Drizzle schema, migrations (`drizzle/`), SQLite client using Node's built-in `node:sqlite` via the Drizzle proxy driver, so there is no native add-on to compile on ARM. |
| `packages/server-runtime` | `ManagedServer` (process lifecycle state machine, stdin, console ring buffer, log parsing, internal queries), `LocalAgent` (implements `RuntimeAgent`), per-OS process metrics, `ServerSandbox` (confined filesystem access), data-directory layout. |
| `packages/minecraft-providers` | `ServerProvider` adapters (Vanilla, Paper), Mojang/Paper metadata, verified downloads with a trusted-host allowlist, Java detection/installation (Adoptium), gamerule detection via Mojang's data generator, Modrinth plugin search/install/update, Mojang profile lookup. |
| `packages/config` | Lossless `server.properties` parser/serializer and the settings catalog (groups, types, help, restart flags). |
| `packages/backup` | Zip creation with progress and SHA-256, CRC verification, safe extraction (zip-slip, symlink and zip-bomb protection), `BackupStorage` abstraction (local today, S3-compatible later). |
| `packages/network` | LAN address detection, port checks, WAN/CGNAT diagnostics, DDNS providers (DuckDNS), `TunnelProvider` interface. |
| `packages/scheduler` | Cron validation and a de-duplicating in-process scheduler (croner). |

## Key design decisions

**Process ownership and recovery.** Servers are spawned directly (`spawn(file, argv, { shell: false })`), never through a shell. Lifecycle states: `installing → stopped → starting → running → stopping → stopped`, with `crashed` (unexpected exit), `error` (spawn failure) and `orphaned`. On startup CraftPanel reconciles the database with reality: a stored PID is probed and its executable name checked. A live Java process becomes `orphaned` (stoppable, but without console), and a dead one is marked `crashed` if it was meant to be running. On SIGINT/SIGTERM CraftPanel sends `stop` to every server and waits.

**Internal queries.** Metrics and game rules use the server's own console (`tps`, `mspt`, `tick query`, `gamerule <name>`, `save-all flush`). `ManagedServer.query()` sends the command and consumes the matching response line, so internal traffic doesn't clutter the user's console. Metrics are sampled only while someone is watching the server, so there is no idle polling.

**Version awareness.** Java requirements come from Mojang's version metadata (and Paper's API). Game rules are detected by running Mojang's data generator (`--reports`) on the official jar of that exact version and reading the Brigadier command tree, then cached per version. Log parsing handles vanilla, Paper and the 26.x `System chat:` prefix.

**Consistent backups.** For a running server: `save-off` → `save-all flush` (await "Saved the game") → zip → `save-on`. Restores require a stopped server, verify SHA-256 and CRCs, take a safety backup, extract to a staging directory, then swap.

**Remote agents (future).** `RuntimeAgent` is the seam between orchestration and process control. A remote agent would implement the same interface over an authenticated channel (e.g. mTLS WebSocket) so one dashboard can manage several hosts. Container isolation would be another agent implementation.

**Other server software (future).** `ServerProvider` covers versions, builds, Java requirement and installation. Fabric/NeoForge fit this interface directly (plus a mods directory and Modrinth `loaders` filter). Bedrock Dedicated Server needs `LaunchSpec.command` (native binary, no JVM), UDP port 19132 and its own properties/permissions model.

## Data layout

```
<data dir>/
  craftpanel.db          SQLite (WAL)
  servers/<slug-id>/     one directory per server (marker file .craftpanel)
  backups/<server-id>/   zip archives (or a configured destination)
  runtimes/java/         Temurin runtimes downloaded by CraftPanel
  cache/                 version jars for gamerule detection, gamerule cache
  tmp/                   uploads/exports in progress (cleared on start)
  setup-token.txt        only until the first account exists (non-loopback installs)
```

## Real-time protocol

`/api/ws` (session cookie + Origin check). Server → client messages: `hello`, `console` (batched lines, replay on subscribe), `status`, `metrics`, `players`, `install`, `backup`, `event`, `error`. Client → server messages: `subscribe`, `unsubscribe`, `command`, `ping`. Types live in `packages/shared/src/types.ts`.
