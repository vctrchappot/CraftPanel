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
set -euo pipefail

REPO=vctrchappot/CraftPanel
INSTALL_DIR=/opt/craftpanel
DATA_DIR=/var/lib/craftpanel
CONFIG_DIR=/etc/craftpanel
ENV_FILE=$CONFIG_DIR/craftpanel.env
UNIT_FILE=/etc/systemd/system/craftpanel.service
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
  local version=${CRAFTPANEL_INSTALL_VERSION:-} archive=${CRAFTPANEL_ARCHIVE:-} port=${CRAFTPANEL_PORT:-} uninstall=false from_dashboard=false
  while (($#)); do
    case $1 in
      --version) version=${2:?--version needs a value}; shift 2 ;;
      --archive) archive=${2:?--archive needs a file}; shift 2 ;;
      --port) port=${2:?--port needs a value}; shift 2 ;;
      --uninstall) uninstall=true; shift ;;
      --from-dashboard) from_dashboard=true; shift ;;
      -h | --help) sed -n '2,23p' "$0" 2>/dev/null || echo "See https://github.com/$REPO#install"; exit 0 ;;
      *) die "Unknown option: $1" "Options: --version X.Y.Z, --archive FILE, --port N, --uninstall" ;;
    esac
  done
  version=${version#v}

  [[ $(uname -s) == Linux ]] || die "This installer is for Linux." "On Windows use install.ps1; on macOS see the README."
  [[ $EUID -eq 0 ]] || die "Please run it with sudo." "curl -fsSL https://github.com/$REPO/releases/latest/download/install.sh | sudo bash"
  [[ -d /run/systemd/system ]] || die "systemd is not running on this machine." "CraftPanel installs as a systemd service. Without systemd, download the release and start it with: node apps/api/dist/index.js --profile lan"
  if [[ -n $port ]] && { [[ ! $port =~ ^[0-9]+$ ]] || ((port < 1 || port > 65535)); }; then die "Invalid port: $port"; fi

  if $uninstall; then
    do_uninstall
    return
  fi

  if $from_dashboard; then
    # The request file lives in CraftPanel's own data folder: remove it (never follow it) and ignore its content.
    rm -rf "$UPDATE_DIR/requested"
    trap 'write_result $?' EXIT
    version="" archive="" port=""
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

  # ---- install ----------------------------------------------------------------------------
  step "Installing CraftPanel v$version to $INSTALL_DIR…"
  id -u "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
  mkdir -p "$INSTALL_DIR" "$DATA_DIR" "$CONFIG_DIR"
  chown "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR"
  chmod 750 "$DATA_DIR"
  write_env_file "$port"

  rm -rf "$INSTALL_DIR/apps.new"
  cp -r "$src/apps" "$INSTALL_DIR/apps.new"
  local was_active=false
  systemctl is-active --quiet craftpanel 2>/dev/null && was_active=true
  if $was_active; then
    info "Stopping CraftPanel (running Minecraft servers are saved and stopped)…"
    systemctl stop craftpanel
  fi
  rm -rf "$INSTALL_DIR/apps.previous"
  [[ -d $INSTALL_DIR/apps ]] && mv "$INSTALL_DIR/apps" "$INSTALL_DIR/apps.previous"
  [[ -f $INSTALL_DIR/release.json ]] && cp "$INSTALL_DIR/release.json" "$INSTALL_DIR/apps.previous.release.json"
  mv "$INSTALL_DIR/apps.new" "$INSTALL_DIR/apps"
  for f in README.md LICENSE CHANGELOG.md release.json; do cp "$src/$f" "$INSTALL_DIR/$f"; done
  install -m 755 "$src/deploy/install.sh" "$INSTALL_DIR/update.sh"
  printf '{ "method": "linux-service", "updateCommand": "sudo %s/update.sh",\n  "selfUpdate": { "kind": "systemd", "request": "%s/requested", "log": "%s/update.log", "result": "%s" } }\n' "$INSTALL_DIR" "$UPDATE_DIR" "$LOG_DIR" "$RESULT_FILE" >"$INSTALL_DIR/install.json"
  install_update_units
  chown -R root:root "$INSTALL_DIR"

  sed "s|^ExecStart=/usr/bin/node |ExecStart=$node |" "$src/deploy/craftpanel.service" >"$UNIT_FILE"
  systemctl daemon-reload
  systemctl enable --quiet craftpanel
  systemctl restart craftpanel

  # ---- check that it came up, roll back otherwise -----------------------------------
  step "Starting…"
  if ! wait_healthy; then
    if [[ -d $INSTALL_DIR/apps.previous ]]; then
      warn "CraftPanel v$version did not start. Going back to the previous version${previous:+ (v$previous)}."
      systemctl stop craftpanel || true
      rm -rf "$INSTALL_DIR/apps.failed"
      mv "$INSTALL_DIR/apps" "$INSTALL_DIR/apps.failed"
      mv "$INSTALL_DIR/apps.previous" "$INSTALL_DIR/apps"
      [[ -f $INSTALL_DIR/apps.previous.release.json ]] && mv "$INSTALL_DIR/apps.previous.release.json" "$INSTALL_DIR/release.json"
      systemctl reset-failed craftpanel 2>/dev/null || true
      systemctl start craftpanel || true
      if wait_healthy; then
        ROLLED_BACK=true
        die "CraftPanel v$version did not start; the previous version${previous:+ (v$previous)} is running again." "See what went wrong: sudo journalctl -u craftpanel -n 80 --no-pager"
      fi
    fi
    die "CraftPanel did not start." "See what happened: sudo journalctl -u craftpanel -n 50 --no-pager"
  fi
  rm -f "$INSTALL_DIR/apps.previous.release.json"

  print_summary "$version" "$previous"
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
  sed -n "s/^$1=//p" "$ENV_FILE" | tail -1 | tr -d '"'"'"
}

dashboard_port() {
  local p
  p=$(env_value CRAFTPANEL_PORT)
  echo "${p:-8080}"
}

wait_healthy() {
  local port scheme=http host
  port=$(dashboard_port)
  [[ -n $(env_value CRAFTPANEL_TLS_CERT) ]] && scheme=https
  host=$(env_value CRAFTPANEL_HOST)
  [[ -z $host || $host == 0.0.0.0 || $host == :: ]] && host=127.0.0.1
  # systemd keeps counting restarts across starts; only restarts during this wait count.
  local restarts
  restarts=$(systemctl show craftpanel -p NRestarts --value 2>/dev/null || echo 0)
  for _ in $(seq 1 60); do
    curl -fsk -o /dev/null --max-time 2 "$scheme://$host:$port/api/health" && return 0
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
    info "Running Minecraft servers were stopped gracefully; servers with \"Start with CraftPanel\" are back up."
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
  if systemctl list-unit-files craftpanel.service >/dev/null 2>&1; then
    systemctl disable --now craftpanel 2>/dev/null || true
  fi
  systemctl disable --now craftpanel-update.path 2>/dev/null || true
  rm -f "$UNIT_FILE" "$UPDATE_UNIT" "$UPDATE_PATH_UNIT"
  systemctl daemon-reload
  rm -rf "$INSTALL_DIR"
  echo "${G}✔${N} CraftPanel was removed. Your data was kept:"
  info "$DATA_DIR  (servers, worlds, backups, accounts)"
  info "$CONFIG_DIR  (service settings)"
  info "${D}Delete them too with: sudo rm -rf $DATA_DIR $CONFIG_DIR && sudo userdel $SERVICE_USER${N}"
}

main "$@"
