# 04. Game Design

## Decided
- **Format:** PvPvE. Teams fight each other and AI enemies.
- **Team size:** 4-6 players per team (base requirement), possibly more.
- **First mode:** **Control-point war.**
- **Baseline test:** 2 players, tested as **two teams of one** so the PvP half is exercised.
- **Friendly fire:** off.
- **Death:** never full elimination (friend-group rule). Exact mechanism open.

## Core PvPvE question
*Why would a player shoot another player instead of the AI?* The AI must shape the PvP: it is a resource, a threat, or a weapon, never just filler.

Levers for tying AI to PvP:
- **Resource economy:** AI drops health, ammo or score. Ultrakill's "blood is health" fits naturally.
- **Contested objectives:** bosses and events whose reward is fought over.
- **Noise and attention:** gunfire attracts AI to both sides.
- **Environmental pressure:** zone, rising threat.
- **High-value targets:** players carry a bounty.

## Mode 1: Control-point war
- Teams capture points on the map. Held points generate resources and attract AI invasions.
- Scales from 2 players to full squads without new systems; larger teams get natural roles (capture, defend, push).
- 2-player test: a small map with a few points and shared AI pressure.

## Mode ideas backlog (not yet chosen)
1. **Send-the-horde:** killing AI earns currency, spent to send harder waves at rival teams (creep-sending). AI is both income and weapon. *Favorite candidate for a later mode, possibly with a central boss.*
2. **Race to the boss:** huge central boss needs focused team damage; rivals sabotage or steal the final blow.
3. **Heist/vault:** vault opens on a timer; carry the item to your base; carrier is slowed and highlighted.
4. **Respawn battle royale:** shrinking zone, dying sends you to a short "gulag" fight against AI.
5. **Siege:** each team fortifies a base, waves attack all, destroy a rival base to win.
6. **Hybrid extraction + battle royale** (explored and set aside as the base): about 8-10 min match: scavenge, boss spawns at about 3:00, zone shrinks, extraction window, collapse. Win by extracted value; dying drops loot. Keep as a possible later mode.

## Mechanics ideas (team-scale, Ultrakill feel)
- **Team style meter:** shared kills and stunts feed one meter that unlocks team buffs.
- **Blood-share healing:** kills heal nearby teammates, which pushes squads to fight close.
- **Revive by killing:** a downed player gets up when a teammate kills an enemy near the body.
- **Ghost help after death:** dead players can ping, trigger traps or distract AI until respawn.
- **Comeback mechanics:** the leading team is more visible, or the trailing team gets a boost.
- **Pings and a quick team wheel**, often more valuable than any weapon in a big squad.
- **Light roles** (frontline / support / scout) with one signature ability each, no uniqueness restriction.
- **Early respawn / reinforcement** that closes later in the match.

## Friend-group requirements checklist
- [ ] Join by link, lobby in seconds
- [ ] Uneven team sizes handled (bots fill slots or objectives scale)
- [ ] No elimination downtime
- [ ] Useful role for every skill level
- [ ] Short matches

## Data model rules (apply from day one)
- Every entity (player, AI, projectile, loot) carries a `teamId`.
- Scoring and objectives are written in terms of teams, even when teams have one player.
- Bots are just server-side players (also used for load testing).
