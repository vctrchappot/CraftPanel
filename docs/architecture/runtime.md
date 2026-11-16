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

## Per-server restricted tokens (Windows)

On the installed Windows service (its virtual account, `S-1-5-80-…`) every Minecraft server runs under a
restricted copy of the service's token, so a plugin cannot read the panel database, secrets, the runtime
token or another server's files. `CRAFTPANEL_ISOLATION=on` enables it for a runtime started by hand (it may
then change permissions above the data directory: see below), `off` disables it. Code:
`packages/server-runtime/src/windows-isolation.ts`, helper source in `windows-token-helper.ts`.

- **Token.** A restricted token passes an access check only if both its account and one of its restricting
  SIDs are granted. The account keeps the runtime's own access; the restricting SIDs are the server's own SID,
  Everyone, Users, Authenticated Users and RESTRICTED (`S-1-5-12`). The server SID is `S-1-9-…` (resource
  manager authority), derived from the server id; it names no account and only appears in the token and on
  the server's folders. Administrators is deny-only, every privilege but traversal is removed, and the default
  DACL grants SYSTEM, the account and the server SID. Network access, loopback included, is unchanged
  (an AppContainer blocked inbound loopback even with a loopback exemption: see ROADMAP.md).
- **Launch.** Node cannot create a process with another token, so a small C# helper does, compiled like the
  job helper (`runtime/server-token-<hash>.exe`): `run <sid> <temp> -- <java> <args>` starts Java suspended
  with the token, puts it into a kill-on-close job, prints `craftpanel-pid <pid>` and resumes it. Java shares
  the helper's stdin/stdout/stderr, so console and `stop` work unchanged; `ManagedServer` takes the reported
  PID as the server's (metrics, limits, orphan checks) and hides that line. Killing the helper closes the job
  and ends Java and anything it started; the helper exits with Java's exit code. Every process that loads
  user32 opens its window station and desktop, and a service's grant only the service account, so Java failed
  with `0xC0000142` under the service (found in CI, reproduced with a virtual-account service in Windows
  Sandbox). A service may not create a window station of its own, so the helper adds RESTRICTED to the
  service's window station and desktop (not to an interactive `WinSta0`, which admits restricted processes). The job helper for resource
  limits nests its job inside that one.
- **Files.** Before every start `prepare` adds the server SID with Modify (inherited) to the server directory
  and to `game-temp/<id>/` in the data directory (emptied first; `TEMP`/`TMP` point there, since the
  account's own temp folder is out of reach), lets RESTRICTED list the folders between the data directory and
  the server or Java directory, and lets it read a Java runtime inside the data directory. Java under Program
  Files is readable by Users already. This needs WRITE_DAC: the installer grants the service `(M,WDAC)` on the
  data directory and on custom server locations, the dashboard on newly chosen ones.
- **Above the data directory** the service cannot change permissions. Java's `toRealPath` (Paperclip) lists
  every ancestor of the server directory, so the installer lets RESTRICTED list (`RD,X,RA,S`, not inherited)
  the folders above the data directory and custom server locations, and the dashboard those above newly chosen
  ones. Listing shows names, not contents.
- **Check.** `prepare` then impersonates the token and tries what Java will do: list each ancestor, write the
  server and temp directories, open Java for execution. Any failure stops the start with the folder and the
  `icacls` command that fixes it. It also tries to read `craftpanel.db` and `runtime/token`; if it can (a data
  directory that inherits access for Users), the server starts with an "Isolation is incomplete" warning in
  its console. For a server directory outside the data directory it also reads the folder's ACL: if Users,
  Authenticated Users or Everyone may read it (inherited from a parent), the same warning names the `icacls`
  command that closes it.
- **Not covered:** files every local user may read elsewhere on the machine, and the network. Windows has no `share` step: files Java writes inherit the
  directory's permissions, which include the dashboard's account.

## Resource limits

Each server has a memory cap, a CPU limit and a process/thread limit (`servers.limit_*`; `null` is
the default, `0` off; defaults in `packages/shared/src/limits.ts`: heap + max(1 GB, half the heap),
no CPU limit, 4,096 tasks). The dashboard sends the effective values with the launch spec and as a
`limits` call when they change; the runtime applies them through cgroup v2 on Linux and job objects
on Windows (`packages/server-runtime/src/limiter.ts` picks one).

### Linux: cgroup v2

Code: `packages/server-runtime/src/cgroups.ts`.

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

### Windows: job objects

Code: `packages/server-runtime/src/windows-jobs.ts`, helper source in `windows-job-helper.ts`.

- Node cannot hold a job handle without a native add-on, so a small C# helper does: the runtime
  compiles it on the first limited start with the .NET Framework compiler that ships with Windows
  (`csc.exe`) into `runtime/job-helper-<hash>.exe`, and starts one per running server with the
  server's PID right after spawning it. The helper creates an unnamed job, sets the limits and
  assigns the process. The job nests inside the jobs the process is already in (Node's own and the
  runtime service's), so stopping the runtime still stops everything; it has no kill-on-close, so a
  dying helper leaves the server running with its limits.
- Memory is `JobMemoryLimit` (committed memory of all processes in the job): allocations above it
  fail. Java usually stops with an out-of-memory error, but can also only slow down, so the first
  hit is written to the console at once (from the job's completion port) and an exit after it is
  reported as "Memory limit reached". CPU is a hard `CpuRateControl` cap; the process limit is
  `ActiveProcessLimit` and counts processes only, not threads (the card says "Processes").
- Changes go to the helper on stdin and apply at once. On exit the runtime sends `kill`
  (`TerminateJobObject`: leftovers a plugin started die with the server) and closes stdin.
- Gap: the process runs for a moment (well under a second once the helper is compiled, about two
  seconds on the very first start) before it is in its job; anything it starts in that moment
  escapes the limits. Java starts no processes that early.
- Without `csc.exe` or with `CRAFTPANEL_LIMITS=off` the runtime reports why; settings are kept.

With isolation the job helper attaches to the PID the token helper reports.
