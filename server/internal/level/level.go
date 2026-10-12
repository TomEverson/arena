// Package level loads the shared level JSON (/levels/*.json) into the form the
// simulation needs. It mirrors client/src/sim/level.ts: same format, same
// validation rules, same centre/size to box arithmetic.
package level

import (
	"encoding/json"
	"fmt"
	"math"
	"os"

	"arena/server/internal/game"
)

type rawBox struct {
	ID        string     `json:"id"`
	Pos       [3]float64 `json:"pos"`
	Size      [3]float64 `json:"size"`
	Climbable bool       `json:"climbable"`
	Rises     *string    `json:"rises"`
}

type rawTarget struct {
	ID    string     `json:"id"`
	Pos   [3]float64 `json:"pos"`
	Kind  string     `json:"kind"`
	Axis  string     `json:"axis"`
	Range float64    `json:"range"`
}

type rawLevel struct {
	Name       string      `json:"name"`
	Boxes      []rawBox    `json:"boxes"`
	Ramps      []rawBox    `json:"ramps"`
	SpawnZones []rawBox    `json:"spawnZones"`
	Targets    []rawTarget `json:"targets"`
}

func finite(v [3]float64) bool {
	for _, n := range v {
		if math.IsNaN(n) || math.IsInf(n, 0) {
			return false
		}
	}
	return true
}

func toAabb(b rawBox) game.Aabb {
	x, y, z := b.Pos[0], b.Pos[1], b.Pos[2]
	w, h, d := b.Size[0], b.Size[1], b.Size[2]
	return game.Aabb{
		MinX: x - w/2, MaxX: x + w/2,
		MinY: y - h/2, MaxY: y + h/2,
		MinZ: z - d/2, MaxZ: z + d/2,
		Climbable: b.Climbable,
	}
}

func validate(kind string, i int, b rawBox) error {
	if !finite(b.Pos) || !finite(b.Size) {
		return fmt.Errorf("level: %s[%d]: expected finite numbers", kind, i)
	}
	if b.Size[0] <= 0 || b.Size[1] <= 0 || b.Size[2] <= 0 {
		return fmt.Errorf("level: %s[%d].size: sizes must be positive", kind, i)
	}
	return nil
}

// Parse reads level JSON. Fields it does not use (controlPoints) are ignored.
func Parse(data []byte) (*game.Level, error) {
	var raw rawLevel
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, fmt.Errorf("level: %w", err)
	}
	lv := &game.Level{Name: raw.Name}
	for i, b := range raw.Boxes {
		if err := validate("boxes", i, b); err != nil {
			return nil, err
		}
		lv.Collision.Boxes = append(lv.Collision.Boxes, toAabb(b))
	}
	for i, r := range raw.Ramps {
		if err := validate("ramps", i, r); err != nil {
			return nil, err
		}
		var rise game.Rise
		if r.Rises == nil {
			return nil, fmt.Errorf("level: ramps[%d].rises: missing", i)
		}
		if err := rise.UnmarshalJSON([]byte(fmt.Sprintf("%q", *r.Rises))); err != nil {
			return nil, fmt.Errorf("level: ramps[%d].rises: %w", i, err)
		}
		lv.Collision.Ramps = append(lv.Collision.Ramps, game.Ramp{Box: toAabb(r), Rises: rise})
	}
	for i, z := range raw.SpawnZones {
		if err := validate("spawnZones", i, z); err != nil {
			return nil, err
		}
		lv.Spawns = append(lv.Spawns, game.Vec3{X: z.Pos[0], Y: z.Pos[1], Z: z.Pos[2]})
	}
	for i, t := range raw.Targets {
		spec, err := parseTarget(i, t)
		if err != nil {
			return nil, err
		}
		lv.Targets = append(lv.Targets, spec)
	}
	return lv, nil
}

// parseTarget validates a practice target the same way client/src/sim/level.ts does.
func parseTarget(i int, t rawTarget) (game.TargetSpec, error) {
	if !finite(t.Pos) {
		return game.TargetSpec{}, fmt.Errorf("level: targets[%d].pos: expected finite numbers", i)
	}
	kind, axis := t.Kind, t.Axis
	if kind == "" {
		kind = "static"
	}
	if axis == "" {
		axis = "x"
	}
	if kind != "static" && kind != "strafe" && kind != "wallrun" {
		return game.TargetSpec{}, fmt.Errorf("level: targets[%d].kind: expected static, strafe or wallrun", i)
	}
	if axis != "x" && axis != "z" {
		return game.TargetSpec{}, fmt.Errorf("level: targets[%d].axis: expected x or z", i)
	}
	if math.IsNaN(t.Range) || math.IsInf(t.Range, 0) || t.Range < 0 {
		return game.TargetSpec{}, fmt.Errorf("level: targets[%d].range: expected a number >= 0", i)
	}
	return game.TargetSpec{
		ID:      t.ID,
		Pos:     game.Vec3{X: t.Pos[0], Y: t.Pos[1], Z: t.Pos[2]},
		Strafe:  kind == "strafe" || kind == "wallrun",
		WallRun: kind == "wallrun",
		AxisX:   axis == "x",
		Range:   t.Range,
	}, nil
}

// Load reads and parses a level file.
func Load(path string) (*game.Level, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return Parse(data)
}
