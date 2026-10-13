# /spec: Brainstorming and Design Notes

Living notes for the browser multiplayer FPS. This is where ideas, decisions and open questions live, before they become code.

## How to use this folder
- Every file separates **Decided** (locked unless we explicitly revisit) from **Ideas** (candidates, not commitments) and **Open questions**.
- When a decision changes, edit the file and add a line to the Decision Log below. Don't silently overwrite.
- `AGENTS.md` and `docs/design.md` in the repo root should point here. Treat `spec/` as the source of truth for *why*, and `docs/` as the polished *what*.

## Index
| File | Contents |
|------|----------|
| [01-vision.md](01-vision.md) | What the game is, goals, constraints, non-goals |
| [02-tech-decisions.md](02-tech-decisions.md) | Language, rendering, server, networking choices |
| [03-art-style.md](03-art-style.md) | Visual direction (Ultrakill-like), no-modeling pipeline |
| [04-game-design.md](04-game-design.md) | PvPvE, teams, control-point mode, mechanics ideas |
| [05-netcode.md](05-netcode.md) | Authority model, prediction, scaling plan |
| [06-repo-and-setup.md](06-repo-and-setup.md) | Monorepo layout, tooling, dev loop, AI-coding rules |
| [07-open-questions.md](07-open-questions.md) | Everything still undecided |
| [08-roadmap.md](08-roadmap.md) | Milestones in order |
| [09-heroes.md](09-heroes.md) | Heroes and their skills: Trooper and Assassin |

## Decision Log
| Date | Decision |
|------|----------|
| 2026-10-12 | Browser-only, no game engine, 3D FPS |
| 2026-10-12 | TypeScript client; Go authoritative server |
| 2026-10-12 | Ultrakill-style look via shaders and code-generated assets |
| 2026-10-12 | PvPvE, team-based (4-6+ per team), first mode: control-point war |
| 2026-10-12 | Build and test with 2 players (two teams of one); design for 32 |
| 2026-10-12 | pnpm workspaces + Turborepo instead of Makefile |
| 2026-10-12 | Client lint and format with ESLint + Prettier (type-aware lint needs TypeScript 6); see 06-repo-and-setup.md |
| 2026-10-13 | Heroes with skills (Q, E, ultimate), starting with Trooper and Assassin; Trooper built first; see 09-heroes.md |
