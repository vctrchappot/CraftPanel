#!/usr/bin/env bash
# Build a git checkout as its owner, then use the same transactional installer as release packages.
# Run from the cloned repository: sudo ./deploy/install-linux.sh
set -euo pipefail

if [[ $EUID -ne 0 ]]; then echo "Run with sudo." >&2; exit 1; fi
command -v node >/dev/null || { echo "Node.js 22.13+ is required." >&2; exit 1; }
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22 || (a===22 && b>=13) ? 0 : 1)' || { echo "Node.js 22.13+ is required." >&2; exit 1; }
REPO_DIR=$(cd "$(dirname "$0")/.." && pwd)
NODE_BIN=$(readlink -f "$(command -v node)")
case "$NODE_BIN" in
  /home/*|/root/*) echo "Install Node.js system-wide; the hardened service cannot read home directories." >&2; exit 1 ;;
esac
cd "$REPO_DIR"
command -v pnpm >/dev/null || corepack enable >/dev/null 2>&1 || npm install -g pnpm
BUILD_USER=$(stat -c %U "$REPO_DIR")
if [[ $BUILD_USER == root ]]; then
  pnpm install --frozen-lockfile
  pnpm build
  node scripts/release.mjs pack
else
  # Keep dependencies and build artifacts owned by the checkout's owner, not root.
  sudo -u "$BUILD_USER" -H env "PATH=$PATH" pnpm install --frozen-lockfile
  sudo -u "$BUILD_USER" -H env "PATH=$PATH" pnpm build
  sudo -u "$BUILD_USER" -H env "PATH=$PATH" node scripts/release.mjs pack
fi
VERSION=$(node -p 'require("./package.json").version')
exec bash "$REPO_DIR/deploy/install.sh" --archive "$REPO_DIR/release/craftpanel-v$VERSION.tar.gz" --checkout "$REPO_DIR"
