# Architecture

> Rationale: [spec/brainstorm/02-tech-decisions.md](../brainstorm/02-tech-decisions.md), [spec/brainstorm/05-netcode.md](../brainstorm/05-netcode.md).

## Overview
Browser client (TypeScript, Three.js) <-> WebSocket `/ws` <-> Go authoritative server.
In dev, Vite serves the client on :5173 and proxies `/ws` and `/healthz` to the Go server on :8080.

## Server
- One goroutine owns the world (`server/internal/game`). It runs a 60 Hz fixed tick via `World.Step`.
- Network goroutines (`server/internal/gameserver`) never touch world state. They push joins, leaves and
  inputs into a buffered inbox channel, and read snapshots from a per-player `Out` channel.
- Snapshots are built every 2nd tick (30 Hz) into preallocated, pooled buffers (`Free`/`Out` channels), so
  the tick loop does not allocate. `TestStepDoesNotAllocate` enforces this.
- Snapshot contents go through `entitiesFor(player)`, which currently returns everything.
- `wire.Codec` isolates message encoding (JSON now, binary later).
- `netsim.Link` implements `--fake-latency` and `--loss` for both directions.
- Slow clients: if all of a player's snapshot buffers are in flight, that snapshot is skipped, never queued.
- If the inbox is full, inputs are dropped rather than blocking the network goroutine.

## Client
- `FixedTimestep` (`client/src/loop.ts`) simulates at 60 Hz in an accumulator; rendering runs per
  animation frame with an interpolation alpha between the previous and current sim state.
- `RetroRenderer` draws to a 427x240 render target (nearest filter) and blits it letterboxed.
- Fly camera (`flycam.ts`) is a debug tool, not player movement.

## Prediction (planned)
Client predicts movement with the same function as the server (`sim/movement.ts` / `game/movement.go`),
verified by shared `testvectors/`. Server snapshots carry `ackSeq` so the client can reconcile.

## Teams
Every entity has a `teamId`. Currently team = player (teams of one); designed for teams of 4-6.
