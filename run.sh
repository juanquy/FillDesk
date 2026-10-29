#!/usr/bin/env bash
# Start the FillDesk server (dashboard + extension API).
set -euo pipefail
cd "$(dirname "$0")"
exec python3 -m server "$@"
