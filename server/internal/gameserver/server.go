// Package gameserver is the network edge: HTTP endpoints and WebSocket
// sessions. Network goroutines only push inputs into the world's inbox and
// drain snapshots from it; they never touch world state.
package gameserver

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strings"
	"sync/atomic"

	"github.com/coder/websocket"

	"arena/server/internal/game"
	"arena/server/internal/netsim"
	"arena/server/internal/protocol"
	"arena/server/internal/wire"
)

// practiceActions are the helper commands a client may send in a practice range.
var practiceActions = map[string]game.PracticeAction{
	"refill": game.PracticeRefill,
	"start":  game.PracticeStart,
	"reset":  game.PracticeReset,
}

// WebSocket close codes the client understands (4000-4999 are free for applications).
const (
	CloseRoomNotFound websocket.StatusCode = 4001
	CloseRoomFull     websocket.StatusCode = 4002
)

type Server struct {
	Rooms *Rooms
	Codec wire.Codec
	Link  netsim.Link
	// LevelName is reported to clients so they can check they run the same map.
	LevelName string
	nextID    atomic.Uint32
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", s.handleHealth)
	mux.HandleFunc("POST /api/rooms", s.handleCreateRoom)
	mux.HandleFunc("GET /api/rooms/{code}", s.handleRoomInfo)
	mux.HandleFunc("/ws", s.handleWS)
	return mux
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "rooms": s.Rooms.Count()})
}

// handleCreateRoom starts a new room and returns its code: the link is /?room=<code>.
// The optional JSON body {"mode": "ffa" | "practice"} picks the mode (default ffa).
func (s *Server) handleCreateRoom(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Mode string `json:"mode"`
	}
	if r.ContentLength != 0 {
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad request body"})
			return
		}
	}
	if body.Mode == "" {
		body.Mode = ModeFFA
	}
	room, err := s.Rooms.Create(body.Mode)
	switch {
	case errors.Is(err, ErrUnknownMode):
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	case err != nil:
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": err.Error()})
		return
	}
	log.Printf("room %s created (%s)", room.Code, room.Mode)
	writeJSON(w, http.StatusCreated, map[string]any{"code": room.Code, "mode": room.Mode, "maxPlayers": room.Capacity()})
}

// handleRoomInfo says whether a room exists and how full it is, so a page can check a link before joining.
func (s *Server) handleRoomInfo(w http.ResponseWriter, r *http.Request) {
	room := s.Rooms.Get(strings.ToUpper(r.PathValue("code")))
	if room == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "room not found"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"code":       room.Code,
		"mode":       room.Mode,
		"players":    room.Players(),
		"maxPlayers": room.Capacity(),
	})
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
	conn.SetReadLimit(8192)

	room := s.Rooms.Get(strings.ToUpper(r.URL.Query().Get("room")))
	if room == nil {
		_ = conn.Close(CloseRoomNotFound, "room not found")
		return
	}
	if !room.reserve() {
		_ = conn.Close(CloseRoomFull, "room full")
		return
	}
	defer room.release()

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
	log.Printf("player %d joined room %s", p.ID, room.Code)

	levelName := room.LevelName // each mode can run its own map
	if levelName == "" {
		levelName = s.LevelName
	}
	hello, err := s.Codec.EncodeWelcome(nil, &protocol.Welcome{
		Type:         protocol.ServerTypeWelcome,
		PlayerID:     p.ID,
		TickRate:     game.TickRate,
		SnapshotRate: game.SnapshotRate,
		Level:        levelName,
		Room:         room.Code,
		Mode:         room.Mode,
		MaxPlayers:   uint8(room.Capacity()),
	})
	if err != nil {
		log.Printf("encode welcome: %v", err)
		return
	}
	send(hello)

	room.World.Join(ctx, p)
	defer func() {
		// ctx may already be cancelled; leave must still reach the world.
		room.World.Leave(context.Background(), p.ID)
		log.Printf("player %d left room %s", p.ID, room.Code)
	}()

	go s.writeLoop(ctx, p, send)

	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			return
		}
		s.Link.Deliver(func() {
			var msg protocol.ClientMessage // fresh value: Deliver may run this on another goroutine
			if err := s.Codec.DecodeClient(data, &msg); err != nil {
				return
			}
			s.handle(ctx, room, p.ID, &msg, send)
		})
	}
}

// handle acts on one client message. It only talks to the world through its channels.
func (s *Server) handle(
	ctx context.Context,
	room *Room,
	id uint32,
	msg *protocol.ClientMessage,
	send func([]byte),
) {
	switch msg.Type {
	case protocol.ClientTypeInput:
		// Resent redundantly by the client; the world skips sequence numbers it already has.
		for i := range msg.Inputs {
			room.World.SubmitInput(id, msg.Inputs[i])
		}
	case protocol.ClientTypePing:
		frame, err := s.Codec.EncodePong(nil, &protocol.Pong{
			Type: protocol.ServerTypePong,
			T:    msg.T,
			Tick: uint32(room.World.Tick()),
		})
		if err == nil {
			send(frame)
		}
	case protocol.ClientTypeRespawn:
		room.World.Respawn(ctx, id)
	case protocol.ClientTypePractice:
		if action, ok := practiceActions[msg.Action]; ok {
			room.World.Practice(ctx, id, action) // the world ignores it outside a practice range
		}
	case protocol.ClientTypeHero:
		room.World.SetHero(ctx, id, msg.Hero)
	case protocol.ClientTypeRematch:
		room.World.Rematch(ctx, id)
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
