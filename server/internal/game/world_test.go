package game

import (
	"context"
	"testing"
	"time"
)

func TestTickLoop(t *testing.T) {
	w := NewWorld(nil)
	p := NewPlayer(7)
	other := NewPlayer(8)
	w.Join(context.Background(), p)
	w.Join(context.Background(), other)

	ctx, cancel := context.WithCancel(context.Background())
	ticks := make(chan time.Time)
	done := make(chan struct{})
	go func() { w.Run(ctx, ticks); close(done) }()

	const n = 8 // 4 snapshots == snapshotBuffers; an undrained client is skipped beyond that
	for i := 0; i < n; i++ {
		ticks <- time.Time{}
	}
	cancel()
	<-done

	if got := w.Tick(); got != n {
		t.Fatalf("tick = %d, want %d", got, n)
	}
	// 60 Hz tick / 30 Hz snapshots => one snapshot every 2 ticks.
	if got := len(p.Out); got != n/2 {
		t.Fatalf("snapshots = %d, want %d", got, n/2)
	}
	first := <-p.Out
	if first.Tick != 2 {
		t.Fatalf("first snapshot tick = %d, want 2", first.Tick)
	}
	// Your own state is `you`; entities lists everyone else.
	if len(first.Entities) != 1 || first.Entities[0].ID != 8 || first.Entities[0].TeamID != 8 {
		t.Fatalf("unexpected entities: %+v", first.Entities)
	}
	if first.You != p.State {
		t.Fatalf("snapshot you = %+v, want the player's state %+v", first.You, p.State)
	}
	if first.Type != "snapshot" {
		t.Fatalf("snapshot type = %q", first.Type)
	}
}

func TestStepDoesNotAllocate(t *testing.T) {
	w := NewWorld(nil)
	for id := uint32(1); id <= 8; id++ {
		w.Join(context.Background(), NewPlayer(id))
	}
	w.Step() // process joins
	drain := func() {
		for _, p := range w.players {
			for len(p.Out) > 0 {
				p.Free <- <-p.Out
			}
		}
	}
	allocs := testing.AllocsPerRun(200, func() {
		w.SubmitInput(1, Input{Seq: 1})
		w.Step()
		drain()
	})
	if allocs != 0 {
		t.Fatalf("Step allocated %v times per run, want 0", allocs)
	}
}

// One input is simulated per tick, in order, and the ack follows.
func TestInputQueueConsumesOnePerTick(t *testing.T) {
	w := NewWorld(nil)
	p := NewPlayer(1)
	w.Join(context.Background(), p)
	w.Step()
	for seq := uint32(1); seq <= 2; seq++ { // stays under the catch-up threshold
		w.SubmitInput(1, Input{Seq: seq, MoveZ: 1})
	}
	for want := uint32(1); want <= 2; want++ {
		w.Step()
		if p.ackSeq != want {
			t.Fatalf("after tick %d ackSeq = %d, want %d", want, p.ackSeq, want)
		}
	}
	w.Step() // queue empty: nothing new is acknowledged
	if p.ackSeq != 2 {
		t.Fatalf("ackSeq moved without input: %d", p.ackSeq)
	}
}

// Input-driven: with no input the player is not simulated at all, so its state
// is always exactly "the state after the last acknowledged input".
func TestEmptyQueueDoesNotSimulate(t *testing.T) {
	lv := FlatLevel()
	lv.Spawns = []Vec3{{X: 0, Y: 5, Z: 0}} // spawn in the air: gravity would move it
	w := NewWorld(lv)
	p := NewPlayer(1)
	w.Join(context.Background(), p)
	w.Step()
	before := p.State
	for i := 0; i < 10; i++ {
		w.Step()
	}
	if p.State != before {
		t.Fatalf("player was simulated with no input: %+v -> %+v", before, p.State)
	}
	w.SubmitInput(1, Input{Seq: 1})
	w.Step()
	if p.State.Y >= before.Y {
		t.Fatalf("player did not fall after an input: y = %v", p.State.Y)
	}
}

// A flooded queue drops the oldest inputs, keeping the player near real time.
func TestInputQueueDropsOldestWhenFull(t *testing.T) {
	w := NewWorld(nil)
	p := NewPlayer(1)
	w.Join(context.Background(), p)
	w.Step()
	for seq := uint32(1); seq <= InputQueueSize+4; seq++ {
		w.SubmitInput(1, Input{Seq: seq})
	}
	w.Step() // drains the inbox (oldest 4 dropped), then catches up by simulating two
	if want := uint32(6); p.ackSeq != want {
		t.Fatalf("ack after first tick = %d, want %d (seqs 5 and 6 simulated)", p.ackSeq, want)
	}
}

