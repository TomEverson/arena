package game_test

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"arena/server/internal/game"
	"arena/server/internal/level"
)

// These tests replay /testvectors/movement/*.json, recorded from the TypeScript
// implementation (`pnpm vectors`). The Go movement must reproduce every
// checkpoint within tolerance; booleans must match exactly.

const (
	vectorDir  = "../../../testvectors/movement"
	levelDir   = "../../../levels"
	tolerance  = 1e-6
	maxReports = 8
)

type vectorFile struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Dt          float64
	World       struct {
		Level string      `json:"level"`
		Boxes []game.Aabb `json:"boxes"`
		Ramps []game.Ramp `json:"ramps"`
	} `json:"world"`
	Initial game.PlayerState `json:"initial"`
	Steps   []struct {
		Ticks int        `json:"ticks"`
		Input game.Input `json:"input"`
	} `json:"steps"`
	Checkpoints []struct {
		Tick  int              `json:"tick"`
		State game.PlayerState `json:"state"`
	} `json:"checkpoints"`
}

func loadVectors(t *testing.T) []vectorFile {
	t.Helper()
	files, err := filepath.Glob(filepath.Join(vectorDir, "*.json"))
	if err != nil || len(files) == 0 {
		t.Fatalf("no vectors found in %s (run `pnpm vectors`): %v", vectorDir, err)
	}
	out := make([]vectorFile, 0, len(files))
	for _, f := range files {
		data, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		var v vectorFile
		if err := json.Unmarshal(data, &v); err != nil {
			t.Fatalf("%s: %v", f, err)
		}
		out = append(out, v)
	}
	return out
}

func (v *vectorFile) world(t *testing.T) *game.CollisionWorld {
	t.Helper()
	if v.World.Level != "" {
		lv, err := level.Load(filepath.Join(levelDir, v.World.Level+".json"))
		if err != nil {
			t.Fatalf("%s: %v", v.Name, err)
		}
		return &lv.Collision
	}
	return &game.CollisionWorld{Boxes: v.World.Boxes, Ramps: v.World.Ramps}
}

func asMap(t *testing.T, s game.PlayerState) map[string]any {
	t.Helper()
	b, err := json.Marshal(s)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func compare(t *testing.T, tick int, want, got game.PlayerState) []string {
	t.Helper()
	w, g := asMap(t, want), asMap(t, got)
	var out []string
	for field, wv := range w {
		gv := g[field]
		switch x := wv.(type) {
		case float64:
			y, _ := gv.(float64)
			if !(math.Abs(x-y) <= tolerance) {
				out = append(out, fmt.Sprintf("tick %d %s: want %v got %v", tick, field, x, y))
			}
		default:
			if wv != gv {
				out = append(out, fmt.Sprintf("tick %d %s: want %v got %v", tick, field, wv, gv))
			}
		}
	}
	return out
}

func report(t *testing.T, name string, problems []string) {
	t.Helper()
	if len(problems) == 0 {
		return
	}
	if len(problems) > maxReports {
		problems = append(problems[:maxReports], fmt.Sprintf("... and %d more", len(problems)-maxReports))
	}
	t.Errorf("%s drifted from the TypeScript reference:\n  %s", name, strings.Join(problems, "\n  "))
}

// The movement function on its own.
func TestMovementVectors(t *testing.T) {
	for _, v := range loadVectors(t) {
		t.Run(v.Name, func(t *testing.T) {
			w := v.world(t)
			s := v.Initial
			var problems []string
			tick, next := 0, 0
			for _, step := range v.Steps {
				in := step.Input
				for i := 0; i < step.Ticks; i++ {
					game.StepPlayer(&s, &in, w, v.Dt)
					tick++
					if next < len(v.Checkpoints) && v.Checkpoints[next].Tick == tick {
						problems = append(problems, compare(t, tick, v.Checkpoints[next].State, s)...)
						next++
					}
				}
			}
			if next != len(v.Checkpoints) {
				problems = append(problems, fmt.Sprintf("only reached %d of %d checkpoints", next, len(v.Checkpoints)))
			}
			report(t, v.Name, problems)
		})
	}
}

// The same vectors through the real world: join, queue one input per tick, Step.
// This is "a player driven by inputs moves the same on server and client".
func TestMovementVectorsThroughWorld(t *testing.T) {
	for _, v := range loadVectors(t) {
		t.Run(v.Name, func(t *testing.T) {
			lv := &game.Level{Collision: *v.world(t), Spawns: []game.Vec3{{}}}
			w := game.NewWorld(lv)
			p := game.NewPlayer(1)
			p.SetInitialState(v.Initial)
			w.Join(context.Background(), p)

			var problems []string
			tick, next := 0, 0
			for _, step := range v.Steps {
				for i := 0; i < step.Ticks; i++ {
					in := step.Input
					in.Seq = uint32(tick + 1)
					w.SubmitInput(1, in)
					w.Step()
					for len(p.Out) > 0 { // keep the snapshot pool flowing like a real connection
						p.Free <- <-p.Out
					}
					tick++
					if next < len(v.Checkpoints) && v.Checkpoints[next].Tick == tick {
						problems = append(problems, compare(t, tick, v.Checkpoints[next].State, p.State)...)
						next++
					}
				}
			}
			if next != len(v.Checkpoints) {
				problems = append(problems, fmt.Sprintf("only reached %d of %d checkpoints", next, len(v.Checkpoints)))
			}
			report(t, v.Name, problems)
		})
	}
}
