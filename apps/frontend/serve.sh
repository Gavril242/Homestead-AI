#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
PORT=${1:-8765}
echo "Gavirila Homestead → http://localhost:$PORT"
exec python3 -m http.server "$PORT"
