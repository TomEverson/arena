package game

import (
	"encoding/json"
	"fmt"
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

// Input is one client command for one tick. Jump and Dash are "pressed this
// tick" edges; the rest are held states. Field names match the vectors and the wire format.
type Input struct {
	Seq      uint32  `json:"seq"`
	MoveX    float64 `json:"moveX"`
	MoveZ    float64 `json:"moveZ"`
	Yaw      float64 `json:"yaw"`
	Pitch    float64 `json:"pitch"`
	Jump     bool    `json:"jump"`
	JumpHeld bool    `json:"jumpHeld"`
	Dash     bool    `json:"dash"`
	Slide    bool    `json:"slide"`
	ADS      bool    `json:"ads"`
}

// PlayerState is the complete movement state. (X, Y, Z) is the centre of the
// player's feet. Field names and meanings match client/src/sim/types.ts.
type PlayerState struct {
	X  float64 `json:"x"`
	Y  float64 `json:"y"`
	Z  float64 `json:"z"`
	VX float64 `json:"vx"`
	VY float64 `json:"vy"`
	VZ float64 `json:"vz"`

	OnGround  bool `json:"onGround"`
	Climbing  bool `json:"climbing"`
	Crouching bool `json:"crouching"`
	Sliding   bool `json:"sliding"`

	SlideTime     float64 `json:"slideTime"`
	SlideCooldown float64 `json:"slideCooldown"`

	DashCharges float64 `json:"dashCharges"`
	DashTime    float64 `json:"dashTime"`
	DashDirX    float64 `json:"dashDirX"`
	DashDirZ    float64 `json:"dashDirZ"`

	AirJumps   int     `json:"airJumps"`
	Coyote     float64 `json:"coyote"`
	JumpBuffer float64 `json:"jumpBuffer"`

	Mantling    bool    `json:"mantling"`
	MantleT     float64 `json:"mantleT"`
	MantleFromX float64 `json:"mantleFromX"`
	MantleFromY float64 `json:"mantleFromY"`
	MantleFromZ float64 `json:"mantleFromZ"`
	MantleToX   float64 `json:"mantleToX"`
	MantleToY   float64 `json:"mantleToY"`
	MantleToZ   float64 `json:"mantleToZ"`
}
