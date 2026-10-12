package game_test

import (
	"context"
	"testing"

	"arena/server/internal/game"
	"arena/server/internal/level"
)

// HARD RULE: the tick loop must not allocate, including while players run, slide,
// dash, climb and mantle through the real level with every button in play.
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
				Seq:      uint32(tick),
				MoveX:    moves[(k/20)%len(moves)],
				MoveZ:    moves[(k/13+1)%len(moves)],
				Yaw:      float64(k) * 0.05,
				Jump:     k%37 == 0,
				JumpHeld: k%120 < 40,
				Dash:     k%53 == 0,
				Slide:    k%90 < 30,
				ADS:      k%70 < 10,
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
