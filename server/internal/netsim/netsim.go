// Package netsim simulates a bad network for development: fixed added latency
// and random packet loss, applied to both directions.
package netsim

import (
	"fmt"
	"math/rand/v2"
	"strconv"
	"strings"
	"time"
)

// Link delays and/or drops deliveries. The zero value is a perfect link.
type Link struct {
	Latency time.Duration
	Loss    float64 // 0..1
}

// Active reports whether the link alters traffic at all.
func (l Link) Active() bool { return l.Latency > 0 || l.Loss > 0 }

// Deliver runs fn after the link's latency, or never if the packet is "lost".
// With a perfect link fn runs synchronously on the caller's goroutine;
// otherwise it runs on a timer goroutine, so fn must be safe to call
// concurrently with everything else.
func (l Link) Deliver(fn func()) {
	if l.Loss > 0 && rand.Float64() < l.Loss {
		return
	}
	if l.Latency <= 0 {
		fn()
		return
	}
	time.AfterFunc(l.Latency, fn)
}

// ParseLoss parses "3%", "0.03" or "0" into a 0..1 fraction.
func ParseLoss(s string) (float64, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, nil
	}
	pct := strings.HasSuffix(s, "%")
	v, err := strconv.ParseFloat(strings.TrimSuffix(s, "%"), 64)
	if err != nil {
		return 0, fmt.Errorf("invalid loss %q: %w", s, err)
	}
	if pct {
		v /= 100
	}
	if v < 0 || v > 1 {
		return 0, fmt.Errorf("loss %q out of range (0%%..100%%)", s)
	}
	return v, nil
}
