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
| `mantle*` | Mantle reach, duration, inset, exit speed |
| `wallRun*`, `wallJump*` | Wall run speed, time, gravity, grab rules; wall jump kick, height, limit |

## Weapon parameters (`weapon`)
Damage, health (`maxHealth`, `maxShield`), fire rate (`rpm`), magazine, reload, spread cone values, the 30-entry `recoilPitch`/`recoilYaw`
tables, ADS zoom and sensitivity, and the bullet (`bulletSpeed` m/s, `bulletGravity` m/s²; the `range` is how far it flies). Angles are degrees. Used by `client/src/sim/weapon.ts` now and by the Go
port in M5.

## Sniper parameters (`sniper`)
The second gun (weapon slot 2, hitscan): the same keys as the rifle where they apply (damage, `headshotMult`, `rpm`, `magSize`, `reloadTime`, `range`, the spread cone values, recoil, ADS zoom and sensitivity). Go constants are prefixed `Sniper`. The draw times between weapons are `switchTime` and `switchQuickTime` in the `weapon` section.

## Combat parameters (`combat`)
Server-authoritative numbers: `headSize` (the top 0.3 m of a target is its head), shield recharge delay and rate,
`respawnTime`, `spawnProtection`, `maxRewindTicks` (lag-compensation cap, 20 ticks = 333 ms), `historyTicks`
(position history kept), `eventRedundancyTicks` (how long events are resent in snapshots). Go constants are
prefixed `Combat`. Also `targetIdBase` (ids of practice targets start here), `targetRespawn` and `targetSpeed` (the strafing speed), used by the server's practice targets.

## Match parameters (`match`)
`minPlayers` (2), `maxPlayers` (room capacity, 8), `countdownSeconds`, `lengthSeconds` (the 6-minute match) and
`resultsSeconds`. Go constants are prefixed `Match`; the server flags `--countdown`, `--match-length` and `--results`
override them for testing.
