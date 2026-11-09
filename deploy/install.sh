#!/usr/bin/env bash
# CraftPanel installer and updater for Linux: Raspberry Pi (64-bit or 32-bit OS), home servers, VPS.
#
#   curl -fsSL https://github.com/vctrchappot/CraftPanel/releases/latest/download/install.sh | sudo bash
#
# Installs the latest release to /opt/craftpanel and runs it as the systemd service "craftpanel".
# Run it again, or "sudo /opt/craftpanel/update.sh", to update. Nothing is built on this machine,
# and Node.js is downloaded into /opt/craftpanel/node when the system has no suitable version.
#
# Options (as flags after "bash -s --", or as environment variables after "sudo"):
#   --version X.Y.Z   CRAFTPANEL_INSTALL_VERSION  install this release instead of the latest
#   --archive FILE    CRAFTPANEL_ARCHIVE          install a downloaded craftpanel-vX.Y.Z.tar.gz
#   --port N          CRAFTPANEL_PORT             dashboard port (default 8080)
#   --uninstall                                   remove the service and app, keep all data
#
# Updates can also be started from the dashboard (Settings → Updates): CraftPanel then creates
# /var/lib/craftpanel/update/requested and the root unit craftpanel-update.path runs this script
# with --from-dashboard. That request carries no options; only the newest release is installed.
# Without access to GitHub, put release archives and their SHA256SUMS into a folder and set
# CRAFTPANEL_RELEASE_DIR=/that/folder in /etc/craftpanel/craftpanel.env.
#
# Minecraft servers, worlds, backups and settings live in /var/lib/craftpanel and are never touched.
# Service settings (port, profile, HTTPS, ...) go into /etc/craftpanel/craftpanel.env, which is kept.
set -Eeuo pipefail

REPO=vctrchappot/CraftPanel
INSTALL_DIR=/opt/craftpanel
DATA_DIR=/var/lib/craftpanel
CONFIG_DIR=/etc/craftpanel
ENV_FILE=$CONFIG_DIR/craftpanel.env
UNIT_FILE=/etc/systemd/system/craftpanel.service
RUNTIME_UNIT=/etc/systemd/system/craftpanel-runtime.service
SERVICE_USER=craftpanel
UPDATE_DIR=$DATA_DIR/update
LOG_DIR=/var/log/craftpanel
RESULT_FILE=$LOG_DIR/update-result.json
UPDATE_UNIT=/etc/systemd/system/craftpanel-update.service
UPDATE_PATH_UNIT=/etc/systemd/system/craftpanel-update.path
NODE_MIN=22.13
NODE_MAJORS="24 22"

