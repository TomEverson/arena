package gameserver

import (
	"context"
	"crypto/rand"
	"errors"
	"sync"
	"sync/atomic"
	"time"

	"arena/server/internal/game"
)

// A room is one match: its own world running its own 60 Hz tick loop. Friends join
// the same room by sharing its code (the "link").

// codeAlphabet leaves out look-alikes (0/O, 1/I) so codes survive being read aloud.
const (
	codeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	codeLength   = 5
)

// The game modes a room can be in.
const (
	ModeFFA      = "ffa"
	ModePractice = "practice"
)

var (
	// ErrTooManyRooms is returned when the server is at its room limit.
	ErrTooManyRooms = errors.New("too many rooms")
	// ErrUnknownMode is returned for a mode the server does not run.
	ErrUnknownMode = errors.New("unknown mode")
)

// ModeConfig is what a room of one mode is made from.
type ModeConfig struct {
	// Level is shared by every room of the mode and is read-only once loaded.
	Level *game.Level
	Match game.MatchConfig
	// Practice makes the room a practice range (targets, no player-vs-player damage).
	Practice bool
}

// RoomsConfig is what the room manager needs.
type RoomsConfig struct {
	// Modes maps a mode name to how its rooms are made.
	Modes map[string]ModeConfig
	// EmptyTimeout is how long an empty room is kept (so a page refresh does not lose it).
	EmptyTimeout time.Duration
	// MaxRooms bounds memory and CPU.
	MaxRooms int
}

// Room is one running match.
type Room struct {
	Code  string
	Mode  string
	World *game.World
	// LevelName is the map this room runs (from the level file); clients load the same one.
	LevelName string

	capacity int
	seats    atomic.Int32 // connected or connecting players
	// emptySince is when the last player left (unix nanoseconds), or 0 while occupied.
	emptySince atomic.Int64
	cancel     context.CancelFunc
}

// reserve takes a seat, or reports that the room is full.
func (r *Room) reserve() bool {
	if int(r.seats.Add(1)) > r.capacity {
		r.seats.Add(-1)
		return false
	}
	r.emptySince.Store(0)
	return true
}

func (r *Room) release() {
	if r.seats.Add(-1) == 0 {
		r.emptySince.Store(time.Now().UnixNano())
	}
}

// Players is how many players are seated.
func (r *Room) Players() int { return int(r.seats.Load()) }

// Capacity is the most players the room takes.
func (r *Room) Capacity() int { return r.capacity }

// Rooms creates, finds and cleans up rooms. It lives on the network side, so a mutex is fine;
// each room's simulation runs on its own goroutine without locks.
type Rooms struct {
	cfg RoomsConfig
	ctx context.Context

	mu    sync.Mutex
	rooms map[string]*Room
}

// NewRooms starts the idle-room reaper; everything stops when ctx ends.
func NewRooms(ctx context.Context, cfg RoomsConfig) *Rooms {
	if cfg.EmptyTimeout <= 0 {
		cfg.EmptyTimeout = time.Minute
	}
	if cfg.MaxRooms <= 0 {
		cfg.MaxRooms = 64
	}
	m := &Rooms{cfg: cfg, ctx: ctx, rooms: map[string]*Room{}}
	go m.reapLoop()
	return m
}

func newCode() string {
	b := make([]byte, codeLength)
	_, _ = rand.Read(b)
	for i := range b {
		b[i] = codeAlphabet[int(b[i])%len(codeAlphabet)]
	}
	return string(b)
}

// Create starts a new room of the given mode with a fresh code.
func (m *Rooms) Create(mode string) (*Room, error) {
	mc, ok := m.cfg.Modes[mode]
	if !ok {
		return nil, ErrUnknownMode
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.rooms) >= m.cfg.MaxRooms {
		return nil, ErrTooManyRooms
	}
	code := newCode()
	for m.rooms[code] != nil {
		code = newCode()
	}

	world := game.NewWorld(mc.Level)
	world.SetMatchConfig(mc.Match)
	world.SetPractice(mc.Practice)
	capacity := mc.Match.Capacity
	if capacity <= 0 {
		capacity = game.MaxPlayers
	}
	ctx, cancel := context.WithCancel(m.ctx)
	room := &Room{Code: code, Mode: mode, World: world, LevelName: mc.Level.Name, capacity: capacity, cancel: cancel}
	room.emptySince.Store(time.Now().UnixNano())
	go func() {
		ticker := time.NewTicker(time.Second / game.TickRate)
		defer ticker.Stop()
		world.Run(ctx, ticker.C)
	}()
	m.rooms[code] = room
	return room, nil
}

// Get returns the room with this code, or nil.
func (m *Rooms) Get(code string) *Room {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.rooms[code]
}

// Count is the number of rooms.
func (m *Rooms) Count() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.rooms)
}

func (m *Rooms) reapLoop() {
	interval := m.cfg.EmptyTimeout / 4
	if interval < 50*time.Millisecond {
		interval = 50 * time.Millisecond
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-m.ctx.Done():
			return
		case <-ticker.C:
			m.reap()
		}
	}
}

// reap stops rooms that have been empty longer than the timeout.
func (m *Rooms) reap() {
	cutoff := time.Now().Add(-m.cfg.EmptyTimeout).UnixNano()
	m.mu.Lock()
	defer m.mu.Unlock()
	for code, r := range m.rooms {
		if since := r.emptySince.Load(); since != 0 && since < cutoff && r.seats.Load() == 0 {
			r.cancel()
			delete(m.rooms, code)
		}
	}
}
