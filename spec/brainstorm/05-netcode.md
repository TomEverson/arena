# 05. Netcode

## Decided
- **Authoritative server** (Go). Clients send inputs; the server decides truth.
- **Fixed tick:** simulate at 60 Hz, send snapshots at 30 Hz.
- **Single goroutine owns world state** and runs the tick loop. Network goroutines only read packets and push inputs into a channel (no locks in the simulation).
- **Start at 2 players**, design for 32, scale later via profiling.
- WebSocket first behind a transport abstraction.

## Must build properly from the start (painful to retrofit)
1. Fixed-tick authoritative server
2. Binary-ready protocol: generic entity IDs and types, so players, AI and projectiles share one snapshot format (JSON behind a `Codec` interface at first)
3. **Relevance hook:** snapshots built by `entitiesFor(player)`, which currently returns everything. The spatial grid and team-aware relevance slot in later without changing the protocol.
4. Client prediction + server reconciliation + entity interpolation (render remote players about 100 ms in the past)
5. Lag-compensated hitscan (server keeps about 250 ms of position history and rewinds to the shooter's view)
6. Shared movement test vectors (Go and TS)
7. Server-side AI as ordinary entities with cheap behaviors (chase, shoot, flee)
8. Network simulation flags: `--fake-latency=80ms --loss=3%`

## Can skip until scale demands it
- Interest management (full snapshots are cheap at 32 players: about 15 KB/s down per client)
- Multi-core region splitting
- Client instancing and LOD

## Current deployment direction: WebTransport

The game should move from WebSocket/TCP to browser-native WebTransport over HTTP/3/QUIC. We are
intentionally not keeping a WebSocket fallback: this is a real-time FPS and the target is low-latency,
UDP-like datagrams rather than maximum compatibility.

The preferred deployment is a direct public game server, not a normal Cloudflare Tunnel:

```text
Browser -> UDP/443 + HTTP/3 -> VPS running the Go WebTransport server
```

- Run the authoritative Go server directly on a VPS with UDP and TCP 443 open.
- Use a real TLS certificate for the game hostname.
- Keep the client on Cloudflare Pages or another HTTPS host if useful.
- Use Cloudflare DNS in DNS-only mode for the game hostname; do not assume the normal HTTP proxy or
  Cloudflare Tunnel forwards WebTransport datagrams.
- A self-hosted QUIC relay or UDP tunnel is an alternative for development, but it must preserve the
  browser's WebTransport HTTP/3 handshake, certificate identity, Origin handling and datagrams. A
  generic UDP forwarder alone is not a WebTransport endpoint.

Transport split:

- Binary MessagePack payloads: production traffic avoids JSON parsing and numeric text overhead.
- Delta snapshots: the first relevance snapshot is full; later snapshots carry changed entities and removals.
  - A removal is sent when an entity leaves interest, **or no longer exists**. Until 2026-10-13 only the first case was handled: anything that ceased to exist within interest range (a spear or grenade that went off, a grapple hook let go, a pickup taken) stayed on the client's screen for ever. The server now lists everything that exists each snapshot tick (`World.existing`) and `deltaEntities` checks the client's baseline against it. Test: `TestASpearThatWentOffIsRemovedFromEveryScreen`.
- Unreliable datagrams: frequent player inputs and movement snapshots once WebTransport is active.
- Reliable streams: welcome, match state, important events and resynchronization/keyframes.
- Every datagram carries a sequence number; stale snapshots are discarded and keyframes repair loss.

This direction requires HTTPS/HTTP/3 deployment, a WebTransport-capable Go server, loss and reorder
tests, and a direct production endpoint before the client transport is switched over.

## WebTransport, as built (2026-10-14)

The move above is done: browsers play over WebTransport, on the droplet's UDP port 443. What was built, and where it differs from the plan:

- **One session per player** at `https://<game host>:<port>/wt?room=<code>` (`server/internal/gameserver/webtransport.go`, `client/src/net/webtransport.ts`).
  - **A reliable stream**, opened by the client: the welcome down; hero, respawn, rematch and practice requests up. Each message is a 4-byte length and then the bytes.
  - **Datagrams** for everything that may be lost: snapshots and pongs down, inputs and pings up. One message each.
  - **A message too big for a datagram** (over 1100 bytes: a full snapshot of a busy room) goes on a one-way stream of its own. Streams do not block each other, so it still never holds anything else up. This replaces the plan's "keyframes on the reliable stream".
- **Snapshots survive loss by acknowledgement, not by keyframes.** Every input message carries `ack`, the newest snapshot tick the client has. The server sends full snapshots until one is acknowledged, then deltas in which every change and every removal is repeated until a snapshot carrying it has been acknowledged (`deltaEntities` in `world.go`). The client drops a snapshot older than the newest it has used (`NetClient`). So a lost or late datagram costs nothing but its own bytes.
- **The wire got small enough for datagrams.** Binary frames carry every struct as an array of its fields in order, with numbers in their shortest form: a quiet two-player snapshot went from about 1750 bytes to about 220 (a datagram carries about 1200). The field order is generated from `protocol/messages.json` for the TypeScript side (`LAYOUTS` in `protocol.gen.ts`) and is the Go structs' own order. The decoder refuses an array of another length, so **both sides must be deployed together** when messages change.
- **No silent fallback**, as decided: a browser without WebTransport is told it cannot play. The WebSocket `/ws` is still served, for the headless test players (`netcheck` and the others: Node has no WebTransport) and for `?transport=ws` when debugging. It runs the same game code through the same `link` interface, where "may be lost" simply arrives.
- **Certificates.** In development the server makes a self-signed certificate at every start, and the page gets its hash from `GET /api/transport` (browsers accept a short-lived ECDSA certificate by hash for WebTransport). In production it uses the game host's real certificate (`--wt-cert`, `--wt-key`): see `spec/docs/deploy.md`.
- **The fake network** (`--fake-latency`, `--loss`) now loses only what may be lost; the welcome is delayed but always arrives.
- **Go 1.26** is needed now (the WebTransport library asks for it).
- **Not done:** loss and reorder tests through a real lossy UDP path (the tests lose snapshots inside the server), congestion tuning, and splitting one big snapshot over several datagrams.

## Scaling notes (for later)
- Bandwidth is the real limit at high player counts. Fixes: interest management via spatial grid, 16-bit quantization, delta snapshots, lower update rate for distant entities, binary packets.
- Team-aware relevance: teammates always visible; enemies by distance or line of sight; distant teams at lower detail.
- Only simulate and path-find AI near players; tick distant AI slowly or freeze it.
- Client at 100+ visible players: instanced meshes, billboards for far players, no per-player lights.
- If one core becomes the bottleneck: split the world into spatial regions and tick them in parallel.
- Targets: 2, then 32, then push to 64/128/256 using measured profiles. BattleBit's 254 took heavy optimization.

## Testing strategy
- Shared movement test vectors in CI
- Fake latency and loss flags in dev
- A Go bot client that spawns N fake players sending random inputs, so "32 players" is measured, not hoped for
- Test as teams of one at first, then teams of 2, then 6

## Known risk
Prediction and reconciliation are where AI-generated code is most likely to be subtly wrong. Keep that code small, test it with vectors, and understand it.
