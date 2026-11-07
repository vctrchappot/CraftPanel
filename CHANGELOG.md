# Changelog

All notable changes to CraftPanel. Versions follow [semantic versioning](https://semver.org); while the version starts with 0, minor versions may change behaviour.

`scripts/release.mjs <version>` turns the "Unreleased" section into the release notes for that version.

## Unreleased

### Added
- Release packages: every `v*` tag publishes one archive that runs on every OS and CPU (no build on the target machine), with SHA-256 checksums.
- One-line installers: `install.sh` for Linux and Raspberry Pi (systemd service, private Node.js if needed) and `install.ps1` for Windows (runs at sign-in, no admin rights needed). Re-running them updates; a failed update rolls back.
- Update notice in the dashboard when a newer release is available, with the right update command for the install.
- Settings in `/etc/craftpanel/craftpanel.env` (Linux service) survive updates.
- Purpur servers (Paper fork; same plugins, TPS/MSPT and `/craftpanel` command).
- Fabric servers with a choice of loader version; Fabric mods from Modrinth (search, install, updates, upload) with dependency checks by mod id.
- Log4Shell protection for Minecraft 1.7–1.18: CraftPanel adds Mojang's JVM flag or patched logging config on every start and shows it in the wizard and the server's runtime settings.

### Changed
- The version lives only in `package.json`.

### Fixed
- Invalid HTML nesting in the dashboard (a loading placeholder inside a paragraph) that caused hydration warnings, and a WebSocket warning in development.

## 0.1.0 – 2026-11-07

First public version.

- Vanilla and Paper servers for any published version, checksum-verified downloads, automatic Java.
- Live console, metrics (CPU, RAM, TPS/MSPT), players, whitelist/ops/bans, settings and game rules editors.
- Plugins from Modrinth, worlds, file manager, backups with verification and restore, scheduled tasks.
- Start profiles (`local`, `lan`, `proxy`, `headless`), network access policy, optional built-in HTTPS.
- Multi-user with roles and an audit log, setup token for network-exposed installs.
- In-game `/craftpanel` info command.
- Linux systemd installer for git checkouts and the `update.cmd` / `./update.sh` update script.
