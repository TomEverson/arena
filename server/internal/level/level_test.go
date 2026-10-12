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
	climbable := 0
	for _, b := range lv.Collision.Boxes {
		if b.Climbable {
			climbable++
		}
	}
	if climbable != 3 {
		t.Fatalf("climbable boxes = %d, want 3", climbable)
	}
}

func TestLoadsPracticeTargets(t *testing.T) {
	lv, err := Load("../../../levels/greybox.json")
	if err != nil {
		t.Fatal(err)
	}
	if len(lv.Targets) != 5 {
		t.Fatalf("targets = %d, want 5", len(lv.Targets))
	}
	strafing := 0
	for _, tg := range lv.Targets {
		if tg.Strafe {
			strafing++
			if tg.Range <= 0 {
				t.Fatalf("strafing target %s has no range", tg.ID)
			}
		}
	}
	if strafing != 2 {
		t.Fatalf("strafing targets = %d, want 2", strafing)
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
