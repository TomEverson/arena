package netsim

import "testing"

func TestParseLoss(t *testing.T) {
	cases := map[string]float64{"3%": 0.03, "0.5": 0.5, "": 0, "100%": 1}
	for in, want := range cases {
		got, err := ParseLoss(in)
		if err != nil || got != want {
			t.Errorf("ParseLoss(%q) = %v, %v; want %v", in, got, err, want)
		}
	}
	for _, bad := range []string{"abc", "-1%", "150%"} {
		if _, err := ParseLoss(bad); err == nil {
			t.Errorf("ParseLoss(%q) expected error", bad)
		}
	}
}

func TestLossDropsEverything(t *testing.T) {
	l := Link{Loss: 1}
	l.Deliver(func() { t.Fatal("packet should have been dropped") })
}

func TestPerfectLinkIsSynchronous(t *testing.T) {
	ran := false
	Link{}.Deliver(func() { ran = true })
	if !ran {
		t.Fatal("perfect link should run fn synchronously")
	}
}
