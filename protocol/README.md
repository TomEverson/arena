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
| `respawn` | | Ask to be put back at a spawn point. |

Server to client
| type | fields | notes |
|---|---|---|
| `welcome` | `playerId, tickRate, snapshotRate, level` | Once, on connect. |
| `snapshot` | `tick, ackSeq, queued, you, entities` | 30 Hz. `you` is your full state right after input `ackSeq`. `entities` are everyone else (see `entitiesFor`). |
| `pong` | `t, tick` | Echoes the ping; `tick` is the server tick. |

`Input`: `seq, moveX, moveZ, yaw, pitch, jump, jumpHeld, dash, slide, ads`. `jump` and `dash` mean
"pressed this tick"; the rest are held states. `Entity`: `id, teamId, x, y, z, yaw, pitch, flags`
(`flags` is a bit set of `EntityFlags`: crouching, sliding, climbing, dashing, onGround, mantling).

## Delivery assumptions
Messages travel over one WebSocket (TCP): in order, never lost. The fake `--loss` flag drops
whole messages anyway, which is why inputs are resent redundantly. The server's duplicate check
(`seq <= lastQueued`) assumes in-order delivery; a future UDP-like transport would need a window.

## Changing the protocol
Edit `messages.json`, run `pnpm gen`, fix what no longer compiles on either side. A binary codec
(M7, if needed) would be generated from the same file; field types (`u8`, `u16`, `u32`, `f64`) are
already chosen with that in mind.
