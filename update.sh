#!/usr/bin/env sh
# Updates CraftPanel to the newest version. See scripts/update.mjs.
exec node "$(dirname "$0")/scripts/update.mjs" "$@"
