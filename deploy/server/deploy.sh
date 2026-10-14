#!/bin/sh
# Build the game server for the droplet and install it there. Run from anywhere:
#   pnpm deploy:server
# Settings come from deploy/.env (see deploy/env.example). The first run also sets the droplet
# up (Caddy for the certificate, a service that restarts the server). A deploy restarts the
# server: rooms that are running end.
set -eu
cd "$(dirname "$0")/../.."
[ -f deploy/.env ] && . deploy/.env
: "${DROPLET:?set DROPLET in deploy/.env (see deploy/env.example)}"
: "${GAME_HOST:?set GAME_HOST in deploy/.env}"
: "${SITE_HOSTS:?set SITE_HOSTS in deploy/.env}"
ARCH="${DROPLET_ARCH:-amd64}"

out=deploy/.out
rm -rf "$out"
mkdir -p "$out/levels"

echo "==> building the server for linux/$ARCH"
(cd server && CGO_ENABLED=0 GOOS=linux GOARCH="$ARCH" go build -trimpath -ldflags="-s -w" -o "../$out/arena-server" ./cmd/server)
cp levels/*.json "$out/levels/"
sed "s/{{GAME_HOST}}/$GAME_HOST/" deploy/server/Caddyfile.template >"$out/Caddyfile"
printf 'ALLOWED_ORIGINS=%s\n' "$SITE_HOSTS" >"$out/arena.env"
sed "s/{{GAME_HOST}}/$GAME_HOST/g" deploy/server/arena.service >"$out/arena.service"
sed "s/{{GAME_HOST}}/$GAME_HOST/g" deploy/server/arena-cert.path >"$out/arena-cert.path"
cp deploy/server/arena-cert.service deploy/server/setup.sh "$out/"

echo "==> copying to $DROPLET"
ssh "$DROPLET" 'mkdir -p ~/arena-incoming'
rsync -az --delete "$out/" "$DROPLET:arena-incoming/"

echo "==> installing on the droplet"
ssh "$DROPLET" 'sh ~/arena-incoming/setup.sh'

echo "==> checking https://$GAME_HOST/healthz from here"
if curl -fsS --max-time 20 "https://$GAME_HOST/healthz"; then
  echo
  echo "The server is up at https://$GAME_HOST"
else
  echo
  echo "The server runs on the droplet, but https://$GAME_HOST did not answer from here." >&2
  echo "Check that $GAME_HOST points at the droplet (DNS only, not proxied) and that ports 80 and 443 are open." >&2
  echo "A brand new certificate can take a minute: try 'curl https://$GAME_HOST/healthz' again." >&2
  exit 1
fi
