package game

import (
	"context"
	"testing"
	"time"
)

func TestTickLoop(t *testing.T) {
	w := NewWorld(nil)
	p := NewPlayer(7)
	w.Join(context.Background(), p)

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
	if len(first.Entities) != 1 || first.Entities[0].ID != 7 || first.Entities[0].TeamID != 7 {
		t.Fatalf("unexpected entities: %+v", first.Entities)
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

// One input is consumed per tick, in order, and the ack follows.
func TestInputQueueConsumesOnePerTick(t *testing.T) {
	w := NewWorld(nil)
	p := NewPlayer(1)
	w.Join(context.Background(), p)
	w.Step()
	for seq := uint32(1); seq <= 3; seq++ {
		w.SubmitInput(1, Input{Seq: seq, MoveZ: 1})
	}
	for want := uint32(1); want <= 3; want++ {
		w.Step()
		if p.ackSeq != want {
			t.Fatalf("after tick %d ackSeq = %d, want %d", want, p.ackSeq, want)
		}
	}
	w.Step() // queue empty: nothing new is acknowledged
	if p.ackSeq != 3 {
		t.Fatalf("ackSeq moved without input: %d", p.ackSeq)
	}
}

// With no queued input the last held input repeats, but one-shot presses never do.
func TestEmptyQueueRepeatsHeldButNotPresses(t *testing.T) {
	w := NewWorld(nil)
	p := NewPlayer(1)
	w.Join(context.Background(), p)
	w.Step()
	w.Step() // settle on the floor

	w.SubmitInput(1, Input{Seq: 1, MoveZ: 1})
	w.Step()
	for i := 0; i < 30; i++ {
		w.Step()
	}
	if p.State.VZ > -10 {
		t.Fatalf("held forward input should keep running, vz = %v", p.State.VZ)
	}

	w.SubmitInput(1, Input{Seq: 2, MoveZ: 1, Jump: true})
	w.Step()
	if p.State.VY <= 0 {
		t.Fatalf("jump press should jump, vy = %v", p.State.VY)
	}
	airJumpsAfterFirst := p.State.AirJumps
	for i := 0; i < 5; i++ {
		w.Step() // repeated ticks must not re-press jump (would burn the air jump)
	}
	if p.State.AirJumps != airJumpsAfterFirst {
		t.Fatalf("jump press was repeated: air jumps %d -> %d", airJumpsAfterFirst, p.State.AirJumps)
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
	w.Step() // drains the inbox into the queue, consumes the oldest survivor
	if want := uint32(5); p.ackSeq != want {
		t.Fatalf("first consumed seq = %d, want %d (oldest 4 dropped)", p.ackSeq, want)
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
