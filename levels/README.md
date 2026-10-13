# levels

Level data as JSON, loaded by both client (rendering, prediction) and server
(authoritative collision). See `example.json` for the shape: `boxes`, `ramps`,
`controlPoints`, `spawnZones`. Units are metres; Y is up.

`teamSlot` on spawn zones is a slot index, not a team ID: teams are assigned
to slots at match start so the same level works for teams of 1 or 4-6.

Format (units metres, Y up):
- `boxes[]`: `{id, pos, size}`; `pos` is the box centre, `size` the full extents.
- Looks, on a box or a ramp (optional; the client's renderer reads them, movement and the server ignore them): `surface` is which generated textures it is drawn with (`panel` when missing; the kinds are in `client/src/surfaces.ts`), `glow` where it carries a SIGNAL light strip (`edges`: along its long top edges; `door-x` / `door-z`: along the bottom of the faces you walk through along X or Z). In `gen-ffa.mjs` both are decided from a piece's name, in one table near the top.
- More looks, at the top level (all optional, all ignored by movement and the server; drawn by `client/src/levelDecor.ts` and `main.ts`): `sky` (`"night"`, or day when missing), `signs[]` (`{id, text, pos, size, face, yaw}`: one or two letters painted on a wall facing `face`, or on the ground with `face: "up"`), `props[]` (`{id, kind, pos, size?, face?, yaw?}`: a `lamp`, `mast`, `pipe`, `unit`, `hook` or `tower`, built from boxes). **Props are not in the collision world**, so only place ones nobody can walk into: thin, up on a wall, above head height, or outside the arena (the FFA level test checks this).
- `ramps[]`: same as a box plus `rises` (`"+x" | "-x" | "+z" | "-z"`), the high side. A ramp is a solid wedge filling its box.
- `spawnZones[]`: `pos` is the centre of the footprint at floor level; players spawn with feet at `pos.y`.
- `targets[]`: practice dummies, client-only: `{id, pos (feet), kind: "static"|"strafe", axis: "x"|"z", range}`; strafing ones move +-`range` m around `pos`.
- `pickups[]`: practice range only, server-side: `{id, pos (floor level)}`. Walking over one gives back every cooldown (both skills, a full ultimate, the dashes, the melee); it is gone for 3 s after being taken. The greybox has two: beside the spawn and mid-range.
- `controlPoints[]`: ignored in Phase 1.

Loaders and validation: `client/src/sim/level.ts` (`parseLevel`) and `server/internal/level` (`Load`); the server takes `--level`. Spawn zones become the server's player spawn points. Levels: `example.json` (schema sample), `greybox.json` (movement test arena), `duel.json` (an open 80 m arena with two spawns at opposite ends, used by `pnpm combatcheck`). `range.json` (an open arena with two static and two strafing targets all in view of the spawn, used by `pnpm practicecheck`). `ffa.json` is the FFA map (200 x 200 m, 24 spawns): a centre district on three heights (a sunken pit under a cross of bridges, a ground ring of buildings, a high loop of decks, roofs and catwalks), with a 30 m spire north and south of the pit; and eight districts around it (each corner one has a spire of its own; skybridges 26.5 m up join all six: a ring round the corners and a spine through the centre) on a 3 x 3 grid (blocks, container yards, sunken basins, terraces), joined by avenues with gates. It is **generated** by `node levels/gen-ffa.mjs`, so edit the layout in that script, not the JSON.

The server reports each room's level name in the welcome message, and the client (`client/src/levels.ts`) loads the map of that name; add new maps there too. FFA rooms run `ffa` (`--level`), practice rooms run the greybox (`--practice-level`).
The schema is not frozen.
