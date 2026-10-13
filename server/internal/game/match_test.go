package game

import (
	"context"
	"testing"

	"arena/server/internal/protocol"
)

// A short match cycle so the tests are quick: 1 s countdown, 3 s match, 2 s results.
func testCycle() MatchConfig {
	return MatchConfig{Enabled: true, MinPlayers: 2, Capacity: 8, Countdown: 1, Length: 3, Results: 2}
}

func ticks(seconds float64) int { return int(seconds*TickRate + 0.5) }

type room struct {
	t       *testing.T
	w       *World
	players map[uint32]*Player
	seq     map[uint32]uint32
}

func newRoom(t *testing.T, cfg MatchConfig) *room {
	t.Helper()
	lv := FlatLevel()
	lv.Spawns = []Vec3{{X: 0, Z: -10}, {X: 0, Z: 10}, {X: 20, Z: 0}}
	w := NewWorld(lv)
	w.SetMatchConfig(cfg)
	return &room{t: t, w: w, players: map[uint32]*Player{}, seq: map[uint32]uint32{}}
}

func (r *room) join(id uint32) *Player {
	p := NewPlayer(id)
	r.players[id] = p
	r.w.Join(context.Background(), p)
	return p
}

func (r *room) leave(id uint32) {
	r.w.Leave(context.Background(), id)
	delete(r.players, id)
}

func (r *room) step(n int) {
	for i := 0; i < n; i++ {
		r.w.Step()
		for _, p := range r.players {
			for len(p.Out) > 0 {
				p.Free <- <-p.Out
			}
		}
	}
}

// act steps one tick with the given input from player id.
func (r *room) act(id uint32, in Input) {
	r.seq[id]++
	in.Seq = r.seq[id]
	r.w.SubmitInput(id, in)
	r.step(1)
}

func (r *room) phase() uint8 { return r.w.match.phase }

// kill makes killer kill victim now (through the same path real shots use).
func (r *room) kill(killer, victim uint32) {
	r.w.damage(r.players[killer], r.players[victim], 1e6, false, 0)
}

// startLive joins two players and runs the countdown into a live match.
func (r *room) startLive() (a, b *Player) {
	a, b = r.join(1), r.join(2)
	r.step(2)
	if r.phase() != protocol.MatchPhaseCountdown {
		r.t.Fatalf("expected countdown, phase = %d", r.phase())
	}
	r.step(ticks(1) + 2)
	if r.phase() != protocol.MatchPhaseLive {
		r.t.Fatalf("expected live, phase = %d", r.phase())
	}
	return a, b
}

func TestWaitsForPlayersThenCountsDownAndGoesLive(t *testing.T) {
	r := newRoom(t, testCycle())
	r.join(1)
	r.step(30)
	if r.phase() != protocol.MatchPhaseWaiting {
		t.Fatalf("alone in the room: phase = %d, want waiting", r.phase())
	}
	r.join(2)
	r.step(2)
	if r.phase() != protocol.MatchPhaseCountdown {
		t.Fatalf("two players: phase = %d, want countdown", r.phase())
	}
	if left := r.w.match.left; left > 1 || left < 0.9 {
		t.Fatalf("countdown left = %v", left)
	}
	r.step(ticks(1))
	if r.phase() != protocol.MatchPhaseLive {
		t.Fatalf("phase after the countdown = %d, want live", r.phase())
	}
	if left := r.w.match.left; left > 3 || left < 2.9 {
		t.Fatalf("match time left = %v, want about 3", left)
	}
	for id, p := range r.players {
		if p.Health.ProtectedFor <= 0 {
			t.Fatalf("player %d should open the match protected", id)
		}
	}
}

func TestCountdownAbortsWhenAPlayerLeaves(t *testing.T) {
	r := newRoom(t, testCycle())
	r.join(1)
	r.join(2)
	r.step(10)
	r.leave(2)
	r.step(2)
	if r.phase() != protocol.MatchPhaseWaiting {
		t.Fatalf("phase = %d, want back to waiting", r.phase())
	}
}

func TestPlayersAreFrozenDuringCountdownAndResults(t *testing.T) {
	r := newRoom(t, testCycle())
	a := r.join(1)
	r.join(2)
	r.step(2) // countdown starts
	before := a.State
	for i := 0; i < 20; i++ {
		r.act(1, Input{MoveZ: 1, Fire: true})
	}
	if a.State != before || a.Weapon.Ammo != WeaponMagSize {
		t.Fatalf("a player moved or shot during the countdown")
	}
	if a.ackSeq != 20 {
		t.Fatalf("inputs should still be acknowledged, ack = %d", a.ackSeq)
	}
}