if [[ -t 1 && -z ${NO_COLOR:-} ]]; then B=$'\e[1m' D=$'\e[2m' G=$'\e[32m' Y=$'\e[33m' R=$'\e[31m' N=$'\e[0m'; else B= D= G= Y= R= N=; fi
# A progress bar for the download in a terminal, quiet in logs.
if [[ -t 2 ]]; then PROGRESS=(-#); else PROGRESS=(-sS); fi
step() { echo "${B}›${N} $*"; }
info() { echo "  $*"; }
warn() { echo "${Y}!${N} $*" >&2; }
LAST_ERROR="" ROLLED_BACK=false FROM_VERSION="" TO_VERSION=""
die() {
  echo "${R}✖${N} $1" >&2
  [[ -n ${2:-} ]] && echo "  $2" >&2
  LAST_ERROR="$1${2:+ $2}"
  exit 1
}

json_str() {
  local s=${1//\\/\\\\}
  s=${s//\"/\\\"}
  printf '"%s"' "${s//$'\n'/ }"
}

# Tells the dashboard how an update it started has ended (read by CraftPanel after its restart).
write_result() {
  local code=$1 ok=false msg
  [[ $code -eq 0 ]] && ok=true
  msg=$LAST_ERROR
  # die inside a command substitution can't set LAST_ERROR here; use the last error line of the log.
  [[ -z $msg && $ok == false ]] && msg=$(grep -a '✖' "$LOG_DIR/update.log" 2>/dev/null | tail -1 | sed 's/^.*✖ *//')
  [[ $ok == true ]] && msg="Updated${FROM_VERSION:+ from $FROM_VERSION} to $TO_VERSION"
  mkdir -p "$LOG_DIR"
  printf '{ "ok": %s, "from": %s, "to": %s, "message": %s, "rolledBack": %s, "finishedAt": %s }\n' \
    "$ok" "$(json_str "$FROM_VERSION")" "$(json_str "$TO_VERSION")" "$(json_str "${msg:-The update failed; see $LOG_DIR/update.log}")" "$ROLLED_BACK" "$(date +%s%3N)" >"$RESULT_FILE.tmp"
  mv "$RESULT_FILE.tmp" "$RESULT_FILE"
}

# Everything runs inside main, so a partially downloaded script does nothing.
main() {
  local version=${CRAFTPANEL_INSTALL_VERSION:-} archive=${CRAFTPANEL_ARCHIVE:-} port=${CRAFTPANEL_PORT:-} uninstall=false from_dashboard=false checkout="" allow_runtime_restart=false
  while (($#)); do
    case $1 in
      --version) version=${2:?--version needs a value}; shift 2 ;;
      --archive) archive=${2:?--archive needs a file}; shift 2 ;;
      --port) port=${2:?--port needs a value}; shift 2 ;;
      --uninstall) uninstall=true; shift ;;
      --from-dashboard) from_dashboard=true; shift ;;
      --checkout) checkout=${2:?--checkout needs the source directory}; shift 2 ;;
      --allow-runtime-restart) allow_runtime_restart=true; shift ;;
      -h | --help) sed -n '2,23p' "$0" 2>/dev/null || echo "See https://github.com/$REPO#install"; exit 0 ;;
      *) die "Unknown option: $1" "Options: --version X.Y.Z, --archive FILE, --port N, --uninstall" ;;
    esac
  done
  version=${version#v}

  [[ $(uname -s) == Linux ]] || die "This installer is for Linux." "On Windows use install.ps1; on macOS see the README."
  [[ $EUID -eq 0 ]] || die "Please run it with sudo." "curl -fsSL https://github.com/$REPO/releases/latest/download/install.sh | sudo bash"
  [[ -d /run/systemd/system ]] || die "systemd is not running on this machine." "CraftPanel installs as a systemd service. Without systemd, download the release and start it with: node apps/api/dist/index.js --profile lan"
  command -v flock >/dev/null || die "flock is required (install util-linux)."
  exec 9>/run/lock/craftpanel-install.lock
  flock -n 9 || die "Another CraftPanel install or update is already running."
  if [[ -n $port ]] && { [[ ! $port =~ ^[0-9]+$ ]] || ((port < 1 || port > 65535)); }; then die "Invalid port: $port"; fi

  if $uninstall; then
    do_uninstall
    return
  fi

  if $from_dashboard; then
    # The request file lives in CraftPanel's own data folder: remove it (never follow it) and ignore its content.
    rm -rf "$UPDATE_DIR/requested"
    trap 'write_result $?' EXIT
    version="" archive="" port="" checkout=""
    echo "${D}Update requested from the dashboard on $(date '+%Y-%m-%d %H:%M:%S')${N}"
  fi
  local release_dir=${CRAFTPANEL_RELEASE_DIR:-}
  [[ -z $release_dir && -f $ENV_FILE ]] && release_dir=$(env_value CRAFTPANEL_RELEASE_DIR)

  for tool in curl tar sha256sum; do
    command -v "$tool" >/dev/null || die "$tool is required." "Install it, e.g.: sudo apt install $tool"
  done

  TMP=$(mktemp -d)
  if $from_dashboard; then trap 'code=$?; rm -rf "$TMP"; write_result $code' EXIT; else trap 'rm -rf "$TMP"' EXIT; fi

  if [[ -z $archive && -z $version && -n $release_dir ]]; then
    step "Looking for the newest release in $release_dir…"
    archive=$(find "$release_dir" -maxdepth 1 -name 'craftpanel-v*.tar.gz' -printf '%f\n' 2>/dev/null | sed 's/^craftpanel-v//; s/\.tar\.gz$//' | sort -V | tail -1)
    [[ -n $archive ]] || die "No craftpanel-vX.Y.Z.tar.gz in $release_dir."
    archive=$release_dir/craftpanel-v$archive.tar.gz
    [[ -f $release_dir/SHA256SUMS ]] || die "$release_dir has no SHA256SUMS." "Copy the SHA256SUMS file of the release next to the archive."
  fi

  # ---- get the release ----------------------------------------------------------------
  local file
  if [[ -n $archive ]]; then
    [[ -f $archive ]] || die "Archive not found: $archive"
    file=$TMP/$(basename "$archive")
    cp "$archive" "$file"
    local sums
    sums="$(dirname "$archive")/SHA256SUMS"
    if [[ -f $sums ]]; then
      verify_checksum "$file" "$sums"
    else
      warn "No SHA256SUMS next to the archive; skipping the checksum check."
    fi
  else
    if [[ -z $version ]]; then
      step "Looking up the latest release…"
      local url
      url=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest") || die "Could not reach GitHub." "Check the internet connection and try again."
      [[ $url == */tag/v* ]] || die "No CraftPanel release has been published yet." "Install from source instead: see the README."
      version=${url##*/tag/v}
    fi
    step "Downloading CraftPanel v$version…"
    local base="https://github.com/$REPO/releases/download/v$version"
    file=$TMP/craftpanel-v$version.tar.gz
    curl -fL --retry 3 "${PROGRESS[@]}" -o "$file" "$base/craftpanel-v$version.tar.gz" || die "Could not download CraftPanel v$version." "Check the version on https://github.com/$REPO/releases"
    curl -fsSL --retry 3 -o "$TMP/SHA256SUMS" "$base/SHA256SUMS" || die "Could not download the checksums for v$version."
    verify_checksum "$file" "$TMP/SHA256SUMS"
  fi

  mkdir -p "$TMP/x"
  tar -xzf "$file" -C "$TMP/x"
  local src
  src=$(find "$TMP/x" -mindepth 1 -maxdepth 1 -type d -name 'craftpanel-v*' | head -1)
  [[ -n $src && -f $src/apps/api/dist/index.js ]] || die "The archive does not contain a CraftPanel release."
  version=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$src/release.json")

  local previous=""
  [[ -f $INSTALL_DIR/release.json ]] && previous=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$INSTALL_DIR/release.json")
  FROM_VERSION=$previous TO_VERSION=$version
  if $from_dashboard && [[ -n $previous && $(printf '%s\n%s\n' "$previous" "$version" | sort -V | tail -1) == "$previous" ]]; then
    die "CraftPanel v$previous is already the newest version."
  fi

  # ---- Node.js --------------------------------------------------------------------------
  step "Checking Node.js…"
  local node
  node=$(ensure_node)
  info "Using $("$node" -v) at $node"
  local snapshot_cli="$src/apps/api/dist/recovery.js"
  [[ -f $snapshot_cli ]] && [[ $("$node" "$snapshot_cli" --protocol) == craftpanel-recovery-v1 ]] ||
    die "This release does not support the required database recovery protocol." "Use a compatible release. The running service has not been stopped."
  for f in README.md LICENSE CHANGELOG.md release.json deploy/install.sh deploy/craftpanel.service deploy/craftpanel-runtime.service apps/api/dist/runtime.js; do
    [[ -f $src/$f && ! -L $src/$f ]] || die "The release is missing a regular file: $f"
  done
  [[ $("$node" "$src/apps/api/dist/runtime.js" --protocol) == craftpanel-runtime-v1 ]] || die "Unsupported runtime protocol; nothing was stopped."
  local runtime_hash declared_hash bundle_hash effective_data runtime_changed=true runtime_was_active=false runtime_enabled=false
  bundle_hash=$(sha256sum "$src/apps/api/dist/runtime.js" | awk '{print $1}')
  runtime_hash=$("$node" -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).sha256' "$src/apps/api/dist/runtime-manifest.json")
  declared_hash=$("$node" -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).runtime?.sha256 || ""' "$src/release.json")
  [[ $runtime_hash == "$declared_hash" ]] || die "Runtime bundle does not match release.json; nothing was stopped."
  [[ $bundle_hash == $("$node" -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).bundleSha256' "$src/apps/api/dist/runtime-manifest.json") ]] || die "Runtime bundle checksum mismatch; nothing was stopped."
  effective_data=$(env_value CRAFTPANEL_DATA_DIR)
  effective_data=${effective_data:-$DATA_DIR}
  systemctl is-active --quiet craftpanel-runtime 2>/dev/null && runtime_was_active=true
  systemctl is-enabled --quiet craftpanel-runtime 2>/dev/null && runtime_enabled=true
  if $runtime_was_active; then
    local identity running_hash
    identity=$(CRAFTPANEL_DATA_DIR="$effective_data" "$node" "$INSTALL_DIR/apps/api/dist/runtime.js" --status) || die "Cannot verify the running runtime; nothing was stopped."
    running_hash=$("$node" -p 'JSON.parse(process.argv[1]).build' "$identity")
    [[ $runtime_hash == "$running_hash" ]] && runtime_changed=false
  elif [[ -f $INSTALL_DIR/apps/api/dist/runtime-manifest.json ]] && [[ $("$node" -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).sha256' "$INSTALL_DIR/apps/api/dist/runtime-manifest.json") == "$runtime_hash" ]]; then
    runtime_changed=false
  fi
  if $runtime_changed && [[ -n $previous ]]; then
    # Approval is bound to this exact bundle and expires. Never execute request-file content.
    if $from_dashboard; then
      if "$node" --input-type=module - "$effective_data/runtime/update-approval.json" "$runtime_hash" <<'NODE'
import fs from 'node:fs';
try { const a = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')); process.exit(a.sha256 === process.argv[3] && a.expiresAt > Date.now() && a.expiresAt <= Date.now() + 600000 ? 0 : 1); } catch { process.exit(1); }
NODE
      then allow_runtime_restart=true; fi
    fi
    $allow_runtime_restart || die "This release changes the Minecraft runtime (or migrates a legacy installation). Running game servers must save and stop." "Review the affected servers in the dashboard, or rerun with --allow-runtime-restart during maintenance. Nothing was stopped."
  fi
  rm -f "$effective_data/runtime/update-approval.json"

  # ---- install ----------------------------------------------------------------------------
  step "Installing CraftPanel v$version to $INSTALL_DIR…"
  validate_data_location
  id -u "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
  mkdir -p "$INSTALL_DIR" "$DATA_DIR" "$CONFIG_DIR"
  chown "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR"
  chmod 750 "$DATA_DIR"

  rm -rf "$INSTALL_DIR/apps.new"
  cp -r "$src/apps" "$INSTALL_DIR/apps.new"
  local was_active=false main_enabled=false service_state
  systemctl is-active --quiet craftpanel 2>/dev/null && was_active=true
  service_state=$(systemctl show craftpanel -p ActiveState --value 2>/dev/null || true)
  [[ $service_state == activating || $service_state == reloading ]] && was_active=true
  systemctl is-enabled --quiet craftpanel 2>/dev/null && main_enabled=true
  $was_active && info "Stopping the dashboard; an unchanged runtime and its game servers keep running…"
  stop_confirmed || die "Could not confirm that CraftPanel stopped; no snapshot or replacement was attempted."
  # Snapshot before the new process can run migrations. Keep this outside the service's writable paths.
  local state_dir
  state_dir="$INSTALL_DIR/state-$(date +%s)-$$"
  if ! "$node" "$snapshot_cli" snapshot "$effective_data" "$state_dir"; then
    $was_active && systemctl start craftpanel
    die "Could not create the pre-update database snapshot; nothing was replaced."
  fi
  info "Database recovery point: $state_dir"
  local apps_moved=false new_activated=false
  local update_path_enabled=false update_path_active=false
  systemctl is-enabled --quiet craftpanel-update.path 2>/dev/null && update_path_enabled=true
  systemctl is-active --quiet craftpanel-update.path 2>/dev/null && update_path_active=true
  local -a artifact_paths=("$INSTALL_DIR/README.md" "$INSTALL_DIR/LICENSE" "$INSTALL_DIR/CHANGELOG.md" "$INSTALL_DIR/release.json" "$INSTALL_DIR/install.json" "$INSTALL_DIR/update.sh" "$ENV_FILE" "$UNIT_FILE" "$UPDATE_UNIT" "$UPDATE_PATH_UNIT" "$RUNTIME_UNIT")
  mkdir "$state_dir/startup" || { $was_active && systemctl start craftpanel; die "Could not save startup configuration."; }
  local i
  for i in "${!artifact_paths[@]}"; do
    if [[ -f ${artifact_paths[$i]} && ! -L ${artifact_paths[$i]} ]]; then
      cp -p "${artifact_paths[$i]}" "$state_dir/startup/$i" || { $was_active && systemctl start craftpanel; die "Could not save startup configuration."; }
    elif [[ -e ${artifact_paths[$i]} || -L ${artifact_paths[$i]} ]]; then
      $was_active && systemctl start craftpanel
      die "Startup artifact is not a regular file: ${artifact_paths[$i]}"
    fi
  done
  rollback_transaction() {
    trap - ERR
    set +e
    warn "Installation failed. Restoring the previous database and startup configuration."
    # Restore only the dashboard unit first, so an invalid new ExecStart cannot prevent its stop.
    [[ -f $state_dir/startup/7 ]] && cp -p "$state_dir/startup/7" "$UNIT_FILE"
    systemctl daemon-reload || die "Could not reload service configuration for recovery."
    stop_confirmed || die "Could not confirm that the dashboard stopped; recovery was refused."
    if $runtime_changed && [[ -f $RUNTIME_UNIT ]]; then stop_confirmed craftpanel-runtime || die "Could not stop the failed runtime; recovery was refused."; fi
    # Restore a possibly invalid unit before asking systemd to stop its cgroup. Never start it yet.
    for i in "${!artifact_paths[@]}"; do
      if [[ -f $state_dir/startup/$i ]]; then cp -p "$state_dir/startup/$i" "${artifact_paths[$i]}" || die "Could not restore ${artifact_paths[$i]}";
      else rm -f "${artifact_paths[$i]}" || die "Could not remove ${artifact_paths[$i]}"; fi
    done
    systemctl daemon-reload || die "Could not reload the restored service configuration."
    if [[ -f $RUNTIME_UNIT ]]; then
      if $runtime_enabled; then systemctl enable --quiet craftpanel-runtime; else systemctl disable craftpanel-runtime 2>/dev/null; fi
    fi
    if [[ -f $UNIT_FILE ]]; then
      if $main_enabled; then systemctl enable --quiet craftpanel; else systemctl disable craftpanel 2>/dev/null; fi
    fi
    if $update_path_enabled; then systemctl enable --quiet craftpanel-update.path; else systemctl disable --now craftpanel-update.path 2>/dev/null; fi
    $update_path_active && systemctl start craftpanel-update.path
    if ! stop_confirmed; then
      die "Could not confirm that CraftPanel stopped; database recovery was refused." "Recovery point: $state_dir. Resolve the service stop failure before restoring."
    fi
    "$node" "$snapshot_cli" restore "$effective_data" "$state_dir" ||
      die "Database recovery failed; CraftPanel remains stopped." "Recovery point: $state_dir. Do not restart against an incompatible database."
    if $new_activated && [[ -d $INSTALL_DIR/apps ]]; then mv "$INSTALL_DIR/apps" "$INSTALL_DIR/apps.failed-$(date +%s)-$$" || die "Could not move the failed application aside."; fi
    if $apps_moved; then mv "$INSTALL_DIR/apps.previous" "$INSTALL_DIR/apps" || die "Could not restore the previous application."; fi
    if $runtime_changed; then
      if [[ -f $state_dir/runtime-manifest.json ]]; then
        "$node" "$snapshot_cli" restore-runtime "$effective_data" "$state_dir" || die "Could not restore runtime configuration."
      fi
      $runtime_was_active && systemctl start craftpanel-runtime
    fi
    if [[ -d $INSTALL_DIR/apps && -f $UNIT_FILE ]]; then
      systemctl reset-failed craftpanel 2>/dev/null || true
      if ! $was_active; then
        ROLLED_BACK=true
        die "The update failed; the previous application, database and startup configuration were restored and remain stopped." "Recovery point: $state_dir."
      fi
      systemctl start craftpanel && wait_healthy true || die "The previous version could not restart." "Recovery point: $state_dir; see journalctl -u craftpanel."
      ROLLED_BACK=true
      die "The update failed; the previous application, database and startup configuration are running again." "Recovery point: $state_dir; see journalctl -u craftpanel."
    fi
    die "The installation failed; no previous application was available. The original database was restored." "Recovery point: $state_dir."
  }
  # ERR is inherited by called functions. Rollback covers copy, unit registration, start and readiness failures.
  trap rollback_transaction ERR
  if $runtime_changed; then
    if [[ -f $RUNTIME_UNIT ]]; then
      info "Runtime update: saving and stopping game servers…"
      stop_confirmed craftpanel-runtime
    fi
    "$node" "$snapshot_cli" snapshot-runtime "$effective_data" "$state_dir"
  fi
  write_env_file "$port"
  rm -rf "$INSTALL_DIR/apps.previous"
  if [[ -d $INSTALL_DIR/apps ]]; then mv "$INSTALL_DIR/apps" "$INSTALL_DIR/apps.previous"; apps_moved=true; fi
  mv "$INSTALL_DIR/apps.new" "$INSTALL_DIR/apps"
  new_activated=true
  for f in README.md LICENSE CHANGELOG.md release.json; do cp "$src/$f" "$INSTALL_DIR/$f"; done
  install -m 755 "$src/deploy/install.sh" "$INSTALL_DIR/update.sh"
  if [[ -n $checkout ]]; then
    "$node" --input-type=module - "$checkout" "$INSTALL_DIR/install.json" <<'NODE'
import fs from 'node:fs';
const [checkout, file] = process.argv.slice(2);
const quoted = "'" + checkout.replaceAll("'", "'\\''") + "'";
fs.writeFileSync(file, JSON.stringify({ method: 'linux-service', sourceCheckout: checkout, updateCommand: `cd ${quoted} && ./update.sh` }) + '\n');
NODE
    systemctl disable --now craftpanel-update.path 2>/dev/null || true
    rm -f "$UPDATE_UNIT" "$UPDATE_PATH_UNIT"
  else
    printf '{ "method": "linux-service", "updateCommand": "sudo %s/update.sh",\n  "selfUpdate": { "kind": "systemd", "request": "%s/requested", "log": "%s/update.log", "result": "%s" } }\n' "$INSTALL_DIR" "$UPDATE_DIR" "$LOG_DIR" "$RESULT_FILE" >"$INSTALL_DIR/install.json"
    install_update_units
  fi
  chown -R root:root "$INSTALL_DIR"

  sed "s|^ExecStart=/usr/bin/node |ExecStart=$node |" "$src/deploy/craftpanel.service" >"$UNIT_FILE"
  sed "s|^ExecStart=/usr/bin/node |ExecStart=$node |" "$src/deploy/craftpanel-runtime.service" >"$RUNTIME_UNIT"
  systemctl daemon-reload
  systemctl enable --quiet craftpanel-runtime
  if $runtime_changed || ! $runtime_was_active; then systemctl start craftpanel-runtime; fi
  systemctl enable --quiet craftpanel
  systemctl restart craftpanel

  # ---- check that it came up, roll back otherwise -----------------------------------
  step "Starting…"
  wait_healthy
  trap - ERR
  touch "$state_dir/committed"
  prune_recovery_points

  print_summary "$version" "$previous"
}

stop_confirmed() {
  local service=${1:-craftpanel}
  # systemd owns the entire service cgroup, including startup before control.json exists.
  [[ $(systemctl show "$service" -p LoadState --value 2>/dev/null) == not-found ]] && return 0
  systemctl stop "$service" || return 1
  local service_state pid group
  service_state=$(systemctl show "$service" -p ActiveState --value) || return 1
  pid=$(systemctl show "$service" -p MainPID --value) || return 1
  [[ $pid == 0 && ( $service_state == inactive || $service_state == failed ) ]] || return 1
  group=$(systemctl show "$service" -p ControlGroup --value) || return 1
  if [[ -n $group && $group == /* && $group != *..* && -d /sys/fs/cgroup$group ]]; then
    if find "/sys/fs/cgroup$group" -name cgroup.procs -exec cat {} + | grep -q '[0-9]'; then return 1; fi
  fi
  return 0
}

prune_recovery_points() {
  local kept=0 name
  while IFS= read -r name; do
    [[ -f $INSTALL_DIR/$name/committed && ! -L $INSTALL_DIR/$name ]] || continue
    kept=$((kept + 1))
    # Names come only from this root-owned installation directory; failed recovery points are retained.
    if ((kept > 2)) && [[ $name =~ ^state-[0-9]+-[0-9]+$ ]]; then rm -rf -- "$INSTALL_DIR/$name"; fi
  done < <(find "$INSTALL_DIR" -maxdepth 1 -mindepth 1 -type d -name 'state-*' -printf '%f\n' | sort -r)
}

# Lets the dashboard start updates without giving CraftPanel any extra rights: it may only create
# a file in its own data folder; this root unit then runs update.sh, which verifies the release.
install_update_units() {
  install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 750 "$UPDATE_DIR"
  install -d -o root -g "$SERVICE_USER" -m 750 "$LOG_DIR"
  cat >"$UPDATE_UNIT" <<EOF
# Installed by the CraftPanel installer. Runs an update that was requested from the dashboard.
[Unit]
Description=CraftPanel update (requested from the dashboard)

[Service]
Type=oneshot
ExecStart=$INSTALL_DIR/update.sh --from-dashboard
Environment=NO_COLOR=1
EnvironmentFile=-$ENV_FILE
StandardOutput=truncate:$LOG_DIR/update.log
StandardError=inherit
TimeoutStartSec=30min
EOF
  cat >"$UPDATE_PATH_UNIT" <<EOF
# Installed by the CraftPanel installer. Starts craftpanel-update.service when the dashboard asks for an update.
[Unit]
Description=Watch for CraftPanel update requests

[Path]
PathExists=$UPDATE_DIR/requested
Unit=craftpanel-update.service

[Install]
WantedBy=paths.target
EOF
  systemctl daemon-reload
  systemctl enable --quiet craftpanel-update.path
  systemctl start craftpanel-update.path
}

verify_checksum() {
  local file=$1 sums=$2 name expected actual
  name=$(basename "$file")
  expected=$(awk -v f="$name" '$2 == f || $2 == "*" f { print $1 }' "$sums")
  [[ -n $expected ]] || die "$name is not listed in SHA256SUMS."
  actual=$(sha256sum "$file" | awk '{ print $1 }')
  [[ $expected == "$actual" ]] || die "Checksum mismatch for $name." "The download is damaged or was tampered with. Nothing was installed."
  info "Checksum verified."
}

node_ok() {
  # node_ok <node binary>: true if it runs and is at least NODE_MIN.
  "$1" -e "const [a,b]=process.versions.node.split('.').map(Number);const [x,y]='$NODE_MIN'.split('.').map(Number);process.exit(a>x||(a===x&&b>=y)?0:1)" 2>/dev/null
}

# Prints the path of a Node.js the service can use; downloads one into $INSTALL_DIR/node if needed.
ensure_node() {
  local sys
  sys=$(command -v node 2>/dev/null || true)
  if [[ -n $sys ]]; then
    sys=$(readlink -f "$sys")
    # The hardened service cannot read home directories (nvm, fnm, …).
    if [[ $sys != /home/* && $sys != /root/* ]] && node_ok "$sys"; then
      echo "$sys"
      return
    fi
  fi
  local private=$INSTALL_DIR/node/bin/node
  if [[ -x $private ]] && node_ok "$private"; then
    echo "$private"
    return
  fi

  local arch
  case $(uname -m) in
    x86_64 | amd64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    armv7l | armv8l) arch=armv7l ;;
    *) die "Unsupported CPU: $(uname -m)." "CraftPanel needs x64, ARM64 or ARMv7 (Raspberry Pi 2 or newer)." ;;
  esac
  local major name="" sums
  for major in $NODE_MAJORS; do
    sums=$(curl -fsSL "https://nodejs.org/dist/latest-v$major.x/SHASUMS256.txt" 2>/dev/null) || continue
    name=$(awk -v a="linux-$arch.tar.gz" '$2 ~ "^node-v[0-9.]+-" a "$" { print $2; exit }' <<<"$sums")
    [[ -n $name ]] && break
  done
  [[ -n $name ]] || die "No Node.js build found for linux-$arch." "Install Node.js $NODE_MIN or newer system-wide (https://nodejs.org) and run this again."
  info "Downloading $name from nodejs.org…" >&2
  curl -fsSL --retry 3 -o "$TMP/$name" "https://nodejs.org/dist/latest-v$major.x/$name" || die "Could not download Node.js."
  local expected
  expected=$(awk -v f="$name" '$2 == f { print $1 }' <<<"$sums")
  [[ $(sha256sum "$TMP/$name" | awk '{ print $1 }') == "$expected" ]] || die "Checksum mismatch for $name."
  rm -rf "$INSTALL_DIR/node.new"
  mkdir -p "$INSTALL_DIR/node.new"
  tar -xzf "$TMP/$name" -C "$INSTALL_DIR/node.new" --strip-components=1
  node_ok "$INSTALL_DIR/node.new/bin/node" || die "The downloaded Node.js does not run on this system." "Install Node.js $NODE_MIN or newer from your distribution or https://nodejs.org and run this again."
  rm -rf "$INSTALL_DIR/node"
  mv "$INSTALL_DIR/node.new" "$INSTALL_DIR/node"
  echo "$private"
}

write_env_file() {
  local port=$1
  if [[ ! -f $ENV_FILE ]]; then
    cat >"$ENV_FILE" <<EOF
# CraftPanel service settings. Kept on updates; apply changes with: sudo systemctl restart craftpanel
# All options: https://github.com/$REPO/blob/main/docs/deployment/README.md

# lan: dashboard reachable from your network (allowed networks: Settings → Remote access)
# local: this machine only (use an SSH tunnel), proxy: behind an HTTPS reverse proxy on this machine
CRAFTPANEL_PROFILE=lan
CRAFTPANEL_PORT=${port:-8080}

# Built-in HTTPS (certificate and key must be readable by the craftpanel user):
#CRAFTPANEL_TLS_CERT=/etc/craftpanel/cert.pem
#CRAFTPANEL_TLS_KEY=/etc/craftpanel/key.pem

# Don't look up new releases on GitHub:
#CRAFTPANEL_UPDATE_CHECK=false
EOF
    chmod 644 "$ENV_FILE"
  elif [[ -n $port ]]; then
    if grep -q '^CRAFTPANEL_PORT=' "$ENV_FILE"; then sed -i "s/^CRAFTPANEL_PORT=.*/CRAFTPANEL_PORT=$port/" "$ENV_FILE"; else echo "CRAFTPANEL_PORT=$port" >>"$ENV_FILE"; fi
  fi
}

# Reads a value from the env file (without executing it).
env_value() {
  [[ -f $ENV_FILE ]] || return 0
  sed -n "s/^$1=//p" "$ENV_FILE" | tail -1 | tr -d '"'"'"
}

validate_data_location() {
  local effective resolved_install
  effective=$(env_value CRAFTPANEL_DATA_DIR)
  effective=$(realpath -m "${effective:-$DATA_DIR}")
  resolved_install=$(realpath -m "$INSTALL_DIR")
  if [[ $effective == "$resolved_install" || $effective == "$resolved_install/"* || $resolved_install == "$effective/"* ]]; then
    die "Install and data directories must be separate, non-overlapping directories." "Move server data out of the installation directory before updating or uninstalling."
  fi
}

dashboard_port() {
  local p
  p=$(env_value CRAFTPANEL_PORT)
  echo "${p:-8080}"
}

wait_healthy() {
  local port scheme=http host legacy=${1:-false} status deadline=$((SECONDS + 60))
  port=$(dashboard_port)
  [[ -n $(env_value CRAFTPANEL_TLS_CERT) ]] && scheme=https
  host=$(env_value CRAFTPANEL_HOST)
  [[ -z $host || $host == 0.0.0.0 || $host == :: ]] && host=127.0.0.1
  [[ $host == *:* && $host != \[*\] ]] && host="[$host]"
  # systemd keeps counting restarts across starts; only restarts during this wait count.
  local restarts
  restarts=$(systemctl show craftpanel -p NRestarts --value 2>/dev/null || echo 0)
  for _ in $(seq 1 60); do
    status=$(curl -sk --noproxy '*' -o /dev/null -w '%{http_code}' --max-time 2 "$scheme://$host:$port/api/ready") || status=000
    [[ $status == 200 ]] && return 0
    # Only the previous version may predate readiness checks. Never mask a new version's 503.
    if [[ $legacy == true && $status == 404 ]]; then
      curl -fsk --noproxy '*' -o /dev/null --max-time 2 "$scheme://$host:$port/api/health" && return 0
    fi
    ((SECONDS >= deadline)) && return 1
    # Crash loop: systemd keeps restarting it (Restart=on-failure), so don't wait the full minute.
    systemctl is-failed --quiet craftpanel && return 1
    (($(systemctl show craftpanel -p NRestarts --value 2>/dev/null || echo 0) - ${restarts:-0} >= 2)) && return 1
    sleep 1
  done
  return 1
}

# The release notes of the installed version, from its CHANGELOG.md.
print_whats_new() {
  local notes
  notes=$(awk -v v="$1" '/^## / { if (found) exit; split(substr($0, 4), w, " "); if (w[1] == v) { found = 1; next } } found' "$INSTALL_DIR/CHANGELOG.md" 2>/dev/null | sed '/^[[:space:]]*$/d' | head -20)
  [[ -n $notes ]] || return 0
  echo
  echo "  ${B}What's new${N}"
  sed 's/^### \(.*\)/  \1/; s/^- /    • /' <<<"$notes"
}

print_summary() {
  local version=$1 previous=$2 port scheme=http
  port=$(dashboard_port)
  [[ -n $(env_value CRAFTPANEL_TLS_CERT) ]] && scheme=https
  echo
  if [[ -n $previous && $previous != "$version" ]]; then
    echo "${G}✔${N} ${B}CraftPanel updated: v$previous → v$version${N}"
    info "Dashboard-only updates keep Minecraft running. Runtime changes require explicit maintenance approval."
    print_whats_new "$version"
  elif [[ -n $previous ]]; then
    echo "${G}✔${N} ${B}CraftPanel v$version reinstalled${N}"
  else
    echo "${G}✔${N} ${B}CraftPanel v$version is installed and running${N}"
  fi
  echo
  local profile ip
  profile=$(env_value CRAFTPANEL_PROFILE)
  if [[ ${profile:-lan} == lan ]]; then
    for ip in $(hostname -I 2>/dev/null); do
      [[ $ip == *:* || $ip == 172.17.* ]] && continue
      info "Dashboard  ${B}$scheme://$ip:$port${N}"
    done
  fi
  info "On this machine  $scheme://127.0.0.1:$port"
  sleep 1
  if [[ -f $DATA_DIR/setup-token.txt ]]; then
    echo
    info "Setup token  ${B}$(cat "$DATA_DIR/setup-token.txt")${N}  ${D}(needed once to create the owner account)${N}"
  fi
  echo
  info "${D}Update:   sudo $INSTALL_DIR/update.sh${N}"
  info "${D}Logs:     sudo journalctl -u craftpanel -f${N}"
  info "${D}Settings: $ENV_FILE${N}"
  if grep -q "^ExecStart=$INSTALL_DIR/node/bin/node " "$UNIT_FILE"; then
    info "${D}Node.js:  $INSTALL_DIR/node (private copy for CraftPanel)${N}"
  fi
}

do_uninstall() {
  step "Removing CraftPanel…"
  validate_data_location
  if systemctl list-unit-files craftpanel.service >/dev/null 2>&1; then
    stop_confirmed || die "CraftPanel is still running; uninstall was refused."
    systemctl disable craftpanel 2>/dev/null || true
  fi
  systemctl disable --now craftpanel-update.path 2>/dev/null || true
  if [[ -f $RUNTIME_UNIT ]]; then
    stop_confirmed craftpanel-runtime || die "The runtime is still running; uninstall was refused."
    systemctl disable craftpanel-runtime 2>/dev/null || true
  fi
  rm -f "$UNIT_FILE" "$UPDATE_UNIT" "$UPDATE_PATH_UNIT" "$RUNTIME_UNIT"
  systemctl daemon-reload
  rm -rf "$INSTALL_DIR"
  echo "${G}✔${N} CraftPanel was removed. Your data was kept:"
  info "$DATA_DIR  (servers, worlds, backups, accounts)"
  info "$CONFIG_DIR  (service settings)"
  info "${D}Delete them too with: sudo rm -rf $DATA_DIR $CONFIG_DIR && sudo userdel $SERVICE_USER${N}"
}

main "$@"
