# Application backups and first-run restoration

Owners export an application backup from Settings → Backups. `AppBackupService` snapshots SQLite with `VACUUM INTO`, captures the destination for the whole run, and optionally includes live server archives and completed local server backup history. Manual and scheduled exports share a lock. Scheduled retention runs only after success and only on archives carrying that schedule's ID.

## Archive formats

The ZIP manifest remains format 1. Stage 3 adds optional `backups` entries (`id`, `serverId`, `archive`, `sha256`) for `history/<backup-id>.zip`. Omitted history preserves the original behavior. Import keeps only matching completed backup rows, verifies the archived files, and relocates them to `backups/<server-id>/imported-<backup-id>.zip`; original display names and notes remain. Storage names are unique even if old display filenames repeat.

Encrypted `.cpbackup` files wrap the entire ZIP:

1. Eight ASCII bytes `CPBKENC1`.
2. A four-byte unsigned big-endian JSON-header length, bounded to 2,048 bytes.
3. UTF-8 JSON with strict fixed algorithm/KDF identifiers, a random 16-byte salt, random 12-byte IV, schedule ID or null, server counts and history count.
4. AES-256-GCM ciphertext, followed by a 16-byte authentication tag.

The prefix and JSON are additional authenticated data. A 32-byte key is derived with Node's asynchronous scrypt (`N=32768`, `r=8`, `p=1`, 64 MiB maximum memory). Each archive gets a new salt and IV. KDF parameters cannot be supplied by an uploaded file. Public header counts and the schedule ID are listing/retention hints until authentication; no account, server name or credential is exposed there. The importer authenticates all ciphertext into a private temporary file before opening the ZIP. Wrong phrases and changed headers, ciphertext or tags fail without importing. Key buffers are cleared after use; JavaScript passphrase strings have normal garbage-collector lifetime.

Encryption uses a private staging ZIP. Only ciphertext is published to the configured backup destination, including a synchronized folder. Plaintext staging is removed on completion/failure, with abandoned normal temporary files removed at startup. Deletion is ordinary filesystem deletion, not secure erasure.

## Scheduled passphrases

`BackupPassphrases` atomically writes a host-local `application-backup-passphrases.json` with mode 0600. It is deliberately outside SQLite, environment exports and application archives. Windows uses the installed data directory's access control as well. The file contains plaintext passphrases so unattended jobs can encrypt; this protects exported files, not a compromised host. APIs, schedule payloads and audit records never return them. Manual passphrases are not persisted. Empty edits keep an existing secret. Import pauses encrypted application schedules, and enabling them on a new host requires entering a passphrase again. Keep the old phrase separately to decrypt earlier archives.

Offline import accepts `--passphrase-file FILE`, reading UTF-8 and removing one terminal newline, so a secret need not appear in argv or environment. Existing ZIP files and the original CLI remain compatible.

## First-run activation

`POST /api/auth/restore` reserves setup before streaming the upload (maximum 2 GiB, one file and one optional passphrase field). It requires no users or server rows and an empty connected runtime. Origin/transport rules and the setup-token header apply before upload. Owner creation shares the reservation. The response is 202 with a random 24-byte capability; `/api/auth/restore/status` requires it and expires after one hour. No restored session is issued: the old account, including its second factor, must sign in.

The workspace is `setup-restore-<random>/` under the private data root, on the same filesystem as activation targets. Offline import first validates/extracts into `staged/`, with database paths already referring to the eventual destination. Migrations and an active owner are checked there. The new host's dashboard access policy replaces the old allowlist; host environment and certificates are saved for review, not applied.

Activation stops background services, blocks ordinary requests with 503, closes SQLite, removes the old WAL/SHM, writes and syncs a rename plan, then transfers server folders, backup history, import metadata and finally the database. The existing database handle reopens so services retain their Drizzle references. After reopening, the journal is marked committed. Failures roll transfers back in reverse order. An unresolved rollback keeps the workspace and blocks normal work until restart.

At startup, before SQLite opens, `recoverSetupRestores` refuses workspaces owned by a live process. A dead process's uncommitted plan is rolled back, discarding the new database's WAL/SHM before restoring the original; a committed plan keeps the new installation and its sidecars. Paths are checked against the staging and data roots. Recovery files are removed only after successful recovery. Tests kill a child process between old/new renames, after a write to the imported database's WAL and after commit; injected reopen failure checks in-process rollback. First-run activation is deliberately limited to a fresh installation; existing installations use the stopped CLI and explicit `--replace`.
