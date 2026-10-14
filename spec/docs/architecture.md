# Architecture

> Rationale: [spec/brainstorm/02-tech-decisions.md](../brainstorm/02-tech-decisions.md), [spec/brainstorm/05-netcode.md](../brainstorm/05-netcode.md).

## Overview
Browser client (TypeScript, Three.js) <-> WebTransport `/wt` (QUIC over UDP; a WebSocket `/ws` remains for the headless test players) <-> Go authoritative server.
In dev, Vite serves the client on :5173 and proxies `/ws` and `/healthz` to the Go server on :8080.

## Server
- One goroutine owns the world (`server/internal/game`). It runs a 60 Hz fixed tick via `World.Step`.
- Network goroutines (`server/internal/gameserver`) never touch world state. They push joins, leaves and
  inputs into a buffered inbox channel, and read snapshots from a per-player `Out` channel.
- Snapshots are built every 2nd tick (30 Hz) into preallocated, pooled buffers (`Free`/`Out` channels), so
  the tick loop does not allocate. `TestStepDoesNotAllocate` enforces this.
- Snapshot contents go through `entitiesFor(player)`, which currently returns everything.
- `wire.Codec` isolates message encoding (`MsgPack` in production, JSON in focused tests).
- `netsim.Link` implements `--fake-latency` and `--loss` for both directions.
- Slow clients: if all of a player's snapshot buffers are in flight, that snapshot is skipped, never queued.
- If the inbox is full, inputs are dropped rather than blocking the network goroutine.

- Player movement runs on the server from queued inputs (`World.stepPlayer`) and is **input-driven**: a player only moves when an input arrives (one per tick; a second when backed up, limited by banked credit), so its state is always exactly "after input `ackSeq`". Duplicate (redundantly resent) sequence numbers are skipped; a full queue drops the oldest. `server/internal/game/movement.go` is a port of the TS sim, locked to it by `testvectors/`.
- Levels (`/levels/*.json`) are loaded by both sides (`client/src/sim/level.ts`, `server/internal/level`); tuning numbers come from `/shared/params.json` (Go constants generated).

## Combat (M5)
- The weapon is part of the per-input simulation: movement, then `StepWeapon`, then, if a shot fired, `resolveShot` (`server/internal/game/combat.go`). Weapon time advances only with a player's inputs, like movement.
- **Lag compensation**: every tick records each player's position; a shot is traced against the other players as the shooter's screen showed them (`Input.viewTick`, interpolated between the two bracketing snapshot ticks, capped at 20 ticks). The shooter is never rewound.
- Health, damage, kills, death, respawn timers, spawn protection and spawn choice (farthest from living enemies, preferring spawns no enemy can see) are server-only. Dead players still consume inputs.
- Events (`hit`, `hurt`, `kill`) ride in snapshots for 6 ticks and are de-duplicated by per-recipient sequence number.

## Rooms and the match (M6)
- A **room** is one match: its own `World` on its own goroutine with its own 60 Hz tick. `Rooms` (network side, mutex-protected) creates rooms, looks them up and removes empty ones; the simulation itself still has no locks. Clients create or join rooms with `POST /api/rooms` and `/ws?room=CODE`.
- Inside the world, `match.go` runs the cycle waiting -> countdown -> live -> ended -> countdown. Players are frozen (inputs acknowledged, nothing simulated) in the countdown and results; shots only hurt while live. Sudden death ends on the first kill that leaves a single leader.
- Snapshots carry `match` (phase, clock, winner, vote count) and `scores`; the client freezes prediction in exactly the phases the server does (`canAct`).

## Game modes and the practice range (M10)
- A room has a **mode**. `ffa` runs the match cycle on the FFA level. `practice` is an always-live range: `World.SetPractice(true)` adds the level's `targets[]` as server-simulated dummies (`server/internal/game/targets.go`), turns off player-vs-player damage and spawn protection, and starts everyone at the first spawn point. `Rooms` builds each mode from its own `ModeConfig` (level, match rules, practice flag).
- Targets are entities in snapshots (`kind: target`, ids from 1000) with their own position history, so lag compensation works on strafing ones exactly as on players (`history.boxAt`). They never shoot back; killing one sends the shooter the same hit and kill events as a player kill, and it comes back after 2 s.
- Practice helpers (`refill`, `start`, `reset`) are client messages the world ignores outside a range. The stats panel (accuracy, time-to-kill) is computed on the client from the hit events.

## Client
- `FixedTimestep` (`client/src/loop.ts`) simulates at 60 Hz in an accumulator; rendering runs per
  animation frame with an interpolation alpha between the previous and current sim state.
- `RetroRenderer` draws to a low-res 16:9 render target (default 1280x720, set with `?res=<height>`; nearest filter) and blits it letterboxed.
- Player controller (`main.ts`) feeds one input per tick into `stepPlayer` (`client/src/sim/`) and interpolates the camera.

## Prediction and remote players (M4)
The client predicts movement with the same function as the server (`sim/movement.ts` / `game/movement.go`, locked together by `testvectors/`), sends the last 3 inputs every tick, and reconciles against each snapshot's `you` + `ackSeq` (`client/src/net/prediction.ts`). Small corrections fade out of the camera; large ones snap. Other players are drawn 100 ms in the past, interpolated between snapshots using a server-tick estimate (`clock.ts`, `interpolation.ts`). Wire types are generated from `protocol/messages.json`.

## Teams
Every entity has a `teamId`. Currently team = player (teams of one); designed for teams of 4-6.
