# Separate Minecraft runtime

The runtime owns child processes, stdin, status, players, console history and metrics.
The dashboard owns authentication, permissions, persistence and server configuration.
`LocalAgent` is still available for embedded tests. `RuntimeClient` implements the same
contract over a Unix domain socket or Windows named pipe; it never spawns Minecraft.

Start `node apps/api/dist/runtime.js` with the same `CRAFTPANEL_DATA_DIR` as the
dashboard. It has no TCP listener. Unix uses `runtime/control.sock` in a mode-0700
directory and a mode-0600 socket/token; Windows uses a data-directory-specific pipe
and the same random token. The Windows installer must protect the data directory ACL.
Processes with access to the service account or token have runtime control.

For data paths beyond Unix socket limits, each process creates a short, owned symlink
under `/tmp` to the private runtime directory. It rejects aliases owned by another UID
or pointing elsewhere. This also works when systemd gives the dashboard and runtime
separate PrivateTmp namespaces: both aliases point to the same data directory. The
socket itself stays protected by the directory/socket permissions. See the [Node IPC
path limits](https://nodejs.org/api/net.html#identifying-paths-for-ipc-connections).

Protocol version 1 uses bounded newline-delimited JSON. An authenticated handshake
replays one snapshot per server and returns a runtime epoch and a new connection
session. Every call carries these identifiers, a strictly increasing sequence and
a short dispatch deadline. Duplicate, old-session and incompatible-version messages
are rejected. Commands are never retried or queued across connections. A lost reply
means the result is uncertain: reconcile state before explicitly trying again.

Snapshots include the actual PID, status, players and console history (at most 2,000
lines and 512 KiB per server). Slow clients are disconnected. Metric watches are
released when the dashboard disconnects and reinstated on reconnection.

`runtime/servers.json` records launch specifications and auto-start choices, independently
of the panel database. Runtime termination sends `stop` and waits for saves; dashboard
disconnection leaves servers running. On runtime boot only configured auto-start servers
start. A live PID left by a runtime crash is held as orphaned instead of duplicated;
runtime crash reattachment is outside this phase's dashboard-crash guarantee.

The installer fingerprints both runtime code and service wrappers. The fingerprint is the hash of the bundled `runtime.js`, so the bundle must hold only what the runtime uses: `@craftpanel/shared` is marked `"sideEffects": false`, which keeps its dashboard-only modules (schemas, permissions, performance advice, the map) out, and `apps/api/test/runtime-bundle.test.ts` fails if one slips in. A release that only changes the dashboard, the web UI or those shared modules therefore leaves the fingerprint alone and keeps games running; only a change to the runtime itself (or the software catalogue and error type it imports) asks for a maintenance restart. Dashboard-only
transactions leave the runtime process untouched, including failed dashboard updates.
Runtime changes require explicit, expiring approval for the target fingerprint. After
graceful runtime shutdown, the standalone recovery helper snapshots its registry with
ownership, mode and checksum; rollback replaces it atomically without following links.
The private authentication token is preserved across updates and rollback.

On Windows the SCM virtual account owns the runtime job independently of the user's
dashboard task. Before registering a new storage or Java path, the dashboard asks the
service to probe that path under its actual identity. It grants modify access to the
server directory and read/execute access to Java only when needed, then probes again.
Diagnostics are rate-limited and include transport/persistence reason codes without
tokens, command contents or raw exception messages.

This foundation is tested with actual child processes. Installer integration and
real Minecraft/player, host-shutdown and failed-update acceptance evidence are tracked
separately; these tests alone do not complete the phase.

## Per-server accounts (Linux)

On Linux service installs every Minecraft server runs under its own account, so a plugin cannot
read the panel database, secrets, the runtime token or another server's files. Code:
`packages/server-runtime/src/isolation.ts`.

- **Accounts.** The installer creates `<service user>-game-00` … `-NN` (default 32,
  `CRAFTPANEL_GAME_ACCOUNTS`), each with its own group, and adds the service user to every game
  group. Accounts are never removed: they own files in the server directories. The runtime finds
  them in `/etc/passwd`, keeps only those whose group it is a member of, and assigns the lowest free
  one to a server on its first start (`slot` in `servers.json`; it stays until the server is forgotten).
- **Privileges.** The runtime unit grants `CAP_SETUID CAP_SETGID CAP_CHOWN CAP_FOWNER CAP_KILL` as
  ambient capabilities and bounding set; `NoNewPrivileges` stays on. Java is started through
  util-linux `setpriv --reuid --regid --clear-groups --inh-caps=-all`: clearing the inheritable set
  clears the ambient set, so Java starts with no capabilities and no supplementary groups. The PID
  stays Java's (setpriv execs). Without accounts, capabilities or `setpriv`, or with
  `CRAFTPANEL_ISOLATION=off`, the runtime runs servers as itself and says why in its handshake
  (`isolation` in the `ready` message).
- **Files.** Before every start the runtime stops leftover processes of the account, then walks the
  server directory: group = game group, directories `2770` (setgid, so new entries keep the group),
  files gain group read/write, nothing for others; owners stay, links are never followed.
  `.craftpanel-map.json` (a password hash) stays private. Both services run with `UMask=0007`, so
  files either side creates later are shared through the group. The directory must carry the
  `.craftpanel` marker and must not contain the data or runtime directory.
- **Private files.** Java writes temp files as `0600` (Minecraft saves `level.dat` and player data
  that way). The dashboard cannot read those, so it asks the runtime (`share`, a server id and an
  optional relative path) to add group access: before backups and world exports (with autosave
  off), before folder downloads, and once after `EACCES` in `ServerSandbox` reads and player
  profiles. A game could race `share` by swapping an entry for a link (group changes never follow
  links): `chmod` would then add group bits for a group the game is not in, or remove "other"
  bits, on a file the runtime can write to, which `ProtectSystem=strict` limits to the data
  directory. That can break access until the next start re-protects it, but grants nothing.
- **Data directory.** Game accounts may traverse the data root, `servers/`, `runtimes/` and
  `runtimes/java/` (`o=x`, no listing); every other top-level entry and every server directory lose
  all "other" access. Java runtimes CraftPanel downloaded become world-readable. A server directory
  elsewhere needs `o+x` on its parents; a probe under the game account reports what is missing
  before Java starts.
- **Leftovers.** When a server exits, every remaining process of its account is killed.

## Resource limits (Linux)

Each server has a memory cap, a CPU limit and a process/thread limit (`servers.limit_*`; `null` is
the default, `0` off; defaults in `packages/shared/src/limits.ts`: heap + max(1 GB, half the heap),
no CPU limit, 4,096 tasks). The dashboard sends the effective values with the launch spec and as a
`limits` call when they change; the runtime applies them through cgroup v2. Code:
`packages/server-runtime/src/cgroups.ts`.

- The runtime unit has `Delegate=memory cpu pids` (and no `ProtectControlGroups`). On start the
  runtime moves itself into `runtime/` in its unit's cgroup and enables the controllers for the
  children. Each server gets `server-<id>/` with `memory.max` (and `memory.swap.max=0`, so the cap
  is real), `cpu.max` (quota per 100 ms) and `pids.max`. The process joins it right after spawn,
  before the JVM forks anything; cgroup v2 only checks write access to the cgroup files, so a
  process of a game account can be moved.
- Changes are written into a running server's cgroup at once. An OOM kill (`memory.events`) is
  reported as "Memory limit reached". On exit the runtime writes `cgroup.kill` (kills leftovers,
  Linux 5.14+) and removes the directory.
- Without a delegated cgroup v2 (dev mode, cgroup v1, `CRAFTPANEL_LIMITS=off`) the runtime reports
  why in its handshake (`limits`); settings are kept and shown as not enforced. A missing
  controller (memory on some Raspberry Pi kernels) is reported and skipped.

Windows limits (job objects) and Windows isolation are tracked in ROADMAP.md.
