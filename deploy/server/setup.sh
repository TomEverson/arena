#!/bin/sh
# Runs ON THE DROPLET (deploy.sh copies it there and runs it). Safe to run again: the first run
# installs Caddy and creates the service, later runs only swap the new files in and restart.
# Expects Ubuntu or Debian, and the upload in the directory this script is in.
set -eu

SUDO=""
[ "$(id -u)" -eq 0 ] || SUDO="sudo"
IN="$(cd "$(dirname "$0")" && pwd)"

if ! command -v caddy >/dev/null 2>&1; then
  echo "==> installing Caddy"
  $SUDO apt-get update -qq
  $SUDO apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl gnupg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' |
    $SUDO gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' |
    $SUDO tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  $SUDO apt-get update -qq
  $SUDO apt-get install -y -qq caddy
fi

id arena >/dev/null 2>&1 || $SUDO useradd --system --home /opt/arena --shell /usr/sbin/nologin arena
$SUDO install -d -o arena -g arena /opt/arena /opt/arena/levels

echo "==> installing the server"
# install replaces the binary in one step, so a running server is never left with half a file.
$SUDO install -m 755 -o arena -g arena "$IN/arena-server" /opt/arena/arena-server
$SUDO install -m 644 -o arena -g arena "$IN"/levels/*.json /opt/arena/levels/
$SUDO install -m 640 -o arena -g arena "$IN/arena.env" /opt/arena/arena.env
$SUDO install -m 644 "$IN/arena.service" "$IN/arena-cert.path" "$IN/arena-cert.service" /etc/systemd/system/
$SUDO install -m 644 "$IN/Caddyfile" /etc/caddy/Caddyfile

# QUIC (the game's transport) wants bigger UDP buffers than the default.
printf 'net.core.rmem_max=7500000\nnet.core.wmem_max=7500000\n' | $SUDO tee /etc/sysctl.d/90-arena-quic.conf >/dev/null
$SUDO sysctl -q --system

# The firewall, if ufw is on: ssh, and the web ports Caddy needs (80 for the certificate, 443 to play).
if command -v ufw >/dev/null 2>&1 && $SUDO ufw status | grep -q "Status: active"; then
  $SUDO ufw allow OpenSSH >/dev/null
  $SUDO ufw allow 80/tcp >/dev/null
  $SUDO ufw allow 443/tcp >/dev/null
  $SUDO ufw allow 443/udp >/dev/null
fi

$SUDO systemctl daemon-reload
# Caddy first, restarted so it lets go of UDP port 443, which is the game server's. Caddy also
# has to have the certificate before the game server can start with it: on a brand new droplet
# that takes a moment.
$SUDO systemctl enable caddy >/dev/null 2>&1
$SUDO systemctl restart caddy
CERT="$(sed -n 's/^LoadCredential=cert://p' "$IN/arena.service")"
for _ in $(seq 1 60); do
  $SUDO test -s "$CERT" && break
  sleep 2
done
if ! $SUDO test -s "$CERT"; then
  echo "Caddy has no certificate yet ($CERT): check that the game host name points at this machine and ports 80 and 443 are open, see 'journalctl -u caddy -n 50'" >&2
  exit 1
fi
$SUDO systemctl enable arena arena-cert.path >/dev/null 2>&1
$SUDO systemctl restart arena
$SUDO systemctl restart arena-cert.path

echo "==> checking the server answers on this machine"
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS http://127.0.0.1:8080/healthz && curl -fsS http://127.0.0.1:8080/api/transport; then
    echo
    echo "==> done"
    exit 0
  fi
  sleep 1
done
echo "the server did not answer: see 'journalctl -u arena -n 50'" >&2
exit 1
