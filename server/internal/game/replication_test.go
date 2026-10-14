package game

import (
	"testing"

	"arena/server/internal/protocol"
)

// A client that loses half its snapshots (and so acknowledges only the ones it got) must still
// end up with the true picture: where a player who has stopped is standing, and no grenade left
// on screen after it has gone off. Snapshots travel as datagrams, so this is the normal case.
func TestSnapshotsSurviveLoss(t *testing.T) {
	d := newDuel(t, nil, Vec3{}, Vec3{X: 6, Z: -6})
	screen := map[uint32]Entity{}
	got, lost, sawGrenade := 0, 0, false
	n := 0
	step := func(in *Input) {
		x := Input{}
		if in != nil {
			x = *in
		}
		d.seq[d.a.ID]++
		x.Seq = d.seq[d.a.ID]
		d.w.SubmitInput(d.a.ID, x)
		d.w.Step()
		for len(d.a.Out) > 0 {
			d.a.Free <- <-d.a.Out
		}
		for len(d.b.Out) > 0 {
			s := <-d.b.Out
			n++
			if n%2 == 0 || n%7 == 0 { // lost on the way: never seen, never acknowledged
				lost++
				d.b.Free <- s
				continue
			}
			got++
			if s.Full {
				clear(screen)
			}
			for _, id := range s.Removed {
				delete(screen, id)
			}
			for _, e := range s.Entities {
				screen[e.ID] = e
				sawGrenade = sawGrenade || e.Kind == protocol.EntityKindGrenade
			}
			d.w.AckSnapshot(d.b.ID, s.Tick)
			d.b.Free <- s
		}
	}
	for i := 0; i < 20; i++ {
		step(nil)
	}
	step(&Input{SkillQ: true, Pitch: -0.2}) // a throws a grenade
	for i := 0; i < 40; i++ {
		step(&Input{MoveX: 1}) // and runs sideways
	}
	for i := 0; i < int(SkillGrenadeFuse*TickRate)+90; i++ {
		step(nil) // then stands still: nothing changes any more, so nothing new would be sent
	}
	if got == 0 || lost == 0 || !sawGrenade {
		t.Fatalf("the test proves nothing: got %d, lost %d, saw the grenade %v", got, lost, sawGrenade)
	}
	seen, ok := screen[d.a.ID]
	if !ok {
		t.Fatalf("b's screen has lost player a: %v", screen)
	}
	if seen.X != d.a.Entity.X || seen.Z != d.a.Entity.Z || d.a.Entity.X < 1 {
		t.Fatalf("b sees a at (%v, %v) but a stopped at (%v, %v)", seen.X, seen.Z, d.a.Entity.X, d.a.Entity.Z)
	}
	for id, e := range screen {
		if e.Kind == protocol.EntityKindGrenade {
			t.Fatalf("b still has grenade %d on screen after it went off", id)
		}
	}
}

// Until the client acknowledges a snapshot, every one it is sent is a full one.
func TestSnapshotsStayFullUntilOneIsAcknowledged(t *testing.T) {
	d := newDuel(t, nil, Vec3{}, Vec3{Z: -10})
	var ticks []uint32
	for i := 0; i < 12; i++ {
		d.w.Step()
		for len(d.a.Out) > 0 {
			s := <-d.a.Out
			if !s.Full {
				t.Fatalf("snapshot %d is a delta before anything was acknowledged", s.Tick)
			}
			ticks = append(ticks, s.Tick)
			d.a.Free <- s
		}
		for len(d.b.Out) > 0 {
			d.b.Free <- <-d.b.Out
		}
	}
	d.w.AckSnapshot(d.a.ID, ticks[len(ticks)-1])
	sawDelta := false
	for i := 0; i < 6; i++ {
		d.w.Step()
		for len(d.a.Out) > 0 {
			s := <-d.a.Out
			sawDelta = sawDelta || !s.Full
			d.a.Free <- s
		}
		for len(d.b.Out) > 0 {
			d.b.Free <- <-d.b.Out
		}
	}
	if !sawDelta {
		t.Fatal("after an acknowledgement the snapshots should be deltas")
	}
}
