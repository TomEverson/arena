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
  vectors in `testvectors/`.
- One goroutine owns the world; network goroutines only communicate through channels. No locks in the simulation.

## Hard rules
1. **No allocations in the server tick loop** (`World.Step` and everything it calls). `TestStepDoesNotAllocate` must stay green.
2. **The movement function lives only in the designated files** (`server/internal/game/movement.go`,
   `client/src/sim/` : movement.ts, collision.ts, params.ts, types.ts, level.ts). Do not duplicate movement math elsewhere.
   Combat math (fire rate, spread, recoil, damage, hitscan) likewise lives only in `client/src/sim/weapon.ts` and `hitscan.ts` (Go twin: `server/internal/game/weapon*.go`, M5). Keep both pure and deterministic: no `Math.random`, seeded RNG only.
3. **Never hand-edit generated code.** Change the generator/source (future: `protocol/`) and regenerate.
4. **Any change to movement must update `testvectors/`** in the same commit, and both Go and TS tests must pass.
5. **Every entity carries a `teamId`** from the start. Teams of 1 today; design for teams of 4-6. Never assume team == player.
6. **Snapshot building goes through `entitiesFor(player)`**, which currently returns everything. Visibility/interest rules go there and nowhere else.
7. Message encoding goes through the `wire.Codec` interface; don't call `encoding/json` from game or handler code.

## Commands (run from repo root; pnpm + Turborepo, no Makefile)
| Command | What it does |
|---|---|
| `pnpm install` | Install JS deps (Go deps resolve on first build) |
| `pnpm dev` | Client (Vite :5173) + server (air :8080) in parallel, prefixed logs |
| `pnpm test` | Vitest + `go test ./...` |
| `pnpm lint` | Biome + tsc, and `go vet` + gofmt + golangci-lint (skipped if not installed) |
| `pnpm build` | `vite build` + `go build -o server/bin/server` |
| `pnpm bots` | Placeholder (prints "not implemented yet") |

Server flags: `--addr=:8080 --fake-latency=80ms --loss=3%`. Health: `GET /healthz`.
Prereqs: Node 22+, pnpm 10, Go 1.24+, `air` (`go install github.com/air-verse/air@latest`), optional `golangci-lint`.

## Layout
`client/` Vite+TS+Three.js · `server/` Go module · `protocol/` future message source of truth ·
`levels/` level JSON · `testvectors/` shared movement vectors · `tools/bots/` fake clients · `spec/` (`brainstorm/` notes, `docs/` polished docs)

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
