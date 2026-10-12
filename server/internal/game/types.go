package game

import (
	"encoding/json"
	"fmt"

	"arena/server/internal/protocol"
)

// Aabb is an axis-aligned box. Climbable surfaces can be climbed by holding jump.
type Aabb struct {
	MinX      float64 `json:"minX"`
	MinY      float64 `json:"minY"`
	MinZ      float64 `json:"minZ"`
	MaxX      float64 `json:"maxX"`
	MaxY      float64 `json:"maxY"`
	MaxZ      float64 `json:"maxZ"`
	Climbable bool    `json:"climbable,omitempty"`
}

// Rise is the direction a ramp surface rises toward.
type Rise uint8

const (
	RisePlusX Rise = iota
	RiseMinusX
	RisePlusZ
	RiseMinusZ
)

func (r *Rise) UnmarshalJSON(b []byte) error {
	var s string
	if err := json.Unmarshal(b, &s); err != nil {
		return err
	}
	switch s {
	case "+x":
		*r = RisePlusX
	case "-x":
		*r = RiseMinusX
	case "+z":
		*r = RisePlusZ
	case "-z":
		*r = RiseMinusZ
	default:
		return fmt.Errorf("invalid ramp direction %q (want +x, -x, +z or -z)", s)
	}
	return nil
}

// Ramp is a solid wedge filling Box below a sloped surface.
type Ramp struct {
	Box   Aabb `json:"box"`
	Rises Rise `json:"rises"`
}

// CollisionWorld is the static geometry movement collides with.
type CollisionWorld struct {
	Boxes []Aabb `json:"boxes"`
	Ramps []Ramp `json:"ramps"`
}

// Vec3 is a position.
type Vec3 struct {
	X, Y, Z float64
}

// Input and PlayerState are defined once, in protocol/messages.json, and generated
// for both sides. They are aliased here so the movement code reads naturally.
type (
	Input       = protocol.Input
	PlayerState = protocol.PlayerState
)
