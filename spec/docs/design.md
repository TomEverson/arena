# Design

> Brainstorming and rationale live in [`spec/brainstorm/`](../brainstorm/README.md), especially
> [04-game-design.md](../brainstorm/04-game-design.md). This file is the polished result.

## Game modes
Two modes, chosen on the start screen (see `spec/phases/p1/m10.md`):
- **FFA deathmatch**: the competitive game described below.
- **Practice range**: an always-live sandbox with the movement course and shooting targets that do not shoot back, no timer or scoreboard, and a stats panel (time-to-kill, accuracy) for tuning and testing. Friends can share a range by link; players cannot damage each other there.

## Game mode: FFA Deathmatch

PvP only. No AI, no classes, no control points yet. One concrete mode is built and tuned before any other.
Control-point war, PvPvE and team modes stay in the brainstorm backlog.

### Match
- **Players:** 8 max to start (2 minimum for a match; 16 is a stretch goal).
- **Length:** 6 minutes. No kill limit: when the timer ends, most kills wins.
- **Tie at the end:** sudden death: the clock stops and the first kill that leaves a single leader ends the match. *Default, not yet confirmed.*
- **Flow:** wait for 2 players -> 5 s countdown (frozen) -> 6:00 match -> 15 s results (Enter to vote for a rematch; everyone voting starts it early) -> next match. Players can join and leave at any time; joiners start at 0 kills. Friends join by link (`?room=CODE`).
- **Map:** one small-to-medium arena with vertical play, so movement has something to use.

### Teams
FFA is teams of one: every player's `teamId` is unique. This keeps the data model ready for team modes.

### Death and respawn
- Respawn after 3 seconds at the spawn point farthest from enemies, strongly preferring ones no enemy can see.
- 2 seconds of spawn protection, ended by firing.
- Nobody is ever eliminated from the match.

### Health
- 100 health + 50 shield. The shield recharges after 3 s without taking damage, at 20 per second.
- **A kill restores health and shield to full** (Ultrakill-style "blood is health"), and gives both dashes back.
  Watch for snowballing: the leader keeps winning fights. Tune later (partial heal, leader marker) if playtests show it.
- Health and shield pickups sit at fixed spots on a respawn timer. They give players a reason to contest certain locations.

### Weapons
- **One weapon for everyone: an assault rifle (the Brick).** A **projectile** weapon (500 m/s, a little drop; you lead moving targets), ADS, hipfire spread, a fixed per-gun recoil pattern players can learn.
- Target time-to-kill: about 1.5-2 seconds on a full 150 total health.
- First numbers (M2): 600 rpm, 9 damage (x1.5 head), 30-round magazine, 1.8 s reload; full tuning in `client/src/sim/params.ts` (`WEAPON`).
- ADS: zoomed (0.7x FOV), 0.65x ground speed, tight spread. Hipfire spread grows with movement, air time and sustained fire.
- Recoil: a fixed 30-entry pattern kicks the player's view; the player counters it with the mouse.
- Server-side hit detection with lag compensation: shots are traced against other players as the shooter's screen showed them (capped at 333 ms of rewind). A headshot is the top 0.3 m of the target, so crouched players have a head too.
- Deferred: secondary weapon, power-weapon pickup, any loadout choice.

### Movement
Apex-readable gunplay on Ultrakill/Overwatch-style mobility: sprint, slide with momentum, jump, 2-charge dash (6 s per charge, both back on a kill), mantle, wall run and wall jump.
Movement is a small pure function shared (in logic) between Go and TS via `testvectors/`.
A bullet (rifle or sniper) that hurts a player also slows their running to 60% for 0.3 s (each hit restarts it; a dash or slide is not slowed).
The sniper (the Needle) also fires a bullet that flies (800 m/s, the same drop as the rifle's), so it has to be led too.
Tune movement against time-to-kill: if players are too hard to hit, gunplay degrades to spray and pray.

### Scoring and UI
Kills only. A scoreboard and a kill feed. The match timer is always visible.

## Build order
1. Movement and one weapon, local only (feel first).
2. Authoritative server, prediction, reconciliation, test vectors.
3. Two players in one arena: kills, respawns, scoreboard.
4. Up to 8 players, pickups, tuning.

## Out of scope for this mode
AI enemies, classes and abilities, control points, loot, progression, accounts.

## Open questions
- Sudden death on ties, or a shared win?
- Exact kill-heal tuning once playtested.
- Spawn protection length and shield recharge delay.
- Map size and layout.