func TestShotsOnlyHurtDuringALiveMatch(t *testing.T) {
	r := newRoom(t, testCycle())
	a, b := r.startLive()
	a.State = SpawnState(0, 0, 0)
	b.State = SpawnState(0, 0, -10)
	a.Health.ProtectedFor, b.Health.ProtectedFor = 0, 0
	for i := 0; i < 4; i++ {
		r.w.Step() // so the position history has them where they now stand
	}
	shoot := func() { // the shot itself, as the world resolves it: seen three ticks ago, so the bullet lands at once
		in := Input{Pitch: -0.05, ADS: true, ViewTick: float64(r.w.tick) - 3}
		r.w.fireBullet(a, &in, &ShotResult{}, &weaponDefs[0])
	}
	for _, phase := range []uint8{protocol.MatchPhaseWaiting, protocol.MatchPhaseCountdown, protocol.MatchPhaseEnded} {
		r.w.match.phase = phase
		shoot()
		if b.Health.Shield != WeaponMaxShield || b.Health.Health != WeaponMaxHealth {
			t.Fatalf("a shot hurt during phase %d: %+v", phase, b.Health)
		}
	}
	r.w.match.phase = protocol.MatchPhaseLive
	shoot()
	if b.Health.Shield == WeaponMaxShield {
		t.Fatalf("a shot during the live match should hurt")
	}
}

func TestMatchEndsWithTheLeaderWhenTimeIsUp(t *testing.T) {
	r := newRoom(t, testCycle())
	r.startLive()
	r.kill(1, 2)
	r.kill(1, 2)
	r.kill(2, 1)
	r.step(ticks(3) + 2)
	if r.phase() != protocol.MatchPhaseEnded {
		t.Fatalf("phase = %d, want ended", r.phase())
	}
	if r.w.match.winner != 1 {
		t.Fatalf("winner = %d, want 1 (2 kills to 1)", r.w.match.winner)
	}
	info := r.w.matchInfo()
	if info.Phase != protocol.MatchPhaseEnded || info.Winner != 1 || info.TimeLeft <= 0 || info.TimeLeft > 2 {
		t.Fatalf("match info = %+v", info)
	}
}

func TestTieGoesToSuddenDeathAndTheNextKillWins(t *testing.T) {
	r := newRoom(t, testCycle())
	r.startLive()
	r.kill(1, 2)
	r.kill(2, 1)
	r.step(ticks(3) + 2)
	if r.phase() != protocol.MatchPhaseLive || !r.w.match.suddenDeath {
		t.Fatalf("a tie at the buzzer should go to sudden death: phase %d sudden %v", r.phase(), r.w.match.suddenDeath)
	}
	if info := r.w.matchInfo(); !info.SuddenDeath || info.TimeLeft != 0 {
		t.Fatalf("match info = %+v", info)
	}
	r.step(120) // it can last as long as it likes
	if r.phase() != protocol.MatchPhaseLive {
		t.Fatalf("sudden death ended without a kill")
	}
	r.kill(2, 1)
	if r.phase() != protocol.MatchPhaseEnded || r.w.match.winner != 2 {
		t.Fatalf("the sudden death kill should end the match for player 2: phase %d winner %d", r.phase(), r.w.match.winner)
	}
}

func TestSuddenDeathWithThreeOnlyEndsWhenALeaderEmerges(t *testing.T) {
	r := newRoom(t, testCycle())
	r.startLive()
	r.join(3)
	r.step(2)
	r.kill(1, 2)
	r.kill(2, 3)
	r.step(ticks(3) + 2)
	if !r.w.match.suddenDeath {
		t.Fatalf("1-1-0 at the buzzer is a tie for the lead, expected sudden death")
	}
	r.kill(3, 2) // 1-1-1: still no single leader
	if r.phase() != protocol.MatchPhaseLive {
		t.Fatalf("the match ended with three tied")
	}
	r.kill(1, 3) // 2-1-1
	if r.phase() != protocol.MatchPhaseEnded || r.w.match.winner != 1 {
		t.Fatalf("phase %d winner %d, want ended with player 1", r.phase(), r.w.match.winner)
	}
}

func TestNobodyScoringIsATieToo(t *testing.T) {
	r := newRoom(t, testCycle())
	r.startLive()
	r.step(ticks(3) + 2)
	if !r.w.match.suddenDeath {
		t.Fatalf("0-0 should go to sudden death")
	}
}

func TestResultsThenAFreshMatch(t *testing.T) {
	r := newRoom(t, testCycle())
	a, b := r.startLive()
	r.kill(1, 2)
	r.step(ticks(3) + 2)
	r.step(ticks(2) + 2) // results run out
	if r.phase() != protocol.MatchPhaseCountdown {
		t.Fatalf("phase = %d, want a new countdown", r.phase())
	}
	if a.Kills != 0 || b.Deaths != 0 || !a.Health.Alive || !b.Health.Alive {
		t.Fatalf("a new match should reset scores and lives: %d kills, %d deaths, alive %v %v", a.Kills, b.Deaths, a.Health.Alive, b.Health.Alive)
	}
	if r.w.match.winner != 0 || r.w.match.suddenDeath {
		t.Fatalf("stale result carried over: %+v", r.w.match)
	}
}

