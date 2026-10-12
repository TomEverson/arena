# 08. Roadmap

## Milestone 0: Spec and setup (current)
- [x] Brainstorm direction, stack, art style, mode
- [x] Write `spec/` docs
- [ ] Run scaffold prompt: monorepo, Vite client, Go server, AGENTS.md, CI
- [ ] Fill `docs/design.md` from `spec/04-game-design.md`

## Milestone 1: Local feel (no network)
- Three.js scene with the lo-fi shader (low-res, fog, vertex snap)
- Fast movement: jump, dash, slide
- One hitscan weapon, hitstop, screenshake, particles
- Goal: movement feels good before anything else is built

## Milestone 2: One client, authoritative Go server
- 60 Hz server tick, input channel, snapshots
- Client prediction + reconciliation
- Shared movement function with test vectors in CI
- Fake latency and loss flags

## Milestone 3: Two players (two teams of one)
- Interpolation of the remote player
- Shooting, server-side hit detection, lag compensation
- Shared level JSON loaded by both sides

## Milestone 4: Control-point loop
- Control points: capture, hold, resource generation
- Spawn zones, respawn rules (per open question)
- Team scoring and a win condition

## Milestone 5: PvE
- Server-side AI as ordinary entities
- AI tied to the economy (drops, blood-heal) and to contested points

## Milestone 6: Teams and scale
- Teams of 2, then 4-6
- Bot clients for load tests: 8, then 32 players
- Relevance function and snapshot optimization as measurements demand

## Milestone 7: Friend-ready
- Join-by-link lobby
- Docker image, deploy to DigitalOcean + Cloudflare
- Playtest with the friend group; collect "funny moments" and pain points

## Later
- Second mode (send-the-horde, boss race, ...)
- Binary protocol, interest management, WebTransport
- More maps, enemy types, roles
