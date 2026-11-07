#!/usr/bin/env bash
# Installs CraftPanel as a systemd service on Linux (x64 or arm64, e.g. Raspberry Pi 4/5).
# Run from the cloned repository:  sudo ./deploy/install-linux.sh
set -euo pipefail

INSTALL_DIR=/opt/craftpanel
DATA_DIR=/var/lib/craftpanel
SERVICE_USER=craftpanel

if [[ $EUID -ne 0 ]]; then echo "Run with sudo." >&2; exit 1; fi
command -v node >/dev/null || { echo "Node.js 22.13+ is required (https://nodejs.org or your package manager)." >&2; exit 1; }
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if (( NODE_MAJOR < 22 )); then echo "Node.js 22.13+ is required, found $(node -v)." >&2; exit 1; fi

REPO_DIR=$(cd "$(dirname "$0")/.." && pwd)
id -u "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
mkdir -p "$INSTALL_DIR" "$DATA_DIR"

echo "Building CraftPanel…"
cd "$REPO_DIR"
corepack enable >/dev/null 2>&1 || npm install -g pnpm
pnpm install --frozen-lockfile
pnpm build

echo "Installing to $INSTALL_DIR…"
rm -rf "$INSTALL_DIR/apps"
mkdir -p "$INSTALL_DIR/apps/api"
cp -r apps/api/dist "$INSTALL_DIR/apps/api/dist"
chown -R root:root "$INSTALL_DIR"
chown -R "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR"
chmod 750 "$DATA_DIR"

cp deploy/craftpanel.service /etc/systemd/system/craftpanel.service
systemctl daemon-reload
systemctl enable --now craftpanel

IP=$(hostname -I 2>/dev/null | awk '{print $1}')
echo
echo "CraftPanel is running: http://${IP:-<this-machine>}:8080"
echo "First-run setup token (needed to create the owner account):"
sleep 3
cat "$DATA_DIR/setup-token.txt" 2>/dev/null || journalctl -u craftpanel --no-pager | grep -i "setup token" | tail -1
