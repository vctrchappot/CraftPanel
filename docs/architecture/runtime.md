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

The installer fingerprints both runtime code and service wrappers. Dashboard-only
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
