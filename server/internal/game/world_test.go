package game

import (
	"context"
	"testing"
	"time"
)

func TestTickLoop(t *testing.T) {
	w := NewWorld()
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
	w := NewWorld()
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
