# testvectors

Shared test vectors for movement (`movement/`), the weapon (`weapon/`) hitscan (`hitscan/`) bullets (`bullet/`) and melee (`melee/`). They keep client prediction and the authoritative
server in lockstep: the **same JSON files** are replayed by the TypeScript tests
(`client/src/sim/vectors/vectors.test.ts`) and the Go tests
(`server/internal/game/vectors_test.go`).

## What a vector is
`movement/<name>.json` holds:
- `world`: either `{ "level": "greybox" }` (loads `/levels/greybox.json`) or inline `boxes` and `ramps`
- `initial`: the full starting `PlayerState`
- `steps`: the exact inputs, run-length encoded (`{ticks, input}`), at `dt` = 1/60
- `checkpoints`: the full expected state every 10 ticks and at the end

Numbers must match within **1e-6**; booleans must match exactly.

## Workflow
The TypeScript sim is the reference. Vectors are recorded from it, never hand-edited.

| You changed | Run |
|---|---|
| Anything in `shared/params.json` | `pnpm gen` then `pnpm vectors` then `pnpm test` |
| Movement logic (`client/src/sim/*`) | port the change to `server/internal/game/*.go`, then `pnpm vectors` and `pnpm test` |
| A scenario (`client/src/sim/vectors/scenarios.ts`) | `pnpm vectors` then `pnpm test` |
| `levels/greybox.json` | `pnpm vectors` (greybox routes and fuzz run on the real level) |

`pnpm vectors` also runs each scenario's `verify`, which fails if the recording
no longer demonstrates what the scenario claims (for example, a mantle that
doesn't happen). Read any scenario that fails verify before re-recording: the
vectors freeze whatever the TS sim does.

## Weapon and hitscan vectors
- `weapon/*.json`: an initial weapon state, run-length encoded inputs and movement context per tick, every event (shot, reload start or end, dry fire, with the exact spread and recoil kick) and checkpoints of the full weapon state.
- `hitscan/*.json`: a world, target hitboxes and a list of rays with the expected result (kind, distance, point, target, headshot).
- The Go tests are `server/internal/game/combat_vectors_test.go`; the TypeScript ones are `client/src/sim/vectors/combat-vectors.test.ts`. Same rule: change combat math, then `pnpm vectors`.

## What is covered by the movement vectors (38 vectors, about 8,000 ticks)
Run, diagonal, friction, jump, buffer, coyote, double jump, slide (boost, jump, to-crouch),
crouch and crawling under a ceiling, dash (ground, air, charges, thin wall), outer and inner
corners, step-up, ceiling bonk, ramps (up, down, tall side), mantle, climb, ADS, five routes
through the real greybox level, and three seeded pseudo-random runs of 900 ticks.

## Known limits
- Vectors only detect a change to a threshold if some scenario passes close to it. Nudging a
  tuning constant by a hair (for example the 0.3 push needed to mantle) may go unnoticed.
- JavaScript and Go can differ in the last bit of `sin`/`cos`/`hypot`, and Go on ARM can fuse
  multiply-adds. The 1e-6 tolerance absorbs this unless a run sits on a knife-edge; the fuzz
  runs are the likeliest place for a false alarm.
- Lag compensation and health/respawn rules are server logic with Go unit tests, not vectors; `pnpm combatcheck` exercises them end to end.

## Bullet vectors

`bullet/*.json`: a world, an origin, a direction, a speed and range, the target boxes at each step, and what the bullet looked like after every step until it was done (position, velocity, distance flown, and what the swept path hit). Recorded from `client/src/sim/bullet.ts` by `pnpm vectors`; the Go twin (`server/internal/game/bullet.go`) replays them in `bullet_vectors_test.go`. They cover flight and drop, range expiry, a wall, a thin wall (no tunnelling), the floor, body and head hits, a moving target (led and not), and a slower bullet.

## Melee vectors

`melee/*.json`: a world, target boxes, and a list of swings (eye position and view direction) with the target each should hit, or -1. Recorded from `client/src/sim/melee.ts`; the Go twin (`server/internal/game/melee.go`) replays them in `melee_vectors_test.go`. They cover in front, behind, to the side, out of reach, outside the cone, a wall in between, the nearest of two, and crouched and raised targets.
