# Architecture

CraftPanel is a TypeScript monorepo (pnpm workspaces). Production uses **two independent Node.js processes**: the Fastify Control API serves the statically exported Next.js dashboard, REST API and WebSocket on one port; the runtime service owns Minecraft children and has no TCP listener. The dashboard connects through authenticated local IPC. See [runtime.md](runtime.md) for the protocol and recovery boundary.

```
Browser ──HTTP/WS──▶ Control API ──▶ RuntimeClient ──local IPC──▶ RuntimeService ──▶ LocalAgent ──▶ Java
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
| `packages/minecraft-providers` | `ServerProvider` adapters (Vanilla, Paper, Purpur, Fabric, NeoForge), Mojang/Paper/Purpur/Fabric/NeoForge metadata, Log4Shell mitigation per version, verified downloads with a trusted-host allowlist, Java detection/installation (Adoptium), gamerule detection via Mojang's data generator, Modrinth plugin and Fabric mod search/install/update, Mojang profile lookup. |
| `packages/config` | Lossless `server.properties` parser/serializer and the settings catalog (groups, types, help, restart flags). |
| `packages/backup` | Zip creation with progress and SHA-256, CRC verification, safe extraction (zip-slip, symlink and zip-bomb protection), `BackupStorage` abstraction (local today, S3-compatible later). |
| `packages/network` | LAN address detection, port checks, WAN/CGNAT diagnostics, DDNS providers (DuckDNS), `TunnelProvider` interface. |
| `packages/scheduler` | Cron validation and a de-duplicating in-process scheduler (croner). |

## Key design decisions

**Process ownership and recovery.** The runtime spawns servers directly (`spawn(file, argv, { shell: false })`). Lifecycle states include `starting`, `running`, `stopping`, `stopped`, `crashed`, `error` and `orphaned`; a disconnected dashboard reports `unknown`. Dashboard startup/reconnection reconciles database observations with authoritative runtime snapshots, including live players and console replay. Dashboard shutdown disconnects without stopping games. Runtime shutdown sends `stop` and waits for saves; runtime startup reads its own launch/auto-start registry independently of SQLite. A live Java PID left by a runtime crash is held orphaned, since stdin cannot be reattached. Mutations acknowledge asynchronously and are never replayed after transport loss.

**Internal queries.** Metrics and game rules use the server's own console (`tps`, `mspt`, `tick query`, `gamerule <name>`, `save-all flush`). `ManagedServer.query()` sends the command and consumes the matching response line, so internal traffic doesn't clutter the user's console. Metrics are sampled only while someone is watching the server, so there is no idle polling.

**Version awareness.** Java requirements come from Mojang's version metadata (and Paper's API). Game rules are detected by running Mojang's data generator (`--reports`) on the official jar of that exact version and reading the Brigadier command tree, then cached per version. Log parsing handles vanilla, Paper and the 26.x `System chat:` prefix.

**Consistent backups.** For a running server: `save-off` → `save-all flush` (await "Saved the game") → zip → `save-on`. Restores require a stopped server, verify SHA-256 and CRCs, take a safety backup, extract to a staging directory, then swap.

**Velocity proxy.** A Velocity server is a server with `SOFTWARE_INFO.proxy`: no world, players, game rules or `server.properties`, so those services answer 409 and the dashboard hides the tabs. `ProxyService` keeps the backend list in `.craftpanel-proxy.json` and the forwarding secret in `forwarding.secret` in the proxy's directory. It plugs into `ServerService.hooks`: `created` writes the initial files, `beforeStart` rewrites `velocity.toml` before a proxy starts and, before a backend starts, sets `online-mode=false` plus Paper's `proxies.velocity` (or FabricProxy-Lite's config) with the secret. Saving the list on a running proxy sends `velocity reload`; backends pick up changes on their next start. The TOML/YAML edits are small line-based editors (`packages/config/src/proxy.ts`) that keep everything they don't own.

**Remote agents (future).** `RuntimeAgent` separates orchestration from process control. `RuntimeClient` implements local IPC and `LocalAgent` is the process owner (also injectable for embedded tests). Remote hosts would need authenticated remote transport plus filesystem, installation and resource operations that still belong to the local API today. Container isolation is a later phase.

**Other server software (future).** `ServerProvider` covers versions, builds, Java requirement and installation. Fabric/NeoForge fit this interface directly (plus a mods directory and Modrinth `loaders` filter). Bedrock Dedicated Server needs `LaunchSpec.command` (native binary, no JVM), UDP port 19132 and its own properties/permissions model.

## Data layout

```
<data dir>/
  craftpanel.db          SQLite (WAL)
  runtime/              private IPC token, endpoint and launch/auto-start registry
  servers/<slug-id>/     one directory per server (marker file .craftpanel)
  backups/<server-id>/   zip archives (or a configured destination)
  runtimes/java/         Temurin runtimes downloaded by CraftPanel
  cache/                 version jars for gamerule detection, gamerule cache
  tmp/                   uploads/exports in progress (cleared on start)
  setup-token.txt        only until the first account exists (non-loopback installs)
```

## Real-time protocol

`/api/ws` (session cookie + Origin check). Server → client messages: `hello`, `console` (batched lines, replay on subscribe), `status`, `metrics`, `players`, `install`, `backup`, `event`, `error`. Client → server messages: `subscribe`, `unsubscribe`, `command`, `ping`. Types live in `packages/shared/src/types.ts`.
