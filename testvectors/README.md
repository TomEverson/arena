# testvectors

Shared movement test vectors. They keep client prediction and the authoritative
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

## What is covered (38 vectors, about 8,000 ticks)
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
- Weapons are not covered yet (M5).
