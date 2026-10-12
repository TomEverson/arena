# levels

Level data as JSON, loaded by both client (rendering, prediction) and server
(authoritative collision). See `example.json` for the shape: `boxes`, `ramps`,
`controlPoints`, `spawnZones`. Units are metres; Y is up.

`teamSlot` on spawn zones is a slot index, not a team ID: teams are assigned
to slots at match start so the same level works for teams of 1 or 4-6.

Format (units metres, Y up):
- `boxes[]`: `{id, pos, size, climbable?}`; `pos` is the box centre, `size` the full extents. `climbable: true` lets players climb its sides by holding jump (rendered green).
- `ramps[]`: same as a box plus `rises` (`"+x" | "-x" | "+z" | "-z"`), the high side. A ramp is a solid wedge filling its box.
- `spawnZones[]`: `pos` is the centre of the footprint at floor level; players spawn with feet at `pos.y`.
- `targets[]`: practice dummies, client-only: `{id, pos (feet), kind: "static"|"strafe", axis: "x"|"z", range}`; strafing ones move +-`range` m around `pos`.
- `controlPoints[]`: ignored in Phase 1.

Loader and validation: `client/src/sim/level.ts` (`parseLevel`). Levels: `example.json` (schema sample), `greybox.json` (movement test arena).
The schema is not frozen.