func TestRematchVotesSkipTheResults(t *testing.T) {
	r := newRoom(t, testCycle())
	r.startLive()
	r.kill(1, 2)
	r.step(ticks(3) + 2)
	if r.phase() != protocol.MatchPhaseEnded {
		t.Fatal("expected results")
	}
	r.w.Rematch(context.Background(), 1)
	r.step(2)
	if r.phase() != protocol.MatchPhaseEnded || r.w.matchInfo().RematchVotes != 1 {
		t.Fatalf("one vote should not skip the results: %+v", r.w.matchInfo())
	}
	r.w.Rematch(context.Background(), 2)
	r.step(2)
	if r.phase() != protocol.MatchPhaseCountdown {
		t.Fatalf("with everyone voting the next match should start, phase = %d", r.phase())
	}
	// Votes outside the results screen mean nothing.
	r.w.Rematch(context.Background(), 1)
	r.step(2)
	if r.w.matchInfo().RematchVotes != 0 {
		t.Fatalf("a vote leaked into the next match")
	}
}

func TestEveryoneElseLeavingEndsTheMatch(t *testing.T) {
	r := newRoom(t, testCycle())
	r.startLive()
	r.kill(1, 2)
	r.leave(2)
	r.step(2)
	if r.phase() != protocol.MatchPhaseEnded || r.w.match.winner != 1 {
		t.Fatalf("phase %d winner %d, want the match ended with the player who stayed", r.phase(), r.w.match.winner)
	}
	r.step(ticks(2) + 2)
	if r.phase() != protocol.MatchPhaseWaiting {
		t.Fatalf("with one player left the room should go back to waiting, phase = %d", r.phase())
	}
}

func TestJoiningMidMatch(t *testing.T) {
	r := newRoom(t, testCycle())
	r.startLive()
	r.kill(1, 2)
	c := r.join(3)
	r.step(2)
	if r.phase() != protocol.MatchPhaseLive {
		t.Fatalf("a late joiner must not restart the match")
	}
	if c.Kills != 0 || !c.Health.Alive || c.Health.ProtectedFor <= 0 {
		t.Fatalf("late joiner state: kills %d alive %v protected %v", c.Kills, c.Health.Alive, c.Health.ProtectedFor)
	}
	scores := r.w.scoresInto(nil)
	if len(scores) != 3 {
		t.Fatalf("scoreboard has %d rows, want 3", len(scores))
	}
	if r.w.PlayerCount() != 3 {
		t.Fatalf("player count = %d", r.w.PlayerCount())
	}
	r.leave(3)
	r.step(2)
	if r.w.PlayerCount() != 2 || len(r.w.scoresInto(nil)) != 2 {
		t.Fatalf("leaving should remove the player from the count and the scoreboard")
	}
}

func TestSnapshotsCarryMatchInfoAndScores(t *testing.T) {
	r := newRoom(t, testCycle())
	a, _ := r.startLive()
	r.kill(1, 2)
	var got *protocol.Snapshot
	for i := 0; i < 4 && got == nil; i++ {
		r.w.Step()
		select {
		case got = <-a.Out:
		default:
		}
	}
	if got == nil {
		t.Fatal("no snapshot")
	}
	if got.Match.Phase != protocol.MatchPhaseLive || got.Match.Players != 2 || got.Match.MinPlayers != 2 {
		t.Fatalf("match info = %+v", got.Match)
	}
	found := map[uint32]protocol.Score{}
	for _, s := range got.Scores {
		found[s.ID] = s
	}
	if found[1].Kills != 1 || found[2].Deaths != 1 || len(found) != 2 {
		t.Fatalf("scores = %+v", got.Scores)
	}
}

func TestAlwaysLiveWorldHasNoMatchCycle(t *testing.T) {
	w := NewWorld(nil)
	for id := uint32(1); id <= 3; id++ {
		w.Join(context.Background(), NewPlayer(id))
	}
	for i := 0; i < 600; i++ {
		w.Step()
	}
	if w.match.phase != protocol.MatchPhaseLive {
		t.Fatalf("a practice world should stay live, phase = %d", w.match.phase)
	}
}

// HARD RULE: Step must not allocate, including through whole match cycles.
func TestMatchCycleDoesNotAllocate(t *testing.T) {
	cfg := testCycle()
	cfg.Length, cfg.Results = 2, 1
	w := NewWorld(FlatLevel())
	w.SetMatchConfig(cfg)
	players := []*Player{NewPlayer(1), NewPlayer(2), NewPlayer(3)}
	for _, p := range players {
		w.Join(context.Background(), p)
	}
	w.Step()
	tick := uint32(0)
	run := func() {
		tick++
		for _, p := range players {
			w.SubmitInput(p.ID, Input{Seq: tick, MoveZ: 1, Fire: true, ADS: true, Yaw: float64(p.ID)})
		}
		w.Step()
		for _, p := range players {
			for len(p.Out) > 0 {
				p.Free <- <-p.Out
			}
		}
		if tick%90 == 45 {
			w.damage(players[0], players[1], 1e6, false, 0) // keep kills and the sudden-death path busy
		}
	}
	for i := 0; i < 60; i++ {
		run()
	}
	if allocs := testing.AllocsPerRun(1500, run); allocs != 0 {
		t.Fatalf("match cycle Step allocated %v times per tick, want 0", allocs)
	}
}
