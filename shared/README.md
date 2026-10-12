# shared

Single source of truth for numbers both the client (TypeScript) and the server (Go) must agree on.

- `params.json`: movement and weapon tuning. TypeScript imports it directly
  (`client/src/sim/params.ts`); Go constants are **generated** into
  `server/internal/game/params_gen.go` by `scripts/gen-go.mjs`. Never hand-edit the generated file.
- `pnpm gen` regenerates the Go file. `pnpm test` runs `gen-go.mjs --check`, which fails if the Go file is stale.

Changing any movement number changes movement: re-record the vectors (`pnpm vectors`) and run both test suites.

## Movement parameters (`movement`)
| Key | Meaning |
|---|---|
| `halfWidth`, `standHeight`, `slideHeight`, `crouchHeight`, `*Eye` | Player box and eye heights (m) |
| `runSpeed`, `groundAccel`, `groundFriction`, `stopSpeed` | Ground movement (Quake-style accelerate) |
| `adsSpeedMult` | Ground speed multiplier while aiming down sights |
| `airAccel`, `gravity`, `terminalVelocity` | Air movement. Air steering never gains speed |
| `jumpSpeed`, `maxAirJumps`, `airJumpSpeed`, `coyoteTime`, `jumpBufferTime` | Jumping; `maxAirJumps` 1 = double jump |
| `stepHeight`, `rampStep`, `snapDown`, `groundEps`, `maxSubstep` | Collision: step-up, ramp step, ground snap, sub-step size (anti-tunnelling) |
| `slide*`, `crouchSpeed` | Slide boost/decay/limits, crouch-walk speed |
| `dash*` | Dash charges, speed, duration, exit speed, seconds per charge |
| `climb*` | Climb speed, wall reach, facing cone, top-out distance |
| `mantle*` | Mantle reach, duration, inset, exit speed |

## Weapon parameters (`weapon`)
Damage, health (`maxHealth`, `maxShield`), fire rate (`rpm`), magazine, reload, spread cone values, the 30-entry `recoilPitch`/`recoilYaw`
tables, ADS zoom and sensitivity. Angles are degrees. Used by `client/src/sim/weapon.ts` now and by the Go
port in M5.

## Combat parameters (`combat`)
Server-authoritative numbers: `headSize` (the top 0.3 m of a target is its head), shield recharge delay and rate,
`respawnTime`, `spawnProtection`, `maxRewindTicks` (lag-compensation cap, 20 ticks = 333 ms), `historyTicks`
(position history kept), `eventRedundancyTicks` (how long events are resent in snapshots). Go constants are
prefixed `Combat`.
