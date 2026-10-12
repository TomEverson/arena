package game_test

import (
	"context"
	"testing"

	"arena/server/internal/game"
	"arena/server/internal/level"
)

// HARD RULE: the tick loop must not allocate, including while players run, slide,
// dash and mantle through the real level with every button in play.
func TestStepDoesNotAllocateWithMovingPlayers(t *testing.T) {
	lv, err := level.Load("../../../levels/greybox.json")
	if err != nil {
		t.Fatal(err)
	}
	w := game.NewWorld(lv)
	const n = 8
	players := make([]*game.Player, 0, n)
	for id := uint32(1); id <= n; id++ {
		p := game.NewPlayer(id)
		players = append(players, p)
		w.Join(context.Background(), p)
	}
	w.Step() // process joins

	moves := [...]float64{-1, 0, 1, 0.5, 1, 1}
	tick := 0
	run := func() {
		tick++
		for i, p := range players {
			k := tick + i*7
			w.SubmitInput(p.ID, game.Input{
				Seq:   uint32(tick),
				MoveX: moves[(k/20)%len(moves)],
				MoveZ: moves[(k/13+1)%len(moves)],
				Yaw:   float64(k) * 0.05,
				Jump:  k%37 == 0,
				Dash:  k%53 == 0,
				Slide: k%90 < 30,
				ADS:   k%70 < 10,
				Fire:  k%2 == 0,
				Melee: k%61 == 0,
				Slot:  uint8(k%97/30) % 4,
			})
		}
		w.Step()
		for _, p := range players {
			for len(p.Out) > 0 {
				p.Free <- <-p.Out
			}
		}
	}
	for i := 0; i < 120; i++ { // warm up
		run()
	}
	if allocs := testing.AllocsPerRun(600, run); allocs != 0 {
		t.Fatalf("Step with moving players allocated %v times per tick, want 0", allocs)
	}
}

// Wall running and wall jumping are part of the tick loop too: zero allocations while a
// player runs along a wall, kicks off it and runs again.
func TestWallRunDoesNotAllocate(t *testing.T) {
	floor := game.Aabb{MinX: -100, MaxX: 100, MinY: -1, MaxY: 0, MinZ: -100, MaxZ: 100}
	wall := game.Aabb{MinX: 0.8, MaxX: 2.8, MinY: 0, MaxY: 10, MinZ: -2000, MaxZ: 100}
	w := &game.CollisionWorld{Boxes: []game.Aabb{floor, wall}}
	s := game.SpawnState(0.5, 0, 0)
	in := game.Input{MoveZ: 1, Yaw: 0}
	ran := false
	tick := 0
	step := func() {
		tick++
		in.Jump = tick%90 == 25 || (s.WallRunning && tick%90 > 55)
		game.StepPlayer(&s, &in, w, 1.0/60)
		if s.WallRunning {
			ran = true
		}
	}
	for i := 0; i < 200; i++ {
		step()
	}
	if allocs := testing.AllocsPerRun(600, step); allocs != 0 {
		t.Fatalf("wall running allocated %v times per tick, want 0", allocs)
	}
	if !ran {
		t.Fatal("the test never wall ran, so it proves nothing")
	}
}
