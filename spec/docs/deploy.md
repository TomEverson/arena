# Deploying

The client is static files on **Cloudflare Workers**; the game server is one Go program on a
**DigitalOcean droplet**. They are on different hosts, so the client is built knowing the
server's address and the server is told which sites may talk to it.

```text
Browser ── https ──> Cloudflare Worker "arena"      (the page: HTML, JS, models)
   │
   └──── https + wss ──> game host ──> Caddy :443 ──> arena-server 127.0.0.1:8080   (the droplet)
```

The browser talks to the droplet directly (not through Cloudflare), so game traffic takes the
shortest path. This is the WebSocket transport the game uses today; the WebTransport direction in
`spec/brainstorm/05-netcode.md` would replace Caddy's part later, on the same droplet.

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
| `/etc/systemd/system/arena.service` | Runs it as the user `arena`, restarts it if it stops |
| `/etc/caddy/Caddyfile` | Caddy: the certificate for `GAME_HOST` (got and renewed by itself) and the pass-through to the server |

The server listens on `127.0.0.1:8080` only; Caddy holds ports 80 and 443. Useful on the droplet:
`systemctl status arena`, `journalctl -u arena -f`, `curl localhost:8080/healthz`.

## How the two halves find each other

- **Client:** `client/src/net/serverUrl.ts`. With `VITE_SERVER_URL` unset (development), the page
  talks to its own origin and Vite proxies to the local server. Set at build time, the room API and
  the WebSocket go to that address.
- **Server:** `--allowed-origins=<host>,<host>`. The WebSocket and the HTTP API (CORS) accept pages
  from those hosts, and from localhost. A page from anywhere else is refused.

## Adding a real domain later

1. Game host: add an A record (DNS only) for e.g. `game.example.com` to the droplet, set `GAME_HOST`.
2. Site: add the custom domain to the Worker in the Cloudflare dashboard, add it to `SITE_HOSTS`.
3. `pnpm deploy:server`, then `pnpm deploy:client`.
