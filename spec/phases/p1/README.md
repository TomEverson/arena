# Phase 1: FFA Deathmatch

PvP only: up to 8 players, 6-minute free-for-all, one assault rifle, Ultrakill/Overwatch-style movement.
Game design: [../../docs/design.md](../../docs/design.md). Nothing outside this scope (AI, classes, control points,
second weapon) is built in this phase.

## M0. Foundation (done)
Monorepo, Turborepo, Vite + Three.js client with fixed-timestep loop, Go server with 60 Hz tick,
30 Hz snapshots, `Codec`, fake latency/loss flags, tests, CI file.

## Milestones, in build order
| Milestone | Title | Depends on |
|---|---|---|
| [M1](m1.md) | Local movement feel (no network) | M0 |
| [M2](m2.md) | Local gunplay | M1 |
| [M3](m3.md) | Movement on the server + shared test vectors | M1 |
| [M4](m4.md) | Netcode core: two players moving | M3 |
| [M5](m5.md) | Networked combat | M4, M2 |
| [M6](m6.md) | Match flow | M5 |
| [M7](m7.md) | Scale to 8 | M6 |
| [M8](m8.md) | Look, sound and feel pass | M1 (can run in parallel from M4) |
| [M9](m9.md) | Friend-ready | M6, M7 |

## Main risks
- **Prediction and reconciliation (M4)**: most likely place for subtly wrong code. Keep it small, test with vectors.
- **Movement + Apex-style gunplay (M1-M2)**: fast movement can make players too hard to hit. Tune together.
- **Lag compensation (M5)**: easy to get almost right. Test with fake latency from day one.
- **Scope creep**: no PvE, classes or second weapon until M9 playtests ask for them.

## Conventions
Each milestone is one file (`m1.md` ... `m9.md`) with scope (checklist), a done-when, and notes. Add detail to the file, or a folder of notes, as the milestone is worked on. Tick the checklist as items land.
