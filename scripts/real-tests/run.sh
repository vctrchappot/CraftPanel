#!/usr/bin/env bash
# Run a scenario against a fresh, throwaway CraftPanel instance built from this checkout.
#   scripts/real-tests/run.sh <port> <data-dir> <scenario.mjs> [scenario args...]
# The API runs from a copy of apps/api/dist (run `pnpm build` first) on 127.0.0.1:<port> with its own data dir,
# the scenario gets http://127.0.0.1:<port> as its first argument, and the API is stopped afterwards.
# Keep data dirs out of real installs; set KEEP_DATA=1 to reuse one between runs.
# In WSL, run the whole thing inside ONE `wsl -d <distro> -- bash …` call: WSL kills background processes when the
# call that started them returns, and keep the distro alive with a separate `wsl -d <distro> -- sleep infinity`.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
port=$1 data=$2 scenario=$3
shift 3
dist="${TMPDIR:-/tmp}/craftpanel-dist-$port"
rm -rf "$dist" && cp -r "$repo/apps/api/dist" "$dist"
[[ ${KEEP_DATA:-} ]] || rm -rf "$data"
mkdir -p "$data"
CRAFTPANEL_PORT=$port CRAFTPANEL_HOST=127.0.0.1 CRAFTPANEL_DATA_DIR=$data CRAFTPANEL_UPDATE_CHECK=false node "$dist/index.js" >"$data.api.log" 2>&1 &
api=$!
trap 'kill $api 2>/dev/null; wait $api 2>/dev/null; rm -rf "$dist"' EXIT
for _ in $(seq 1 60); do curl -fsS -o /dev/null "http://127.0.0.1:$port/api/health" 2>/dev/null && break; sleep 1; done
node "$here/$scenario" "http://127.0.0.1:$port" "$@"
