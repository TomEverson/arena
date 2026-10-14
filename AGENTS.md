# AGENTS.md

Browser-based multiplayer 3D FPS. **[spec/brainstorm/](spec/brainstorm/README.md) is the source of truth for *why*** (vision, tech decisions,
netcode, open questions, roadmap); `spec/docs/` is the polished *what*. Check `spec/brainstorm/` before changing a decided item.
Game design: see [spec/docs/design.md](spec/docs/design.md)
(game mode: control-point war, PvPvE; the 2-player baseline is tested as two teams of one).
Architecture details: [spec/docs/architecture.md](spec/docs/architecture.md).

## Architecture
- The **server is authoritative**. The **client predicts** and reconciles against snapshots.
- Movement logic is shared **in logic, not in code**: Go (`server/internal/game/movement.go`) and
  TypeScript (`client/src/sim/movement.ts`) are separate implementations that must both pass the same
  vectors in `testvectors/movement/`. The TypeScript sim is the reference; vectors are recorded from it.
- Tuning numbers live once, in `shared/params.json`. TS imports it; Go constants are **generated** (`pnpm gen`).
- The server is **input-driven**: a player only moves when an input arrives, so its state is always "after input ackSeq". The client predicts with the same `stepPlayer` and reconciles against snapshots (`client/src/net/prediction.ts`).
- One goroutine owns the world; network goroutines only communicate through channels. No locks in the simulation.
- The game is played over **WebTransport** (QUIC over UDP): snapshots, inputs and pings are datagrams that may be lost, so snapshots are deltas the server repeats until the client acknowledges them, and inputs are sent several times over. Messages that must arrive use one reliable stream. Binary frames carry structs as arrays in field order (no names on the wire), so a change to `protocol/messages.json` needs both sides deployed. The WebSocket `/ws` remains for the headless test players and `?transport=ws`. See `spec/brainstorm/05-netcode.md`.

## Hard rules
1. **No allocations in the server tick loop** (`World.Step` and everything it calls). `TestStepDoesNotAllocate` must stay green.
2. **The movement function lives only in the designated files** (`server/internal/game/movement.go`,
   `client/src/sim/` : movement.ts, collision.ts, params.ts, types.ts, level.ts). Do not duplicate movement math elsewhere.
   Combat math (fire rate, spread, recoil, damage, hitscan, bullet flight) likewise lives only in `client/src/sim/weapon.ts`, `hitscan.ts` and `bullet.ts` (Go twin: `server/internal/game/weapon.go`, `hitscan.go`, `bullet.go`), locked together by `testvectors/weapon`, `testvectors/hitscan` and `testvectors/bullet`. Hero skills (grenade, barrier, bombardment, recharge pickups) are server-only (`server/internal/game/skills.go`); only their cooldowns are in the shared weapon sim. There is no offline mode: the client never simulates the world on its own. Projectile weapons are flown by the server (`bullets.go`) and only the server decides damage. Keep both pure and deterministic: no `Math.random`, seeded RNG only. Health, lag compensation, death and respawn are server-only (`server/internal/game/combat.go`).
3. **Never hand-edit generated code** (`params_gen.go`, `protocol_gen.go`, `protocol.gen.ts`). Change the source (`shared/params.json`, `protocol/messages.json`) and run `pnpm gen`.
4. **Any change to movement must update `testvectors/`** in the same commit, and both Go and TS tests must pass. Workflow: edit `shared/params.json` and/or the sim, port to Go, then `pnpm gen`, `pnpm vectors`, `pnpm test`. Never hand-edit vectors or `params_gen.go`.
5. **Every entity carries a `teamId`** from the start. Teams of 1 today; design for teams of 4-6. Never assume team == player.
6. **Snapshot building goes through `entitiesFor(player)`**, which currently returns everything. Visibility/interest rules go there and nowhere else.
7. Message encoding goes through the `wire.Codec` interface; don't call `encoding/json` from game or handler code. Message and state shapes come from `protocol/messages.json`.

## Commands (run from repo root; pnpm + Turborepo, no Makefile)
| Command | What it does |
|---|---|
| `pnpm install` | Install JS deps (Go deps resolve on first build) |
| `pnpm dev` | Client (Vite :5173) + server (air :8080) in parallel, prefixed logs |
| `pnpm test` | Vitest + `go test ./...` + check that generated Go params are current |
| `pnpm lint` | ESLint (type-aware) + Prettier check + tsc, and `go vet` + gofmt + golangci-lint (skipped if not installed) |
| `pnpm format` | Auto-fix the client: ESLint `--fix` (also sorts imports) then Prettier `--write` |
| `pnpm build` | `vite build` + `go build -o server/bin/server` |
| `pnpm gen` | Regenerate generated code: Go constants from `shared/params.json`, wire types from `protocol/messages.json` |
| `pnpm dev:lag` | Like `pnpm dev`, with the server's fake network (80 ms each way, 3% loss) |
| `pnpm netcheck` | End-to-end netcode check: two headless players against the real server (needs Go; takes about 20 s) |
| `pnpm practicecheck` | End-to-end practice-range check: a bot shooting strafing targets with and without lag compensation, no player-vs-player damage, the helper commands (about 70 s) |
| `pnpm matchcheck` | End-to-end match-flow check: countdown, live, results, rematch, a late joiner (about 40 s) |
| `pnpm combatcheck` | End-to-end combat check: two bots fight through the fake network, with and without lag compensation (about 80 s) |
| `pnpm vectors` | Re-record `testvectors/movement/*.json` from the TS sim (runs each scenario's verify) |
| `pnpm bots` | Placeholder (prints "not implemented yet") |
| `pnpm deploy:server` | Build the server for Linux and install it on the droplet (settings in `deploy/.env`; see [spec/docs/deploy.md](spec/docs/deploy.md)). Restarts the server: running rooms end |
| `pnpm deploy:client` | Build the client against the deployed server and publish it to Cloudflare Workers (`client/wrangler.jsonc`) |

Server flags: `--addr=:8080 --level=../levels/greybox.json --fake-latency=80ms --loss=3%`, and for the match cycle `--countdown=5s --match-length=6m --results=15s --room-idle=1m`, `--no-match` (FFA rooms always live), `--practice-level=../levels/greybox.json` (the practice range's level) `--allowed-origins=host,host` (the sites the client may be served from when it is not on the server's own host), and for WebTransport `--wt-addr=:443` (its UDP address; default the same port as `--addr`, `off` turns it off) with `--wt-cert` / `--wt-key` (a real certificate; without them a self-signed development one, which browsers accept by the hash `GET /api/transport` hands out). Health: `GET /healthz`. A room has a mode, `ffa` or `practice`: `POST /api/rooms {"mode":"practice"}`, and players join with `/?room=CODE`. Opening the page without a room link shows a start screen (or use `?mode=practice` / `?mode=ffa`). The start screen asks for a username and keeps it in localStorage (`arena.name`, `client/src/username.ts`); a link opened without one asks first. The name is not sent to the server yet.
Prereqs: Node 22+, pnpm 10, Go 1.26+ (the `go` command fetches it by itself if yours is older), `air` (`go install github.com/air-verse/air@latest`), optional `golangci-lint`.

## Layout
`client/` Vite+TS+Three.js (ESLint + Prettier config in `client/`) · `server/` Go module · `protocol/` wire messages source of truth (generated Go + TS) ·
`shared/` shared tuning numbers + Go codegen · `levels/` level JSON · `testvectors/` shared movement vectors · `tools/bots/` fake clients · `deploy/` deploy scripts and droplet config · `spec/` (`brainstorm/` notes, `docs/` polished docs)

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
