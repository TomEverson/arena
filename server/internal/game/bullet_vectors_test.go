package game_test

import (
	"fmt"
	"path/filepath"
	"testing"

	"arena/server/internal/game"
	"arena/server/internal/level"
)

// Replays /testvectors/bullet, recorded from the TypeScript bullet physics (`pnpm vectors`).

const bulletVectorDir = "../../../testvectors/bullet"

type bulletVector struct {
	Name  string  `json:"name"`
	Dt    float64 `json:"dt"`
	World struct {
		Level string      `json:"level"`
		Boxes []game.Aabb `json:"boxes"`
		Ramps []game.Ramp `json:"ramps"`
	} `json:"world"`
	Origin  [3]float64      `json:"origin"`
	Dir     [3]float64      `json:"dir"`
	Speed   float64         `json:"speed"`
	Range   float64         `json:"range"`
	Targets [][]game.Hitbox `json:"targets"`
	Steps   []struct {
		X         float64     `json:"x"`
		Y         float64     `json:"y"`
		Z         float64     `json:"z"`
		VX        float64     `json:"vx"`
		VY        float64     `json:"vy"`
		VZ        float64     `json:"vz"`
		Travelled float64     `json:"travelled"`
		Done      bool        `json:"done"`
		Hit       game.RayHit `json:"hit"`
	} `json:"steps"`
}

func TestBulletVectors(t *testing.T) {
	for _, v := range readAll[bulletVector](t, bulletVectorDir) {
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
			b := game.SpawnBullet(v.Origin[0], v.Origin[1], v.Origin[2], v.Dir[0], v.Dir[1], v.Dir[2], v.Speed)
			var problems []string
			for i, want := range v.Steps {
				if b.Done {
					problems = append(problems, fmt.Sprintf("step %d: bullet was already done", i))
					break
				}
				targets := v.Targets[min(i, len(v.Targets)-1)]
				hit := game.StepBullet(&b, v.Dt, w, targets, v.Range)
				got := map[string]any{"x": b.X, "y": b.Y, "z": b.Z, "vx": b.VX, "vy": b.VY, "vz": b.VZ, "travelled": b.Travelled, "done": b.Done}
				wantFlat := map[string]any{"x": want.X, "y": want.Y, "z": want.Z, "vx": want.VX, "vy": want.VY, "vz": want.VZ, "travelled": want.Travelled, "done": want.Done}
				problems = append(problems, diff(t, fmt.Sprintf("step %d", i), wantFlat, got)...)
				problems = append(problems, diff(t, fmt.Sprintf("step %d hit", i), want.Hit, hit)...)
			}
			if len(problems) == 0 && !b.Done {
				problems = append(problems, "the recorded bullet ended but this one is still flying")
			}
			report(t, v.Name, problems)
		})
	}
}
