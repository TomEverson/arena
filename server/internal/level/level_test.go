package level

import (
	"strings"
	"testing"
)

func TestLoadGreybox(t *testing.T) {
	lv, err := Load("../../../levels/greybox.json")
	if err != nil {
		t.Fatal(err)
	}
	if len(lv.Collision.Boxes) < 10 || len(lv.Collision.Ramps) != 2 || len(lv.Spawns) != 4 {
		t.Fatalf("unexpected level: %d boxes, %d ramps, %d spawns",
			len(lv.Collision.Boxes), len(lv.Collision.Ramps), len(lv.Spawns))
	}
	floor := lv.Collision.Boxes[0]
	if floor.MaxY != 0 {
		t.Fatalf("floor top = %v, want 0", floor.MaxY)
	}
}

func TestGreyboxHasRechargePickupsWithStandingRoom(t *testing.T) {
	lv, err := Load("../../../levels/greybox.json")
	if err != nil {
		t.Fatal(err)
	}
	if len(lv.Pickups) != 2 {
		t.Fatalf("pickups = %d, want 2", len(lv.Pickups))
	}
	for i, at := range lv.Pickups {
		for _, b := range lv.Collision.Boxes {
			inX := at.X+0.3 > b.MinX && at.X-0.3 < b.MaxX
			inZ := at.Z+0.3 > b.MinZ && at.Z-0.3 < b.MaxZ
			inY := at.Y+1.8 > b.MinY && at.Y < b.MaxY-0.001
			if inX && inZ && inY {
				t.Fatalf("pickup %d (%v, %v, %v) is inside a box %+v", i, at.X, at.Y, at.Z, b)
			}
		}
	}
}

func TestLoadsPracticeTargets(t *testing.T) {
	lv, err := Load("../../../levels/greybox.json")
	if err != nil {
		t.Fatal(err)
	}
	if len(lv.Targets) != 6 {
		t.Fatalf("targets = %d, want 6", len(lv.Targets))
	}
	strafing, wallRunning := 0, 0
	for _, tg := range lv.Targets {
		if tg.Strafe {
			strafing++
			if tg.WallRun {
				wallRunning++
			}
			if tg.Range <= 0 {
				t.Fatalf("strafing target %s has no range", tg.ID)
			}
		}
	}
	if strafing != 3 || wallRunning != 1 {
		t.Fatalf("strafing targets = %d (want 3), wall-running = %d (want 1)", strafing, wallRunning)
	}
}

func TestTargetDefaultsAndValidation(t *testing.T) {
	lv, err := Parse([]byte(`{"targets":[{"id":"t","pos":[1,0,2]}]}`))
	if err != nil || len(lv.Targets) != 1 || lv.Targets[0].Strafe || !lv.Targets[0].AxisX {
		t.Fatalf("defaults: %+v, %v", lv, err)
	}
	for _, bad := range []string{
		`{"targets":[{"id":"t","pos":[0,0,0],"kind":"flying"}]}`,
		`{"targets":[{"id":"t","pos":[0,0,0],"axis":"y"}]}`,
		`{"targets":[{"id":"t","pos":[0,0,0],"range":-1}]}`,
	} {
		if _, err := Parse([]byte(bad)); err == nil {
			t.Errorf("Parse(%s) should fail", bad)
		}
	}
}

func TestRejectsBadLevels(t *testing.T) {
	cases := map[string]string{
		`{"boxes":[{"id":"a","pos":[0,0,0],"size":[0,1,1]}]}`:              "positive",
		`{"ramps":[{"id":"r","pos":[0,0,0],"size":[1,1,1],"rises":"up"}]}`: "rises",
		`{"ramps":[{"id":"r","pos":[0,0,0],"size":[1,1,1]}]}`:              "rises",
		`{"boxes": 5}`: "level",
		`{"spawnZones":[{"id":"s","pos":[0,0,0],"size":[1,-1,1]}]}`: "positive",
	}
	for in, want := range cases {
		_, err := Parse([]byte(in))
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("Parse(%s) error = %v, want it to mention %q", in, err, want)
		}
	}
}

func TestLoadFFA(t *testing.T) {
	lv, err := Load("../../../levels/ffa.json")
	if err != nil {
		t.Fatal(err)
	}
	if lv.Name != "ffa" {
		t.Fatalf("name = %q, want ffa", lv.Name)
	}
	if len(lv.Spawns) < 16 {
		t.Fatalf("spawns = %d, want at least 16 (spread over the whole map)", len(lv.Spawns))
	}
	// Every spawn point must be standing room: nothing solid in a player-sized box above it.
	for i, sp := range lv.Spawns {
		for _, b := range lv.Collision.Boxes {
			inX := sp.X+0.3 > b.MinX && sp.X-0.3 < b.MaxX
			inZ := sp.Z+0.3 > b.MinZ && sp.Z-0.3 < b.MaxZ
			inY := sp.Y+1.8 > b.MinY && sp.Y < b.MaxY-0.001
			if inX && inZ && inY {
				t.Fatalf("spawn %d (%v, %v, %v) is inside a box %+v", i, sp.X, sp.Y, sp.Z, b)
			}
		}
	}
	if len(lv.Targets) != 0 {
		t.Fatalf("an FFA map has no practice targets, got %d", len(lv.Targets))
	}
}
