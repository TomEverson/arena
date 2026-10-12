// Package game holds the authoritative world simulation.
//
// Concurrency model: exactly one goroutine (the one calling Run/Step) owns all
// mutable world state. Network goroutines communicate with it only through the
// inbox channel and per-player snapshot channels. There are no locks in here.
//
// HARD RULE: Step must not allocate. TestStepDoesNotAllocate enforces it.
package game

import (
	"context"
	"sync/atomic"
	"time"
)

const (
	TickRate     = 60
	SnapshotRate = 30
	// snapshotEvery is how many ticks pass between snapshots.
	snapshotEvery = TickRate / SnapshotRate
	// MaxPlayers bounds every preallocated buffer so Step never grows a slice.
	MaxPlayers = 64
	// snapshotBuffers is the number of in-flight snapshots per player.
	snapshotBuffers = 4
	inboxSize       = 1024
)

// Entity is the replicated state of one thing in the world.
// Every entity carries a TeamID from day one (teams of 1 for now).
type Entity struct {
	ID     uint32  `json:"id"`
	TeamID uint16  `json:"teamId"`
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Z      float64 `json:"z"`
}

// Input is one client command for one client tick.
type Input struct {
	Seq   uint32  `json:"seq"`
	MoveX float64 `json:"moveX"`
	MoveZ float64 `json:"moveZ"`
	Yaw   float64 `json:"yaw"`
	Pitch float64 `json:"pitch"`
}

// Snapshot is a reusable buffer holding what one player sees at one tick.
type Snapshot struct {
	Tick     uint64
	AckSeq   uint32 // last input sequence the server has processed for this player
	Entities []Entity
}

// Player is the world's view of a connection. The network layer creates it
// (so allocation happens off the tick goroutine) and hands it over via Join.
type Player struct {
	ID     uint32
	Entity Entity

	// Out carries filled snapshots to the connection's writer goroutine.
	// Free returns drained buffers. Both are created by NewPlayer.
	Out  chan *Snapshot
	Free chan *Snapshot

	ackSeq uint32
}

// NewPlayer allocates a player and its snapshot buffer pool.
// Teams of one for now: the team ID equals the player ID.
func NewPlayer(id uint32) *Player {
	p := &Player{
		ID:     id,
		Entity: Entity{ID: id, TeamID: uint16(id)},
		Out:    make(chan *Snapshot, snapshotBuffers),
		Free:   make(chan *Snapshot, snapshotBuffers),
	}
	for i := 0; i < snapshotBuffers; i++ {
		p.Free <- &Snapshot{Entities: make([]Entity, 0, MaxPlayers)}
	}
	return p
}

type commandKind uint8

const (
	cmdJoin commandKind = iota
	cmdLeave
	cmdInput
)

type command struct {
	kind   commandKind
	player *Player // join
	id     uint32  // leave, input
	input  Input   // input
}

// World is the authoritative game state.
type World struct {
	tick    uint64
	players []*Player // cap MaxPlayers, never grows
	inbox   chan command

	publishedTick atomic.Uint64 // readable from other goroutines (healthz)
}

func NewWorld() *World {
	return &World{
		players: make([]*Player, 0, MaxPlayers),
		inbox:   make(chan command, inboxSize),
	}
}

// Tick returns the last completed tick. Safe from any goroutine.
func (w *World) Tick() uint64 { return w.publishedTick.Load() }

// Join registers a player. Blocks until the world accepts it or ctx ends.
func (w *World) Join(ctx context.Context, p *Player) {
	select {
	case w.inbox <- command{kind: cmdJoin, player: p}:
	case <-ctx.Done():
	}
}

// Leave removes a player. Blocks until the world accepts it or ctx ends.
func (w *World) Leave(ctx context.Context, id uint32) {
	select {
	case w.inbox <- command{kind: cmdLeave, id: id}:
	case <-ctx.Done():
	}
}

// SubmitInput queues a client input. It never blocks: if the inbox is full
// the input is dropped (the client will resend via its next input).
func (w *World) SubmitInput(id uint32, in Input) {
	select {
	case w.inbox <- command{kind: cmdInput, id: id, input: in}:
	default:
	}
}

// Run drives Step from ticks until ctx is cancelled. Taking the tick source as
// a channel lets tests drive the loop deterministically.
func (w *World) Run(ctx context.Context, ticks <-chan time.Time) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticks:
			w.Step()
		}
	}
}

// Step advances the world by one tick. MUST NOT ALLOCATE.
func (w *World) Step() {
	w.drainInbox()
	w.tick++

	// Movement/gameplay simulation goes here (designated file: movement.go).

	if w.tick%snapshotEvery == 0 {
		w.sendSnapshots()
	}
	w.publishedTick.Store(w.tick)
}

func (w *World) drainInbox() {
	for {
		select {
		case c := <-w.inbox:
			w.apply(c)
		default:
			return
		}
	}
}

func (w *World) apply(c command) {
	switch c.kind {
	case cmdJoin:
		if len(w.players) < cap(w.players) {
			w.players = append(w.players, c.player)
		}
	case cmdLeave:
		for i, p := range w.players {
			if p.ID == c.id {
				last := len(w.players) - 1
				w.players[i] = w.players[last]
				w.players[last] = nil
				w.players = w.players[:last]
				return
			}
		}
	case cmdInput:
		for _, p := range w.players {
			if p.ID == c.id {
				p.ackSeq = c.input.Seq
				return
			}
		}
	}
}

func (w *World) sendSnapshots() {
	for _, p := range w.players {
		var s *Snapshot
		select {
		case s = <-p.Free:
		default:
			continue // all buffers in flight: this client is slow, skip it
		}
		s.Tick = w.tick
		s.AckSeq = p.ackSeq
		s.Entities = w.entitiesFor(p, s.Entities[:0])
		select {
		case p.Out <- s:
		default:
			p.Free <- s // cannot happen (same capacity) but never lose a buffer
		}
	}
}

// entitiesFor is the single choke point for what a player may see.
// Interest management / fog of war / team visibility will live here.
// Currently returns everything.
func (w *World) entitiesFor(_ *Player, dst []Entity) []Entity {
	for _, p := range w.players {
		dst = append(dst, p.Entity)
	}
	return dst
}
