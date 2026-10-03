#!/bin/sh
# Fail closed: let native Electron enforce its sandbox and report startup errors.
set -eu
if [ -n "${APPDIR:-}" ]; then
  app_dir=$APPDIR
else
  app_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
fi
exec "$app_dir/database-workspace" "$@"
