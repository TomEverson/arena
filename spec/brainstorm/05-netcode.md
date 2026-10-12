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
- WebTransport

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
