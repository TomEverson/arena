# protocol

Placeholder. This directory will become the single source of truth for
client<->server messages; Go and TypeScript types/codecs will be **generated**
from it (never hand-edited).

Until then, the de-facto JSON messages are defined by:
- Go: `server/internal/wire/codec.go` (`Codec` interface, JSON implementation)
- TS: `client/src/net.ts`

Current messages:
- server -> client `welcome`: `{type, playerId, tickRate, snapshotRate}`
- server -> client `snapshot` (30 Hz): `{type, tick, ackSeq, entities: [{id, teamId, x, y, z}]}`
- client -> server input (one per client tick, 60 Hz): `{seq, moveX, moveZ, yaw, pitch, jump, jumpHeld, dash, slide, ads}`. `jump` and `dash` mean "pressed this tick"; the rest are held states. The browser client does not send these yet (M4).
