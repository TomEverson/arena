# 06. Repo and Setup

## Decided: one monorepo, pnpm workspaces + Turborepo

```
arena/
  package.json, pnpm-workspace.yaml, turbo.json, .gitlab-ci.yml (CI not wired up yet)
  AGENTS.md          rules for the AI coding tool
  spec/
    brainstorm/      this folder: brainstorming and decisions
    docs/            design.md, architecture.md (polished)
    phases/p1/       milestone plans (m1.md ... m9.md)
  client/            Vite + TypeScript + Three.js; ESLint + Prettier config lives here
  server/            Go module + thin package.json wrapper
  protocol/          messages.json -> generated Go and TypeScript wire types
  shared/            params.json (tuning numbers) -> generated Go constants
  levels/            level JSON: geometry, control points, spawns, practice targets
  testvectors/       recorded inputs + expected state, replayed by Go and TypeScript
  tools/bots/        Go fake-client load tester (placeholder)
  go.work            covers server and tools/bots
```

## Root scripts
- `pnpm dev`: Vite client and Go server (air hot reload) in parallel, prefixed logs
- `pnpm dev:lag`: same, with the server's fake network (80 ms each way, 3% loss)
- `pnpm test`: Vitest + `go test ./...` + checks that generated code is current
- `pnpm lint`: ESLint (type-aware) + Prettier check + tsc, and go vet + gofmt (+ golangci-lint if installed)
- `pnpm format`: auto-fix the client (ESLint `--fix`, then Prettier)
- `pnpm build`
- `pnpm gen`: regenerate Go constants from `shared/params.json` and wire types from `protocol/messages.json`
- `pnpm vectors`: re-record `testvectors/` from the TypeScript sim
- `pnpm netcheck`: end-to-end netcode check, two headless players against the real server
- `pnpm bots`: fake clients (placeholder)

## Tooling
- **Client:** pnpm, Vite, strict TypeScript 6 (TypeScript 7 has no JS API yet, which `typescript-eslint` needs), Vitest, ESLint with `typescript-eslint` type-aware rules, Prettier, Three.js
- **Server:** Go 1.26, quic-go/webtransport-go (the game transport), coder/websocket (the test tools' transport), air, golangci-lint (optional; lint skips it if missing)
- **CI:** GitLab CI calling the same pnpm scripts (file written, not run or wired up yet)
- **Deploy (later):** one Docker image per match on a DigitalOcean droplet, Cloudflare in front of the static client

## Notes
- Turborepo doesn't understand Go natively: it only runs wrapped scripts. `turbo.json` lists the files outside each package (`testvectors/`, `levels/`, `shared/`, `protocol/`, the generated files) as task inputs so changing them re-runs the tests instead of replaying a cached result.
- Levels are data: both sides load the same JSON, so geometry can't drift.
- `protocol/` and `shared/` are the single sources of truth for messages and tuning numbers; the generated files are never hand-edited. `pnpm test` fails if they are stale.
- Movement is written twice (TypeScript reference, Go port) and locked together by `testvectors/`.

## AGENTS.md rules (for vibe coding)
- Server authoritative, client predicts; the server is input-driven
- No allocations in the server tick loop
- Movement function lives only in designated files
- Any movement change must update `testvectors/` (`pnpm vectors`)
- Never hand-edit generated code; change `protocol/messages.json` or `shared/params.json` and run `pnpm gen`
- Every entity carries `teamId`
- Snapshot building goes through `entitiesFor(player)`
- All commands listed once, plus a pointer to `spec/` and `spec/docs/design.md`

## Setup order
1. Repo, task runner, lint, empty CI (done; CI file exists but is not wired up)
2. Client: Three.js scene, fixed loop (done; the fly camera was later removed)
3. Server: Go WebSocket echoing a tick counter (done)
4. Protocol with `Codec` boundary; input and snapshot messages (done, generated from `protocol/`)
5. Shared movement function, level loader, first test vectors (done)
6. Client prediction against the real server with fake latency (done, M4)

Stop after step 6 (two browser tabs see each other move), then start combat (M5 onward; the first mode is now FFA deathmatch, see `spec/phases/p1/`).

## Status
- Steps 1-6 built. Progress per milestone is tracked in `spec/phases/p1/`.

## Change log
- 2026-10-12: Client linting and formatting use ESLint + Prettier (type-aware lint rules; needs TypeScript 6). Docs moved under `spec/docs/`; `shared/` and `protocol/` added as generated-code sources.