// Catch-up helps after a lag spike but cannot be used to run faster than real time for long.
func TestCatchUpIsBoundedByCredit(t *testing.T) {
	w := NewWorld(nil)
	p := NewPlayer(1)
	w.Join(context.Background(), p)
	w.Step()

	const ticks = 400
	seq := uint32(0)
	for i := 0; i < ticks; i++ {
		for p.qLen+len(w.inbox) < InputQueueSize { // a cheater keeps the queue full
			seq++
			w.SubmitInput(1, Input{Seq: seq})
		}
		w.Step()
	}
	simulated := float64(p.ackSeq)
	limit := float64(ticks) + catchUpCreditMax + catchUpRegen*ticks + 4 // 4: seqs dropped while the queue was full
	if simulated > limit+float64(InputQueueSize) {
		t.Fatalf("simulated %v inputs in %d ticks, want at most about %v", simulated, ticks, limit)
	}
	if simulated < ticks {
		t.Fatalf("simulated only %v inputs in %d ticks", simulated, ticks)
	}
}

// Redundant resends are skipped: a seq is simulated once.
func TestDuplicateInputsAreSkipped(t *testing.T) {
	w := NewWorld(nil)
	a, b := NewPlayer(1), NewPlayer(2)
	w.Join(context.Background(), a)
	w.Join(context.Background(), b)
	w.Step()
	in := func(seq uint32) Input { return Input{Seq: seq, MoveZ: 1} }

	// a gets the redundant stream the client really sends: 1; 1,2; 1,2,3; 2,3,4 ...
	for seq := uint32(1); seq <= 8; seq++ {
		for k := uint32(0); k < 3; k++ {
			if seq > k {
				w.SubmitInput(1, in(seq-k))
			}
		}
		w.SubmitInput(2, in(seq)) // b gets each input once
		w.Step()
	}
	if a.State != b.State || a.ackSeq != 8 || b.ackSeq != 8 {
		t.Fatalf("redundant stream diverged: a=%+v ack %d, b=%+v ack %d", a.State, a.ackSeq, b.State, b.ackSeq)
	}
}

// Respawn moves the player to a spawn point and keeps its queued inputs.
func TestRespawn(t *testing.T) {
	lv := FlatLevel()
	lv.Spawns = []Vec3{{X: 10, Y: 0, Z: 5}, {X: -10, Y: 0, Z: -5}}
	w := NewWorld(lv)
	p := NewPlayer(1)
	w.Join(context.Background(), p)
	w.Step()
	for seq := uint32(1); seq <= 30; seq++ {
		w.SubmitInput(1, Input{Seq: seq, MoveZ: 1})
		w.Step()
	}
	if p.State.Z > 4 {
		t.Fatalf("player did not move: z = %v", p.State.Z)
	}
	w.SubmitInput(1, Input{Seq: 31, MoveZ: 1})
	w.Respawn(context.Background(), 1)
	w.Step() // respawn applied, then input 31 simulated from the spawn point
	if p.State.X != -10 {
		t.Fatalf("respawned at x = %v, want the second spawn (-10)", p.State.X)
	}
	if p.State.Z > -5 || p.State.Z < -5.5 {
		t.Fatalf("input 31 should have been played from the spawn: z = %v", p.State.Z)
	}
}

// Players spawn at the level's spawn points in turn.
func TestPlayersSpawnAtLevelSpawns(t *testing.T) {
	lv := FlatLevel()
	lv.Spawns = []Vec3{{X: 10, Y: 0, Z: 5}, {X: -10, Y: 0, Z: -5}}
	w := NewWorld(lv)
	a, b, c := NewPlayer(1), NewPlayer(2), NewPlayer(3)
	for _, p := range []*Player{a, b, c} {
		w.Join(context.Background(), p)
	}
	w.Step()
	if a.State.X != 10 || b.State.X != -10 || c.State.X != 10 {
		t.Fatalf("spawn rotation wrong: %v %v %v", a.State.X, b.State.X, c.State.X)
	}
	if a.Entity.X != a.State.X {
		t.Fatalf("entity not synced with state")
	}
}

// Remote players need yaw, pitch and posture flags to be drawn.
func TestEntityCarriesViewAndPostureFlags(t *testing.T) {
	w := NewWorld(nil)
	p := NewPlayer(1)
	w.Join(context.Background(), p)
	w.Step()
	for seq := uint32(1); seq <= 3; seq++ {
		w.SubmitInput(1, Input{Seq: seq, Yaw: 1.5, Pitch: -0.25, Slide: true})
		w.Step()
	}
	if p.Entity.Yaw != 1.5 || p.Entity.Pitch != -0.25 {
		t.Fatalf("entity view = %v, %v", p.Entity.Yaw, p.Entity.Pitch)
	}
	if p.Entity.Flags&2 != 0 { // standing still holding slide => crouch (1), not slide (2)
		t.Fatalf("unexpected slide flag: %b", p.Entity.Flags)
	}
	if p.Entity.Flags&1 == 0 || p.Entity.Flags&16 == 0 {
		t.Fatalf("expected crouching and onGround flags, got %b", p.Entity.Flags)
	}
}
