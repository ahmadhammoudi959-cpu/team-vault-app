#!/usr/bin/env bash
# Starts a fresh server on a throwaway database and runs the browser test against it.
set -euo pipefail
cd "$(dirname "$0")/.."
DB_ADMIN=${DB_ADMIN:-postgres://postgres@127.0.0.1:5433/postgres}
DB=${DB:-postgres://postgres@127.0.0.1:5433/vault_e2e}
PORT=${PORT:-3333}
SHOTS=${SHOTS:-/tmp/vault-shots}
mkdir -p "$SHOTS"
psql "$DB_ADMIN" -q -c "DROP DATABASE IF EXISTS vault_e2e" -c "CREATE DATABASE vault_e2e"
export MASTER_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
MOCK_PORT=$((PORT + 1))
node test/mock_apis.mjs $MOCK_PORT h-e2e-token r-e2e-token > /tmp/vault-e2e-mock.log 2>&1 &
MOCK=$!
DATABASE_URL=$DB PORT=$PORT PUBLIC_URL=http://localhost:$PORT \
  HOSTINGER_API_TOKEN=h-e2e-token RENDER_API_KEY=r-e2e-token \
  HOSTINGER_API_BASE=http://127.0.0.1:$MOCK_PORT RENDER_API_BASE=http://127.0.0.1:$MOCK_PORT/v1 \
  node server.js > /tmp/vault-e2e-server.log 2>&1 &
SERVER=$!
trap 'kill $SERVER $MOCK 2>/dev/null || true' EXIT
for i in $(seq 1 50); do grep -q listening /tmp/vault-e2e-server.log && break; sleep 0.2; done
TOKEN=$(grep -oE '/setup/[A-Za-z0-9_-]{32}' /tmp/vault-e2e-server.log | head -1 | cut -d/ -f3)
python3 test/e2e_browser.py "http://localhost:$PORT" "$TOKEN" "$SHOTS"
