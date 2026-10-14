# Deploying

The client is static files on **Cloudflare Workers**; the game server is one Go program on a
**DigitalOcean droplet**. They are on different hosts, so the client is built knowing the
server's address and the server is told which sites may talk to it.

```text
Browser ── https ──────────> Cloudflare Worker "arena"            (the page: HTML, JS, models)
   │
   ├── https (TCP 443) ────> Caddy ──> arena-server 127.0.0.1:8080  (the room API)       ┐ the
   └── WebTransport (UDP 443) ───────> arena-server :443            (the game itself)    ┘ droplet
```

The browser talks to the droplet directly (not through Cloudflare), so game traffic takes the
shortest path. The game itself is WebTransport: QUIC over UDP port 443, straight into the game
server. Caddy keeps TCP 443: it gets and renews the certificate, and passes the small HTTP API
through. Both use the same certificate and host name.

## Settings: `deploy/.env`

Copy `deploy/env.example` to `deploy/.env` (git-ignored) and fill it in.

| Setting | What it is |
|---|---|
| `DROPLET` | The droplet as ssh reaches it, e.g. `root@203.0.113.10` |
| `GAME_HOST` | The game server's host name. A DNS A record pointing at the droplet, **DNS only** (not proxied) on Cloudflare. Without a domain, `<ip with dashes>.sslip.io` works |
| `SITE_HOSTS` | The host names the client is served from, comma-separated: the Worker's `*.workers.dev` address and any custom domain |
| `DROPLET_ARCH` | `amd64` (most droplets) or `arm64` |

## Commands

| Command | What it does |
|---|---|
| `pnpm deploy:server` | Builds the server for Linux, copies it and the levels to the droplet, installs and restarts it. The first run also installs Caddy and creates the service. **Restarting ends the rooms that are running** |
| `pnpm deploy:client` | Builds the client with `VITE_SERVER_URL=https://$GAME_HOST` and publishes it with `wrangler deploy` (needs `wrangler login`) |

First time, in this order:

1. `pnpm deploy:client`: note the address it prints (`https://arena.<subdomain>.workers.dev`).
2. Put that host name in `SITE_HOSTS`.
3. `pnpm deploy:server`.
4. Open the Worker's address and play.

After that, run whichever side changed. A change to `protocol/`, `shared/params.json`, the sim or
a level changes both sides: deploy both, server first.

## What is on the droplet

| Path | What |
|---|---|
| `/opt/arena/arena-server` | The server binary |
| `/opt/arena/levels/` | The level files it loads at start (`ffa.json`, `greybox.json` for the practice range) |
| `/opt/arena/arena.env` | `ALLOWED_ORIGINS`, from `SITE_HOSTS` |
| `/etc/systemd/system/arena.service` | Runs it as the user `arena`, restarts it if it stops. systemd hands it a copy of Caddy's certificate at start (`LoadCredential`) and lets it bind port 443 |
| `/etc/systemd/system/arena-cert.path`, `arena-cert.service` | Restart the game server when Caddy renews the certificate (about every two months; running rooms end) |
| `/etc/caddy/Caddyfile` | Caddy: the certificate for `GAME_HOST` (got and renewed by itself) and the pass-through to the server. HTTP/3 is turned off there so UDP 443 is free for the game server |
| `/etc/sysctl.d/90-arena-quic.conf` | Bigger UDP buffers, which QUIC wants |

The server listens on `127.0.0.1:8080` (TCP, for Caddy) and on UDP `:443` (WebTransport, for
players). Caddy holds TCP ports 80 and 443. The game server answers the room API over HTTP/3 on
UDP 443 as well: a browser that knows the host speaks HTTP/3 sends its ordinary requests there.
A firewall in front of the droplet must let **UDP 443** in, besides TCP 80 and 443. Useful on the droplet:
`systemctl status arena`, `journalctl -u arena -f`, `curl localhost:8080/healthz`.

## How the two halves find each other

- **Client:** `client/src/net/serverUrl.ts`. With `VITE_SERVER_URL` unset (development), the page
  talks to its own origin and Vite proxies the room API to the local server. Set at build time, the
  room API goes to that address. Either way the page asks `GET /api/transport` which UDP port
  WebTransport is on (and, in development, the hash of the server's self-signed certificate) and
  connects there directly.
- **Server:** `--allowed-origins=<host>,<host>`. WebTransport, the WebSocket and the HTTP API (CORS)
  accept pages from those hosts, and from localhost. A page from anywhere else is refused.

## Adding a real domain later

1. Game host: add an A record (DNS only) for e.g. `game.example.com` to the droplet, set `GAME_HOST`.
2. Site: add the custom domain to the Worker in the Cloudflare dashboard, add it to `SITE_HOSTS`.
3. `pnpm deploy:server`, then `pnpm deploy:client`.
