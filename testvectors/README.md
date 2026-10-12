# testvectors

Placeholder for shared movement test vectors. Each vector is
`(initial state, input, dt) -> expected state`, stored as data and consumed by
**both** the Go tests (`server/internal/game`) and the Vitest tests
(`client/src/sim`). This is what keeps client prediction and the
authoritative server in lockstep.

Rule: any change to movement code must update the vectors here, and both
test suites must pass against the same files.
