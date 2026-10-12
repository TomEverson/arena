package gameserver

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"arena/server/internal/game"
	"arena/server/internal/protocol"
	"arena/server/internal/wire"
)

// startServer runs a real world and HTTP/WebSocket server on a local port.
func startServer(t *testing.T) (url string) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	world := game.NewWorld(nil)
	ticker := time.NewTicker(time.Second / game.TickRate)
	t.Cleanup(ticker.Stop)
	go world.Run(ctx, ticker.C)
	srv := &Server{World: world, Codec: wire.JSON{}, LevelName: "test"}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws"
}

type client struct {
	t    *testing.T
	conn *websocket.Conn
	ctx  context.Context
}

func dial(t *testing.T, url string) *client {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	t.Cleanup(cancel)
	conn, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.CloseNow() })
	return &client{t: t, conn: conn, ctx: ctx}
}

func (c *client) send(v any) {
	c.t.Helper()
	b, _ := json.Marshal(v)
	if err := c.conn.Write(c.ctx, websocket.MessageText, b); err != nil {
		c.t.Fatal(err)
	}
}

// next reads messages until one has the wanted type.
func (c *client) next(want string) []byte {
	c.t.Helper()
	for {
		_, data, err := c.conn.Read(c.ctx)
		if err != nil {
			c.t.Fatalf("waiting for %s: %v", want, err)
		}
		var head struct {
			Type string `json:"type"`
		}
		_ = json.Unmarshal(data, &head)
		if head.Type == want {
			return data
		}
	}
}

func (c *client) snapshotUntil(pred func(protocol.Snapshot) bool) protocol.Snapshot {
	c.t.Helper()
	for {
		var s protocol.Snapshot
		if err := json.Unmarshal(c.next("snapshot"), &s); err != nil {
			c.t.Fatal(err)
		}
		if pred(s) {
			return s
		}
	}
}

func TestWelcomePingAndSnapshots(t *testing.T) {
	c := dial(t, startServer(t))

	var w protocol.Welcome
	if err := json.Unmarshal(c.next("welcome"), &w); err != nil {
		t.Fatal(err)
	}
	if w.PlayerID != 1 || w.TickRate != 60 || w.SnapshotRate != 30 || w.Level != "test" {
		t.Fatalf("welcome = %+v", w)
	}

	c.send(map[string]any{"type": "ping", "t": 1234.5})
	var p protocol.Pong
	if err := json.Unmarshal(c.next("pong"), &p); err != nil {
		t.Fatal(err)
	}
	if p.T != 1234.5 {
		t.Fatalf("pong did not echo the client time: %+v", p)
	}

	s := c.snapshotUntil(func(protocol.Snapshot) bool { return true })
	if s.You.AirJumps != game.MaxAirJumps || len(s.Entities) != 0 {
		t.Fatalf("first snapshot = %+v", s)
	}
}

func TestInputsAreSimulatedOnceAndAcked(t *testing.T) {
	c := dial(t, startServer(t))
	c.next("welcome")

	// The client resends its last three inputs every tick; each seq must be simulated once.
	input := func(seq uint32) map[string]any {
		return map[string]any{"seq": seq, "moveZ": 1.0, "yaw": 0.0}
	}
	var window []map[string]any
	for seq := uint32(1); seq <= 20; seq++ {
		window = append(window, input(seq))
		if len(window) > 3 {
			window = window[1:]
		}
		c.send(map[string]any{"type": "input", "inputs": window})
		time.Sleep(time.Second / 60)
	}
	s := c.snapshotUntil(func(s protocol.Snapshot) bool { return s.AckSeq == 20 })
	if s.You.Z >= -0.5 {
		t.Fatalf("player did not run forward: z = %v", s.You.Z)
	}

	// Compare with the movement function run directly on the same 20 inputs.
	want := game.SpawnState(0, 0, 0)
	lv := game.FlatLevel()
	for seq := uint32(1); seq <= 20; seq++ {
		in := game.Input{Seq: seq, MoveZ: 1}
		game.StepPlayer(&want, &in, &lv.Collision, game.TickDT)
	}
	if d := s.You.Z - want.Z; d > 1e-9 || d < -1e-9 {
		t.Fatalf("server z = %v, direct simulation z = %v: an input was applied twice or skipped", s.You.Z, want.Z)
	}
}

func TestRespawnMessageResetsPlayer(t *testing.T) {
	c := dial(t, startServer(t))
	c.next("welcome")
	var window []map[string]any
	for seq := uint32(1); seq <= 15; seq++ {
		window = append(window, map[string]any{"seq": seq, "moveZ": 1.0})
		if len(window) > 3 {
			window = window[1:]
		}
		c.send(map[string]any{"type": "input", "inputs": window})
		time.Sleep(time.Second / 60)
	}
	c.snapshotUntil(func(s protocol.Snapshot) bool { return s.AckSeq == 15 && s.You.Z < -1 })
	c.send(map[string]any{"type": "respawn"})
	s := c.snapshotUntil(func(s protocol.Snapshot) bool { return s.You.Z == 0 })
	if s.You.X != 0 || s.You.Y != 0 {
		t.Fatalf("respawned at %v, %v, %v", s.You.X, s.You.Y, s.You.Z)
	}
}

func TestIgnoresGarbageAndKeepsRunning(t *testing.T) {
	c := dial(t, startServer(t))
	c.next("welcome")
	for _, junk := range []string{`not json`, `{"type":"nonsense"}`, `{"type":"input"}`, `{"type":"input","inputs":[{"seq":"x"}]}`} {
		if err := c.conn.Write(c.ctx, websocket.MessageText, []byte(junk)); err != nil {
			t.Fatal(err)
		}
	}
	c.send(map[string]any{"type": "ping", "t": 1})
	c.next("pong") // still alive and answering
}
