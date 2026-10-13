package game

// The match cycle for one room: waiting for players, a countdown, the live match,
// and the results screen, then around again. Runs on the world goroutine inside
// Step, so it must never allocate.

import (
	"math"

	"arena/server/internal/protocol"
)

// MatchConfig sets the match cycle. The zero value is not useful; see DefaultMatchConfig.
type MatchConfig struct {
	// Enabled turns the cycle on. When false the world is simply always live (practice and tests).
	Enabled bool
	// MinPlayers are needed to start and keep a match going.
	MinPlayers int
	// Capacity is the most players a room takes (enforced by the room, reported to clients).
	Capacity int
	// Seconds for the countdown, the match itself and the results screen.
	Countdown, Length, Results float64
}

// DefaultMatchConfig is the real game: the numbers in shared/params.json.
func DefaultMatchConfig() MatchConfig {
	return MatchConfig{
		Enabled:    true,
		MinPlayers: MatchMinPlayers,
		Capacity:   MatchMaxPlayers,
		Countdown:  MatchCountdownSeconds,
		Length:     MatchLengthSeconds,
		Results:    MatchResultsSeconds,
	}
}

type matchState struct {
	phase       uint8
	left        float64 // seconds left in the phase
	suddenDeath bool
	winner      uint32
}

// SetMatchConfig switches the world to a match cycle (or back to always-live). Call before Run.
func (w *World) SetMatchConfig(cfg MatchConfig) {
	w.cfg = cfg
	w.match = matchState{phase: protocol.MatchPhaseLive}
	if cfg.Enabled {
		w.match.phase = protocol.MatchPhaseWaiting
	}
}

// canAct reports whether players may move and shoot: not during the countdown or the results.
func (w *World) canAct() bool {
	return w.match.phase == protocol.MatchPhaseLive || w.match.phase == protocol.MatchPhaseWaiting
}

// canDamage reports whether shots hurt. Before the match is a warm-up with no damage.
func (w *World) canDamage() bool { return w.match.phase == protocol.MatchPhaseLive }

// leader returns the id of the player with strictly the most kills, or 0 if the lead is tied.
func (w *World) leader() uint32 {
	var best uint16
	var id uint32
	tied := false
	for i, p := range w.players {
		switch {
		case i == 0 || p.Kills > best:
			best, id, tied = p.Kills, p.ID, false
		case p.Kills == best:
			tied = true
		}
	}
	if tied || len(w.players) == 0 {
		return 0
	}
	return id
}

func (w *World) rematchVotes() int {
	n := 0
	for _, p := range w.players {
		if p.rematch {
			n++
		}
	}
	return n
}

// startMatch resets everyone for a fresh match: zero scores, full life at their own spawn, frozen for the countdown.
func (w *World) startMatch() {
	m := &w.match
	m.phase = protocol.MatchPhaseCountdown
	m.left = w.cfg.Countdown
	m.suddenDeath = false
	m.winner = 0
	spawns := w.level.Spawns
	w.clearSkills()
	for i, p := range w.players {
		p.Kills, p.Deaths, p.rematch = 0, 0, false
		p.Health.Ult = 0
		sp := spawns[i%len(spawns)]
		sp.X += float64(i / len(spawns)) // a few players may share a spawn: spread them a little
		w.resetLifeAt(p, sp)
	}
}

// goLive ends the countdown. Everyone gets fresh spawn protection so nobody is shot as the match opens.
func (w *World) goLive() {
	m := &w.match
	m.phase = protocol.MatchPhaseLive
	m.left = w.cfg.Length
	for _, p := range w.players {
		p.Health.ProtectedFor = CombatSpawnProtection
	}
}

func (w *World) endMatch() {
	m := &w.match
	m.phase = protocol.MatchPhaseEnded
	m.left = w.cfg.Results
	m.winner = w.leader()
	m.suddenDeath = false
	for _, p := range w.players {
		p.rematch = false
	}
}

// updateMatch advances the match cycle by one tick.
func (w *World) updateMatch() {
	if !w.cfg.Enabled {
		return
	}
	m := &w.match
	n := len(w.players)
	switch m.phase {
	case protocol.MatchPhaseWaiting:
		if n >= w.cfg.MinPlayers {
			w.startMatch()
		}
	case protocol.MatchPhaseCountdown:
		if n < w.cfg.MinPlayers {
			m.phase, m.left = protocol.MatchPhaseWaiting, 0
			return
		}
		m.left -= TickDT
		if m.left <= 0 {
			w.goLive()
		}
	case protocol.MatchPhaseLive:
		if n < w.cfg.MinPlayers { // everyone else left: the match is over
			w.endMatch()
			return
		}
		m.left = math.Max(0, m.left-TickDT)
		if m.left == 0 && !m.suddenDeath {
			if w.leader() != 0 {
				w.endMatch()
			} else {
				m.suddenDeath = true // tied at the buzzer: the next kill that makes a single leader wins
			}
		}
	case protocol.MatchPhaseEnded:
		m.left -= TickDT
		if m.left <= 0 || (n > 0 && w.rematchVotes() == n) {
			if n >= w.cfg.MinPlayers {
				w.startMatch()
			} else {
				m.phase, m.left, m.winner = protocol.MatchPhaseWaiting, 0, 0
			}
		}
	}
}

// onKill is called after every kill. In sudden death the first kill that leaves a single leader ends the match.
func (w *World) onKill() {
	if w.match.suddenDeath && w.leader() != 0 {
		w.endMatch()
	}
}

// matchInfo fills the snapshot's match section.
func (w *World) matchInfo() protocol.MatchInfo {
	m := &w.match
	left := m.left
	if m.phase == protocol.MatchPhaseWaiting || left < 0 {
		left = 0
	}
	votes := 0
	if m.phase == protocol.MatchPhaseEnded {
		votes = w.rematchVotes()
	}
	return protocol.MatchInfo{
		Phase:        m.phase,
		TimeLeft:     left,
		SuddenDeath:  m.suddenDeath,
		Winner:       m.winner,
		Players:      uint8(len(w.players)),
		MinPlayers:   uint8(w.cfg.MinPlayers),
		RematchVotes: uint8(votes),
	}
}

// scoresInto appends everyone's tally to dst.
func (w *World) scoresInto(dst []protocol.Score) []protocol.Score {
	for _, p := range w.players {
		dst = append(dst, protocol.Score{ID: p.ID, Kills: p.Kills, Deaths: p.Deaths})
	}
	return dst
}
