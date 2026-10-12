# 06. Repo and Setup

## Decided: one monorepo, pnpm workspaces + Turborepo

```
arena/
  package.json, pnpm-workspace.yaml, turbo.json, .gitlab-ci.yml
  AGENTS.md          rules for the AI coding tool
  spec/              this folder: brainstorming and decisions
  docs/              design.md, architecture.md (polished)
  client/            Vite + TypeScript + Three.js
  server/            Go module + thin package.json wrapper
  protocol/          message schema -> generated Go/TS code
  levels/            level JSON: geometry, control points, spawns
  testvectors/       recorded inputs + expected positions (Go + TS)
  tools/bots/        Go fake-client load tester
  go.work            covers server and tools/bots
```

## Root scripts
- `pnpm dev`: Vite client and Go server (air hot reload) in parallel, prefixed logs
- `pnpm test`: Vitest + `go test ./...` (includes shared movement vectors)
- `pnpm lint`, `pnpm build`
- `pnpm bots`: fake clients (placeholder at first)

## Tooling
- **Client:** pnpm, Vite, strict TypeScript, Vitest, Biome, Three.js
- **Server:** current stable Go, coder/websocket or gorilla/websocket, air, golangci-lint
- **CI:** GitLab CI calling the same pnpm scripts
- **Deploy (later):** one Docker image per match on a DigitalOcean droplet, Cloudflare in front of the static client

## Notes
- Turborepo doesn't understand Go natively: it only runs wrapped scripts. List Go inputs manually if caching is wanted. Plain `pnpm -r --parallel dev` is enough to start.
- Levels are data: both sides load the same JSON, so geometry can't drift.
- Protocol folder is the single source of truth for messages; never hand-edit generated code.

## AGENTS.md rules (for vibe coding)
- Server authoritative, client predicts
- No allocations in the server tick loop
- Movement function lives only in designated files
- Any movement change must update `testvectors/`
- Every entity carries `teamId`
- Snapshot building goes through `entitiesFor(player)`
- All commands listed once, plus a pointer to `spec/` and `docs/design.md`

## Setup order
1. Repo, task runner, lint, empty CI
2. Client: Three.js scene, fixed loop, fly camera
3. Server: Go WebSocket echoing a tick counter
4. Protocol with `Codec` boundary; input and snapshot messages
5. Shared movement function, level loader, first test vectors
6. Client prediction against the real server with fake latency

Stop after step 6 (two browser tabs see each other move), then start the control-point work.

## Status
- Scaffold prompt for Claude Code written (steps 1-3). Not yet run.
