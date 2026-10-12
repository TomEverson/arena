// Package gameserver is the network edge: HTTP endpoints and WebSocket
// sessions. Network goroutines only push inputs into the world's inbox and
// drain snapshots from it; they never touch world state.
package gameserver

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"sync/atomic"

	"github.com/coder/websocket"

	"arena/server/internal/game"
	"arena/server/internal/netsim"
	"arena/server/internal/wire"
)

type Server struct {
	World  *game.World
	Codec  wire.Codec
	Link   netsim.Link
	nextID atomic.Uint32
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", s.handleHealth)
	mux.HandleFunc("/ws", s.handleWS)
	return mux
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"status": "ok", "tick": s.World.Tick()})
}

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// Dev: the Vite dev server (any localhost port) proxies here.
		OriginPatterns: []string{"localhost:*", "127.0.0.1:*"},
	})
	if err != nil {
		log.Printf("ws accept: %v", err)
		return
	}
	defer conn.CloseNow()
	conn.SetReadLimit(4096)

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	msgType := websocket.MessageText
	if s.Codec.Binary() {
		msgType = websocket.MessageBinary
	}
	// send applies the fake network to an outgoing frame. The frame is copied
	// only when the link may hold on to it past this call.
	send := func(frame []byte) {
		if s.Link.Active() {
			frame = append([]byte(nil), frame...)
		}
		s.Link.Deliver(func() { _ = conn.Write(ctx, msgType, frame) })
	}

	p := game.NewPlayer(s.nextID.Add(1))
	log.Printf("player %d connected", p.ID)

	hello, err := s.Codec.EncodeWelcome(nil, p.ID)
	if err != nil {
		log.Printf("encode welcome: %v", err)
		return
	}
	send(hello)

	s.World.Join(ctx, p)
	defer func() {
		// ctx may already be cancelled; leave must still reach the world.
		s.World.Leave(context.Background(), p.ID)
		log.Printf("player %d disconnected", p.ID)
	}()

	go s.writeLoop(ctx, p, send)

	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			return
		}
		s.Link.Deliver(func() {
			var msg game.Input // fresh value: Deliver may run this on another goroutine
			if err := s.Codec.DecodeInput(data, &msg); err == nil {
				s.World.SubmitInput(p.ID, msg)
			}
		})
	}
}

// writeLoop encodes snapshots coming out of the world and returns each buffer
// to the player's free list so the tick loop never allocates.
func (s *Server) writeLoop(ctx context.Context, p *game.Player, send func([]byte)) {
	var buf []byte
	for {
		select {
		case <-ctx.Done():
			return
		case snap := <-p.Out:
			var err error
			buf, err = s.Codec.EncodeSnapshot(buf[:0], snap)
			p.Free <- snap
			if err != nil {
				log.Printf("encode snapshot: %v", err)
				continue
			}
			send(buf)
		}
	}
}
