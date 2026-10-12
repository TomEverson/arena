package game_test

import (
	"fmt"
	"math"
	"path/filepath"
	"testing"

	"arena/server/internal/game"
	"arena/server/internal/level"
)

// Replays /testvectors/melee, recorded from the TypeScript melee code (`pnpm vectors`).

const meleeVectorDir = "../../../testvectors/melee"

type meleeVector struct {
	Name  string `json:"name"`
	World struct {
		Level string      `json:"level"`
		Boxes []game.Aabb `json:"boxes"`
		Ramps []game.Ramp `json:"ramps"`
	} `json:"world"`
	Targets []game.Hitbox `json:"targets"`
	Cases   []struct {
		Eye    [3]float64 `json:"eye"`
		Dir    [3]float64 `json:"dir"`
		Expect struct {
			TargetID int     `json:"targetId"`
			Dist     float64 `json:"dist"`
		} `json:"expect"`
	} `json:"cases"`
}

func TestMeleeVectors(t *testing.T) {
	for _, v := range readAll[meleeVector](t, meleeVectorDir) {
		t.Run(v.Name, func(t *testing.T) {
			var w *game.CollisionWorld
			if v.World.Level != "" {
				lv, err := level.Load(filepath.Join(levelDir, v.World.Level+".json"))
				if err != nil {
					t.Fatal(err)
				}
				w = &lv.Collision
			} else {
				w = &game.CollisionWorld{Boxes: v.World.Boxes, Ramps: v.World.Ramps}
			}
			var problems []string
			for i, c := range v.Cases {
				id, dist := game.FindMeleeTarget(w, v.Targets, c.Eye[0], c.Eye[1], c.Eye[2], c.Dir[0], c.Dir[1], c.Dir[2])
				if id != c.Expect.TargetID {
					problems = append(problems, fmt.Sprintf("swing %d: hit %d, want %d", i, id, c.Expect.TargetID))
				} else if id >= 0 && math.Abs(dist-c.Expect.Dist) > 1e-6 {
					problems = append(problems, fmt.Sprintf("swing %d: distance %v, want %v", i, dist, c.Expect.Dist))
				}
			}
			report(t, v.Name, problems)
		})
	}
}
