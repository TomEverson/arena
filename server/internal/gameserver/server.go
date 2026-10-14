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
	"net/url"
	"path"
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
	// AllowedOrigins are the hosts a page may be served from and still talk to this server,
	// besides localhost: the site's own host names when the client is hosted somewhere else
	// (a pattern per host, as path.Match reads it: "arena.example.com", "*.example.com").
	AllowedOrigins []string
	// wt is the WebTransport side (webtransport.go), set by ServeWebTransport; nil when off.
	wt     *wtServer
	nextID atomic.Uint32
	// Snapshot metrics are intentionally kept at the network edge: they measure the encoded
	// payload that clients actually receive, rather than the in-memory game snapshot.
	snapshotCount atomic.Uint64
	snapshotBytes atomic.Uint64
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", s.handleHealth)
	mux.HandleFunc("POST /api/rooms", s.handleCreateRoom)
	mux.HandleFunc("GET /api/rooms/{code}", s.handleRoomInfo)
	mux.HandleFunc("GET /api/transport", s.handleTransport)
	mux.HandleFunc("/ws", s.handleWS)
	return s.cors(mux)
}

// devOrigins are always allowed: the Vite dev server (any localhost port) proxies here.
var devOrigins = []string{"localhost:*", "127.0.0.1:*"}

// originAllowed reports whether a page from this Origin header may use the server.
func (s *Server) originAllowed(origin string) bool {
	u, err := url.Parse(origin)
	if err != nil || u.Host == "" {
		return false
	}
	host := strings.ToLower(u.Host)
	for _, list := range [][]string{devOrigins, s.AllowedOrigins} {
		for _, pattern := range list {
			if ok, _ := path.Match(strings.ToLower(pattern), host); ok {
				return true
			}
		}
	}
	return false
}

// cors lets pages on the allowed origins call the HTTP API from another host (the client on a
// static host, the server here). The WebSocket has its own origin check in handleWS. Requests
// with no Origin header (curl, health checks, same-origin pages) pass through untouched.
func (s *Server) cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if origin := r.Header.Get("Origin"); origin != "" && s.originAllowed(origin) {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Add("Vary", "Origin")
			if r.Method == http.MethodOptions && r.Header.Get("Access-Control-Request-Method") != "" {
				w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
				w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
				w.Header().Set("Access-Control-Max-Age", "86400")
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	count := s.snapshotCount.Load()
	bytes := s.snapshotBytes.Load()
	writeJSON(w, http.StatusOK, map[string]any{
		"status":        "ok",
		"rooms":         s.Rooms.Count(),
		"snapshots":     count,
		"snapshotBytes": bytes,
		"averageSnapshot": func() uint64 {
			if count == 0 {
				return 0
			}
			return bytes / count
		}(),
	})
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

// link is one client's connection, whatever carries it (a WebSocket, a WebTransport session).
// Frames are whole encoded messages. Sends never block the caller for long and may be called
// from several goroutines.
type link interface {
	// sendReliable delivers the frame, in order with the other reliable ones.
	sendReliable(frame []byte)
	// sendLossy delivers the frame if it can, without ever waiting behind an older one. The frame
	// must not be kept after the call returns.
	sendLossy(frame []byte)
}

// play runs one player in a room over a connection: it joins the world, sends the welcome and
// then snapshots until ctx ends. It returns what to do with each message from the client, and
// the function that takes the player out again.
func (s *Server) play(ctx context.Context, room *Room, l link) (onMessage func(data []byte), leave func(), err error) {
	// The fake network: latency on everything, loss only on what is allowed to be lost. A frame
	// is copied when the link may hold on to it past the call.
	steady := netsim.Link{Latency: s.Link.Latency}
	reliable := func(frame []byte) {
		if steady.Active() {
			frame = append([]byte(nil), frame...)
		}
		steady.Deliver(func() { l.sendReliable(frame) })
	}
	lossy := func(frame []byte) {
		if s.Link.Active() {
			frame = append([]byte(nil), frame...)
		}
		s.Link.Deliver(func() { l.sendLossy(frame) })
	}

	p := game.NewPlayer(s.nextID.Add(1))
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
		return nil, nil, err
	}
	log.Printf("player %d joined room %s", p.ID, room.Code)
	reliable(hello)

	room.World.Join(ctx, p)
	go s.writeLoop(ctx, p, lossy)

	onMessage = func(data []byte) {
		s.Link.Deliver(func() {
			var msg protocol.ClientMessage // fresh value: Deliver may run this on another goroutine
			if err := s.Codec.DecodeClient(data, &msg); err != nil {
				return
			}
			s.handle(ctx, room, p.ID, &msg, lossy)
		})
	}
	leave = func() {
		// ctx may already be cancelled; leave must still reach the world.
		room.World.Leave(context.Background(), p.ID)
		log.Printf("player %d left room %s", p.ID, room.Code)
	}
	return onMessage, leave, nil
}

// wsLink is a WebSocket: one ordered stream, so "lossy" frames simply arrive like the rest.
type wsLink struct {
	ctx     context.Context
	conn    *websocket.Conn
	msgType websocket.MessageType
}

func (l wsLink) sendReliable(frame []byte) { _ = l.conn.Write(l.ctx, l.msgType, frame) }
func (l wsLink) sendLossy(frame []byte)    { _ = l.conn.Write(l.ctx, l.msgType, frame) }

// handleWS serves the WebSocket transport: what the headless test players use (Node has no
// WebTransport), and browsers when asked to with ?transport=ws.
func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		OriginPatterns: append(append([]string{}, devOrigins...), s.AllowedOrigins...),
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
	onMessage, leave, err := s.play(ctx, room, wsLink{ctx: ctx, conn: conn, msgType: msgType})
	if err != nil {
		log.Printf("encode welcome: %v", err)
		return
	}
	defer leave()

	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			return
		}
		onMessage(data)
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
		if msg.Ack > 0 {
			room.World.AckSnapshot(id, msg.Ack) // what it has got, so the rest can be repeated
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
			s.snapshotCount.Add(1)
			s.snapshotBytes.Add(uint64(len(buf)))
			send(buf)
		}
	}
}
