# levels

Level data as JSON, loaded by both client (rendering, prediction) and server
(authoritative collision). See `example.json` for the shape: `boxes`, `ramps`,
`controlPoints`, `spawnZones`. Units are metres; Y is up.

`teamSlot` on spawn zones is a slot index, not a team ID: teams are assigned
to slots at match start so the same level works for teams of 1 or 4-6.

Format (units metres, Y up):
- `boxes[]`: `{id, pos, size}`; `pos` is the box centre, `size` the full extents.
- `ramps[]`: same as a box plus `rises` (`"+x" | "-x" | "+z" | "-z"`), the high side. A ramp is a solid wedge filling its box.
- `spawnZones[]`: `pos` is the centre of the footprint at floor level; players spawn with feet at `pos.y`.
- `targets[]`: practice dummies, client-only: `{id, pos (feet), kind: "static"|"strafe", axis: "x"|"z", range}`; strafing ones move +-`range` m around `pos`.
- `controlPoints[]`: ignored in Phase 1.

Loaders and validation: `client/src/sim/level.ts` (`parseLevel`) and `server/internal/level` (`Load`); the server takes `--level`. Spawn zones become the server's player spawn points. Levels: `example.json` (schema sample), `greybox.json` (movement test arena), `duel.json` (an open 80 m arena with two spawns at opposite ends, used by `pnpm combatcheck`). `range.json` (an open arena with two static and two strafing targets all in view of the spawn, used by `pnpm practicecheck`). `ffa.json` is the FFA map (200 x 200 m, 24 spawns): a centre district on three heights (a sunken pit under a cross of bridges, a ground ring of buildings, a high loop of decks, roofs and catwalks) and eight districts around it on a 3 x 3 grid (blocks, container yards, sunken basins, terraces), joined by avenues with gates. It is **generated** by `node levels/gen-ffa.mjs`, so edit the layout in that script, not the JSON.

The server reports each room's level name in the welcome message, and the client (`client/src/levels.ts`) loads the map of that name; add new maps there too. FFA rooms run `ffa` (`--level`), practice rooms run the greybox (`--practice-level`).
The schema is not frozen.
