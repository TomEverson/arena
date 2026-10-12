# 02. Tech Decisions

## Decided
| Area | Choice | Notes |
|------|--------|-------|
| Client language | TypeScript (strict) | Python can't run natively in browsers |
| Rendering | WebGL2 via Three.js | Three.js is a library, not an engine: no physics, netcode or entity system |
| Engine | None | Browser APIs cover input, audio, networking |
| Server language | **Go** | Real multi-core parallelism, cheap goroutines, short GC pauses; good for many players per match |
| Transport | WebSocket first | Behind an abstraction so WebTransport/WebRTC can replace it later |
| Wire format | JSON behind a `Codec` interface now, binary later | Swap once the message set settles |
| Task runner | pnpm workspaces + Turborepo | No Makefile |

## Browser APIs in play
Pointer Lock (mouse look), Web Audio, Web Workers (future chunk or mesh work), WebSocket.

## The cost of Go + TypeScript
Movement code must exist twice (client prediction and server truth). Mitigations:
- Keep movement a small pure function: `(state, input, dt) -> state`. No engine physics.
- **Shared test vectors** (recorded inputs + expected positions) run in both Go and TS test suites; CI fails on drift.
- Use float64 in Go to match JS numbers. Bit-exact equality is not required; the server corrects, the client smooths.
- Levels are shared JSON data, so geometry can't disagree.
- Rejected alternative: Rust/Go to WASM for a single shared sim (too heavy and not vibe-code-friendly).

## Rejected / deferred
- **Node server:** single-threaded; large matches would force splitting. Rejected in favor of Go.
- **Colyseus and similar frameworks:** impose patterns that fight custom prediction and reconciliation. Writing a thin custom layer, since understanding the netcode is part of the point.
- **WebTransport:** best long-term, thin tooling today. Revisit if TCP head-of-line blocking is felt.
- **Raw WebGL:** adds weeks before anything is on screen. Only if learning graphics becomes the goal.
