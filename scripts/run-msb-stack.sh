#!/usr/bin/env bash
# Launch the MSB-BAT gateway (Express) + internal FastAPI on the Genspark sandbox.
#
# The AI provider is chosen EXPLICITLY here (no silent switch):
#   MSB_AI_PROVIDER=genspark  -> Claude through the Genspark Anthropic proxy
#   MSB_AI_PROVIDER=anthropic -> direct Claude (default of ai_client.py)
#
# Usage:
#   scripts/run-msb-stack.sh [production|development]   (default: production)
set -euo pipefail

TARGET="${1:-production}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

case "$TARGET" in
  production)  DB="msb_production" ;;
  development) DB="msb_development" ;;
  *) echo "usage: run-msb-stack.sh [production|development]" >&2; exit 2 ;;
esac

export DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:5432/${DB}"
export MSB_PRIVATE_STORAGE_DIR="${MSB_PRIVATE_STORAGE_DIR:-$ROOT/msb-data/private}"
export MSB_STORAGE_BACKEND="${MSB_STORAGE_BACKEND:-local}"
export MSB_AI_PROVIDER="${MSB_AI_PROVIDER:-genspark}"   # explicit, default here = Genspark
export PORT="${PORT:-5000}"
export MSB_FASTAPI_PORT="${MSB_FASTAPI_PORT:-8091}"
export NODE_ENV="${NODE_ENV:-development}"
export PATH="$ROOT/.venv/bin:$PATH"

# Free the ports if a previous run is still holding them.
for port in "$PORT" "$MSB_FASTAPI_PORT"; do
  pid="$(lsof -ti:"$port" 2>/dev/null || true)"
  [ -n "$pid" ] && kill -9 "$pid" 2>/dev/null || true
done
sleep 1

cd "$ROOT/artifacts/api-server"
nohup node --enable-source-maps ./dist/index.mjs > "/tmp/express_${TARGET}.log" 2>&1 &
echo "started gateway pid $! (db=$DB, ai=$MSB_AI_PROVIDER)"

for _ in $(seq 1 30); do
  if curl -sf -m 2 "http://127.0.0.1:${PORT}/api/healthz" >/dev/null 2>&1; then
    echo "healthz: $(curl -s "http://127.0.0.1:${PORT}/api/healthz")"
    exit 0
  fi
  sleep 1
done
echo "gateway did not become healthy; see /tmp/express_${TARGET}.log" >&2
exit 1
