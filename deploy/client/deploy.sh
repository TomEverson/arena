#!/bin/sh
# Build the client to talk to the deployed game server and publish it as a Cloudflare Worker
# (static files only). Run from anywhere:
#   pnpm deploy:client
# Needs GAME_HOST in deploy/.env and wrangler logged in (`wrangler login`). The Worker's name and
# settings are in client/wrangler.jsonc.
set -eu
cd "$(dirname "$0")/../.."
[ -f deploy/.env ] && . deploy/.env
: "${GAME_HOST:?set GAME_HOST in deploy/.env (see deploy/env.example)}"

echo "==> building the client for https://$GAME_HOST"
VITE_SERVER_URL="https://$GAME_HOST" pnpm --filter @arena/client build

cd client
if command -v wrangler >/dev/null 2>&1; then
  wrangler deploy "$@"
else
  npx --yes wrangler@4 deploy "$@"
fi
