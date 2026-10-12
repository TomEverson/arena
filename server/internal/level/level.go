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

type rawLevel struct {
	Name       string   `json:"name"`
	Boxes      []rawBox `json:"boxes"`
	Ramps      []rawBox `json:"ramps"`
	SpawnZones []rawBox `json:"spawnZones"`
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

// Parse reads level JSON. Fields it does not use (targets, controlPoints) are ignored.
func Parse(data []byte) (*game.Level, error) {
	var raw rawLevel
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, fmt.Errorf("level: %w", err)
	}
	lv := &game.Level{}
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
	return lv, nil
}

// Load reads and parses a level file.
func Load(path string) (*game.Level, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return Parse(data)
}
