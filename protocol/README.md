# protocol

Single source of truth for everything on the wire. `messages.json` defines the
structs and messages; `scripts/gen.mjs` generates, for both sides:

- Go: `server/internal/protocol/protocol_gen.go` (structs with JSON tags, message type constants)
- TypeScript: `client/src/net/protocol.gen.ts` (interfaces, `ClientMessage`/`ServerMessage` unions, `parseServerMessage`)

Never hand-edit the generated files. `pnpm gen` regenerates; `pnpm test` fails if either file is stale.
The movement types `Input` and `PlayerState` live here too, so the sim and the wire cannot drift
(`game.PlayerState`/`game.Input` and the client's `PlayerState` are aliases of the generated types).

## Messages (JSON text frames, `type` field says which)

Client to server
| type | fields | notes |
|---|---|---|
| `input` | `inputs: Input[]` | The latest 3 inputs, oldest first, every client tick (60 Hz). Resent redundantly; the server skips sequence numbers it already has. |
| `ping` | `t` | Client time in ms. |
| `respawn` | | Ask to be put back at a spawn point (a dev shortcut). |
| `rematch` | | Vote for another match while the results are showing. |
| `practice` | `action` | `refill`, `start` (back to the course start) or `reset` (targets); ignored outside a practice range. |

Server to client
| type | fields | notes |
|---|---|---|
| `welcome` | `playerId, tickRate, snapshotRate, level, room, maxPlayers, mode` | Once, on connect. |
| `snapshot` | `tick, ackSeq, queued, you, health, weapon, match, scores, entities, events` | 30 Hz. `you` is your full movement state right after input `ackSeq`; `weapon` and `health` go with it. `entities` are everyone else (see `entitiesFor`). `match` is the room's phase and clock, `scores` everyone's kills and deaths, `events` are recent hits, hurts and kills (resent for 6 ticks; de-duplicate by `seq`). |
| `pong` | `t, tick` | Echoes the ping; `tick` is the server tick. |

`Input`: `seq, moveX, moveZ, yaw, pitch, jump, jumpHeld, dash, slide, ads, fire, reload, viewTick`. `viewTick` is the (fractional) server tick the sender's screen was showing other players at; the server rewinds to it for lag compensation (capped; 0 means no rewind). `jump` and `dash` mean
"pressed this tick"; the rest are held states. `Entity`: `id, teamId, x, y, z, yaw, pitch, flags, kind`
(`flags` is a bit set of `EntityFlags`: crouching, sliding, climbing, dashing, onGround, mantling, dead, protected).

## Delivery assumptions
Messages travel over one WebSocket (TCP): in order, never lost. The fake `--loss` flag drops
whole messages anyway, which is why inputs are resent redundantly. The server's duplicate check
(`seq <= lastQueued`) assumes in-order delivery; a future UDP-like transport would need a window.

## Changing the protocol
Edit `messages.json`, run `pnpm gen`, fix what no longer compiles on either side. A binary codec
(M7, if needed) would be generated from the same file; field types (`u8`, `u16`, `u32`, `f64`) are
already chosen with that in mind.

## Combat messages
- `PlayerHealth`: `health, shield, alive, respawnIn, protectedFor`.
- `WeaponState`: `ammo, reloadT, cooldown, burst, sinceShot, rng`. Simulated identically on both sides from the inputs; the client reconciles it like movement.
- `GameEvent`: `seq, tick, kind, actor, other, amount, flags, health, shield`. For `hit` and `hurt`, `health` and `shield` are the victim's values after the hit, so the shooter can draw the target's health bar. Kinds: `hit` (you landed a hit: actor = you, other = victim), `hurt` (you were hit: actor = shooter), `kill` (anyone killed anyone, sent to everyone). Flags: `headshot`, `killed`.

## Rooms and the match
- HTTP: `POST /api/rooms` with an optional body `{"mode": "ffa" | "practice"}` (default ffa) -> `201 {code, mode, maxPlayers}` (400 for an unknown mode); `GET /api/rooms/{code}` -> `{code, mode, players, maxPlayers}` or 404; `GET /healthz` -> `{status, rooms}`.
- WebSocket: `/ws?room=CODE` (case-insensitive). Refusals are WebSocket close codes: **4001** room not found, **4002** room full.
- `MatchInfo`: `phase` (`MatchPhases`: waiting 0, countdown 1, live 2, ended 3), `timeLeft` (seconds left in the phase), `suddenDeath`, `winner` (player id, 0 for a draw), `players`, `minPlayers`, `rematchVotes`.
- `Score`: `id, kills, deaths`. Players move and shoot only in the waiting and live phases.

## Practice range entities
Targets are `Entity` values with `kind` = `target` (see `EntityKinds`), ids from `COMBAT.targetIdBase` (1000), `teamId` 0, and the `dead` flag while they are down. Players have `kind` = `player`. Hits on targets produce the usual `hit` and `kill` events with the target's id in `other`.
