package game_test

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"testing"

	"arena/server/internal/game"
	"arena/server/internal/level"
)

// Replays /testvectors/weapon and /testvectors/hitscan, recorded from the TypeScript
// implementation (`pnpm vectors`). Numbers match within tolerance, flags and kinds exactly.

const (
	weaponVectorDir  = "../../../testvectors/weapon"
	hitscanVectorDir = "../../../testvectors/hitscan"
)

type weaponVector struct {
	Name    string             `json:"name"`
	Dt      float64            `json:"dt"`
	Initial game.WeaponState   `json:"initial"`
	Steps   []weaponStep       `json:"steps"`
	Events  []weaponEvent      `json:"events"`
	Checks  []weaponCheckpoint `json:"checkpoints"`
}

type weaponStep struct {
	Ticks int                `json:"ticks"`
	Input game.Input         `json:"input"`
	Ctx   game.WeaponContext `json:"ctx"`
}

type weaponEvent struct {
	Tick int `json:"tick"`
	game.ShotResult
}

type weaponCheckpoint struct {
	Tick   int              `json:"tick"`
	Weapon game.WeaponState `json:"weapon"`
}

type hitscanVector struct {
	Name  string `json:"name"`
	World struct {
		Level string      `json:"level"`
		Boxes []game.Aabb `json:"boxes"`
		Ramps []game.Ramp `json:"ramps"`
	} `json:"world"`
	Targets []game.Hitbox `json:"targets"`
	Cases   []struct {
		Origin  [3]float64  `json:"origin"`
		Dir     [3]float64  `json:"dir"`
		MaxDist float64     `json:"maxDist"`
		Expect  game.RayHit `json:"expect"`
	} `json:"cases"`
}

func readAll[T any](t *testing.T, dir string) []T {
	t.Helper()
	files, err := filepath.Glob(filepath.Join(dir, "*.json"))
	if err != nil || len(files) == 0 {
		t.Fatalf("no vectors in %s (run `pnpm vectors`): %v", dir, err)
	}
	out := make([]T, 0, len(files))
	for _, f := range files {
		data, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		var v T
		if err := json.Unmarshal(data, &v); err != nil {
			t.Fatalf("%s: %v", f, err)
		}
		out = append(out, v)
	}
	return out
}

// diff compares two values field by field through their JSON form.
func diff(t *testing.T, where string, want, got any) []string {
	t.Helper()
	toMap := func(v any) map[string]any {
		b, err := json.Marshal(v)
		if err != nil {
			t.Fatal(err)
		}
		var m map[string]any
		if err := json.Unmarshal(b, &m); err != nil {
			t.Fatal(err)
		}
		return m
	}
	w, g := toMap(want), toMap(got)
	var out []string
	for k, wv := range w {
		gv := g[k]
		if x, ok := wv.(float64); ok {
			y, _ := gv.(float64)
			if !(math.Abs(x-y) <= tolerance) {
				out = append(out, fmt.Sprintf("%s %s: want %v got %v", where, k, x, y))
			}
		} else if wv != gv {
			out = append(out, fmt.Sprintf("%s %s: want %v got %v", where, k, wv, gv))
		}
	}
	return out
}

func TestWeaponVectors(t *testing.T) {
	for _, v := range readAll[weaponVector](t, weaponVectorDir) {
		t.Run(v.Name, func(t *testing.T) {
			w := v.Initial
			var problems []string
			var events []weaponEvent
			var checks []weaponCheckpoint
			total := 0
			for _, s := range v.Steps {
				total += s.Ticks
			}
			tick := 0
			for _, s := range v.Steps {
				in, ctx := s.Input, s.Ctx
				for i := 0; i < s.Ticks; i++ {
					shot := game.StepWeapon(&w, &in, &ctx, v.Dt)
					tick++
					if shot.Fired || shot.ReloadStarted || shot.ReloadFinished || shot.DryFire || shot.MeleeStarted || shot.MeleeStrike || shot.Switched {
						events = append(events, weaponEvent{Tick: tick, ShotResult: shot})
					}
					if tick%10 == 0 || tick == total {
						checks = append(checks, weaponCheckpoint{Tick: tick, Weapon: w})
					}
				}
			}
			if len(events) != len(v.Events) {
				t.Fatalf("%s: %d events, want %d", v.Name, len(events), len(v.Events))
			}
			for i := range events {
				problems = append(problems, diff(t, fmt.Sprintf("event %d (tick %d)", i, v.Events[i].Tick), v.Events[i], events[i])...)
			}
			if len(checks) != len(v.Checks) {
				t.Fatalf("%s: %d checkpoints, want %d", v.Name, len(checks), len(v.Checks))
			}
			for i := range checks {
				problems = append(problems, diff(t, fmt.Sprintf("tick %d weapon", v.Checks[i].Tick), v.Checks[i].Weapon, checks[i].Weapon)...)
			}
			report(t, v.Name, problems)
		})
	}
}

func TestHitscanVectors(t *testing.T) {
	for _, v := range readAll[hitscanVector](t, hitscanVectorDir) {
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
				got := game.CastRay(w, v.Targets, c.Origin[0], c.Origin[1], c.Origin[2], c.Dir[0], c.Dir[1], c.Dir[2], c.MaxDist)
				problems = append(problems, diff(t, fmt.Sprintf("ray %d", i), c.Expect, got)...)
			}
			report(t, v.Name, problems)
		})
	}
}
