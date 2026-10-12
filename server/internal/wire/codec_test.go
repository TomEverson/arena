package wire

import (
	"strings"
	"testing"

	"arena/server/internal/game"
)

func TestDecodeFullInput(t *testing.T) {
	var in game.Input
	data := `{"seq":42,"moveX":-1,"moveZ":0.5,"yaw":1.25,"pitch":-0.3,"jump":true,"jumpHeld":true,"dash":true,"slide":true,"ads":true}`
	if err := (JSON{}).DecodeInput([]byte(data), &in); err != nil {
		t.Fatal(err)
	}
	want := game.Input{Seq: 42, MoveX: -1, MoveZ: 0.5, Yaw: 1.25, Pitch: -0.3, Jump: true, JumpHeld: true, Dash: true, Slide: true, ADS: true}
	if in != want {
		t.Fatalf("decoded %+v, want %+v", in, want)
	}
}

func TestEncodeSnapshotHasPositions(t *testing.T) {
	s := &game.Snapshot{Tick: 12, AckSeq: 7, Entities: []game.Entity{{ID: 1, TeamID: 1, X: 1.5, Y: 2, Z: -3}}}
	b, err := (JSON{}).EncodeSnapshot(nil, s)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`"type":"snapshot"`, `"tick":12`, `"ackSeq":7`, `"x":1.5`, `"y":2`, `"z":-3`} {
		if !strings.Contains(string(b), want) {
			t.Errorf("snapshot %s missing %s", b, want)
		}
	}
}
