package gameserver

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	os "os"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"arena/server/internal/game"
	"arena/server/internal/protocol"
	"arena/server/internal/wire"
)

func TestMain(m *testing.M) {
	log.SetOutput(io.Discard) // rooms and players log every join and leave
	os.Exit(m.Run())
}

type testServer struct {
	t     *testing.T
	http  string // http://host:port
	ws    string // ws://host:port
	rooms *Rooms
}

// practice rooms are always live, which suits tests that are not about the match cycle.
func practice() game.MatchConfig {
	cfg := game.DefaultMatchConfig()
	cfg.Enabled = false
	cfg.Capacity = 8
	return cfg
}

// testCfg is what a test cares about; the modes are built from it.
type testCfg struct {
	Match        game.MatchConfig // how FFA rooms run
	EmptyTimeout time.Duration
	MaxRooms     int
}

func rangeLevel() *game.Level {
	lv := game.FlatLevel()
	lv.Name = "range-test" // a mode's own map is what its welcome names
	lv.Targets = []game.TargetSpec{{ID: "t1", Pos: game.Vec3{Z: -10}}, {ID: "t2", Pos: game.Vec3{X: 5, Z: -15}}}
	return lv
}

func startServer(t *testing.T, cfg testCfg) *testServer {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	rangeMatch := practice()
	rooms := NewRooms(ctx, RoomsConfig{
		Modes: map[string]ModeConfig{
			ModeFFA:      {Level: game.FlatLevel(), Match: cfg.Match},
			ModePractice: {Level: rangeLevel(), Match: rangeMatch, Practice: true},
		},
		EmptyTimeout: cfg.EmptyTimeout,
		MaxRooms:     cfg.MaxRooms,
	})
	srv := &Server{Rooms: rooms, Codec: wire.JSON{}, LevelName: "test"}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return &testServer{t: t, http: ts.URL, ws: "ws" + strings.TrimPrefix(ts.URL, "http"), rooms: rooms}
}

func (s *testServer) createRoom() string { return s.createRoomMode("") }

// createRoomMode makes a room of the given mode ("" sends no body, which means ffa).
func (s *testServer) createRoomMode(mode string) string {
	s.t.Helper()
	var body io.Reader
	if mode != "" {
		body = strings.NewReader(`{"mode":"` + mode + `"}`)
	}
	resp, err := http.Post(s.http+"/api/rooms", "application/json", body)
	if err != nil {
		s.t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		s.t.Fatalf("create room: status %d", resp.StatusCode)
	}
	var out struct {
		Code string `json:"code"`
		Mode string `json:"mode"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil || out.Code == "" {
		s.t.Fatalf("create room: %v %+v", err, out)
	}
	want := mode
	if want == "" {
		want = ModeFFA
	}
	if out.Mode != want {
		s.t.Fatalf("created a %q room, want %q", out.Mode, want)
	}
	return out.Code
}

type client struct {
	t    *testing.T
	conn *websocket.Conn
	ctx  context.Context
}

func dial(t *testing.T, url string) *client {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	t.Cleanup(cancel)
	conn, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.CloseNow() })
	return &client{t: t, conn: conn, ctx: ctx}
}

func (s *testServer) join(code string) *client { return dial(s.t, s.ws+"/ws?room="+code) }

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

// closeCode reads until the server closes the connection and returns its close code.
func (c *client) closeCode() websocket.StatusCode {
	c.t.Helper()
	for {
		if _, _, err := c.conn.Read(c.ctx); err != nil {
			return websocket.CloseStatus(err)
		}
	}
}

func inputWindow(seq uint32, window *[]map[string]any, in map[string]any) []map[string]any {
	in["seq"] = seq
	*window = append(*window, in)
	if len(*window) > 3 {
		*window = (*window)[1:]
	}
	return *window
}

func TestCreateRoomAndWelcome(t *testing.T) {
	s := startServer(t, testCfg{Match: practice()})
	code := s.createRoom()
	if len(code) != codeLength || strings.Trim(code, codeAlphabet) != "" {
		t.Fatalf("room code %q should be %d characters from %q", code, codeLength, codeAlphabet)
	}
	c := s.join(code)
	var w protocol.Welcome
	if err := json.Unmarshal(c.next("welcome"), &w); err != nil {
		t.Fatal(err)
	}
	if w.PlayerID != 1 || w.TickRate != 60 || w.SnapshotRate != 30 || w.Level != "test" || w.Room != code || w.MaxPlayers != 8 || w.Mode != "ffa" {
		t.Fatalf("welcome = %+v", w)
	}
}

func TestRoomCodesAreCaseInsensitiveAndUnique(t *testing.T) {
	s := startServer(t, testCfg{Match: practice()})
	seen := map[string]bool{}
	for i := 0; i < 20; i++ {
		code := s.createRoom()
		if seen[code] {
			t.Fatalf("duplicate room code %s", code)
		}
		seen[code] = true
	}
	code := s.createRoom()
	c := s.join(strings.ToLower(code))
	var w protocol.Welcome
	_ = json.Unmarshal(c.next("welcome"), &w)
	if w.Room != code {
		t.Fatalf("joined %q, want %q", w.Room, code)
	}
}

func TestUnknownRoomIsRejected(t *testing.T) {
	s := startServer(t, testCfg{Match: practice()})
	for _, url := range []string{s.ws + "/ws?room=ZZZZZ", s.ws + "/ws"} {
		c := dial(t, url)
		if got := c.closeCode(); got != CloseRoomNotFound {
			t.Fatalf("%s: close code %d, want %d", url, got, CloseRoomNotFound)
		}
	}
}

func TestFullRoomIsRejectedUntilSomeoneLeaves(t *testing.T) {
	cfg := practice()
	cfg.Capacity = 2
	s := startServer(t, testCfg{Match: cfg})
	code := s.createRoom()
	a, b := s.join(code), s.join(code)
	a.next("welcome")
	b.next("welcome")
	if got := s.join(code).closeCode(); got != CloseRoomFull {
		t.Fatalf("third player: close code %d, want %d", got, CloseRoomFull)
	}
	a.conn.Close(websocket.StatusNormalClosure, "bye")
	time.Sleep(200 * time.Millisecond)
	c := s.join(code)
	c.next("welcome") // a seat opened up
}

func TestRoomInfoEndpoint(t *testing.T) {
	s := startServer(t, testCfg{Match: practice()})
	code := s.createRoom()
	s.join(code).next("welcome")
	resp, err := http.Get(s.http + "/api/rooms/" + strings.ToLower(code))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 || !strings.Contains(string(body), `"players":1`) || !strings.Contains(string(body), `"maxPlayers":8`) {
		t.Fatalf("room info: %d %s", resp.StatusCode, body)
	}
	missing, _ := http.Get(s.http + "/api/rooms/NOPE1")
	missing.Body.Close()
	if missing.StatusCode != 404 {
		t.Fatalf("missing room: status %d", missing.StatusCode)
	}
}

func TestRoomsAreIndependent(t *testing.T) {
	s := startServer(t, testCfg{Match: practice()})
	one, two := s.createRoom(), s.createRoom()
	a, b := s.join(one), s.join(one)
	c := s.join(two)
	// a sees b but not c.
	snap := a.snapshotUntil(func(s protocol.Snapshot) bool { return len(s.Entities) >= 1 })
	if len(snap.Entities) != 1 {
		t.Fatalf("a sees %d others, want 1", len(snap.Entities))
	}
	alone := c.snapshotUntil(func(protocol.Snapshot) bool { return true })
	if len(alone.Entities) != 0 {
		t.Fatalf("a player in another room sees %d others", len(alone.Entities))
	}
	_ = b
}

func TestEmptyRoomsAreReaped(t *testing.T) {
	s := startServer(t, testCfg{Match: practice(), EmptyTimeout: 300 * time.Millisecond})
	kept, dropped := s.createRoom(), s.createRoom()
	s.join(kept).next("welcome") // stays occupied for the whole test
	deadline := time.Now().Add(3 * time.Second)
	for s.rooms.Get(dropped) != nil {
		if time.Now().After(deadline) {
			t.Fatal("the empty room was never cleaned up")
		}
		time.Sleep(50 * time.Millisecond)
	}
	if s.rooms.Get(kept) == nil {
		t.Fatal("an occupied room was reaped")
	}
}

func TestRoomLimit(t *testing.T) {
	s := startServer(t, testCfg{Match: practice(), MaxRooms: 2})
	s.createRoom()
	s.createRoom()
	resp, err := http.Post(s.http+"/api/rooms", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("third room: status %d, want 503", resp.StatusCode)
	}
}

func TestPingAndSnapshots(t *testing.T) {
	s := startServer(t, testCfg{Match: practice()})
	c := s.join(s.createRoom())
	c.next("welcome")
	c.send(map[string]any{"type": "ping", "t": 1234.5})
	var p protocol.Pong
	if err := json.Unmarshal(c.next("pong"), &p); err != nil {
		t.Fatal(err)
	}
	if p.T != 1234.5 {
		t.Fatalf("pong did not echo the client time: %+v", p)
	}
	snap := c.snapshotUntil(func(protocol.Snapshot) bool { return true })
	if snap.You.AirJumps != game.MaxAirJumps || len(snap.Entities) != 0 {
		t.Fatalf("first snapshot = %+v", snap)
	}
	if snap.Match.Phase != protocol.MatchPhaseLive || snap.Match.Players != 1 || len(snap.Scores) != 1 {
		t.Fatalf("match info / scores = %+v / %+v", snap.Match, snap.Scores)
	}
}

func TestInputsAreSimulatedOnceAndAcked(t *testing.T) {
	s := startServer(t, testCfg{Match: practice()})
	c := s.join(s.createRoom())
	c.next("welcome")

	// The client resends its last three inputs every tick; each seq must be simulated once.
	var window []map[string]any
	for seq := uint32(1); seq <= 20; seq++ {
		c.send(map[string]any{"type": "input", "inputs": inputWindow(seq, &window, map[string]any{"moveZ": 1.0, "yaw": 0.0})})
		time.Sleep(time.Second / 60)
	}
	snap := c.snapshotUntil(func(s protocol.Snapshot) bool { return s.AckSeq == 20 })
	if snap.You.Z >= -0.5 {
		t.Fatalf("player did not run forward: z = %v", snap.You.Z)
	}

	// Compare with the movement function run directly on the same 20 inputs.
	want := game.SpawnState(0, 0, 0)
	lv := game.FlatLevel()
	for seq := uint32(1); seq <= 20; seq++ {
		in := game.Input{Seq: seq, MoveZ: 1}
		game.StepPlayer(&want, &in, &lv.Collision, game.TickDT)
	}
	if d := snap.You.Z - want.Z; d > 1e-9 || d < -1e-9 {
		t.Fatalf("server z = %v, direct simulation z = %v: an input was applied twice or skipped", snap.You.Z, want.Z)
	}
}

func TestRespawnMessageResetsPlayer(t *testing.T) {
	s := startServer(t, testCfg{Match: practice()})
	c := s.join(s.createRoom())
	c.next("welcome")
	var window []map[string]any
	for seq := uint32(1); seq <= 15; seq++ {
		c.send(map[string]any{"type": "input", "inputs": inputWindow(seq, &window, map[string]any{"moveZ": 1.0})})
		time.Sleep(time.Second / 60)
	}
	c.snapshotUntil(func(s protocol.Snapshot) bool { return s.AckSeq == 15 && s.You.Z < -1 })
	c.send(map[string]any{"type": "respawn"})
	snap := c.snapshotUntil(func(s protocol.Snapshot) bool { return s.You.Z == 0 })
	if snap.You.X != 0 || snap.You.Y != 0 {
		t.Fatalf("respawned at %v, %v, %v", snap.You.X, snap.You.Y, snap.You.Z)
	}
}

func TestMatchCycleOverTheWire(t *testing.T) {
	cfg := game.DefaultMatchConfig()
	cfg.Capacity = 8
	cfg.Countdown, cfg.Length, cfg.Results = 0.3, 30, 30 // the match and the results would last a long time
	s := startServer(t, testCfg{Match: cfg})
	code := s.createRoom()
	a := s.join(code)
	a.next("welcome")
	alone := a.snapshotUntil(func(protocol.Snapshot) bool { return true })
	if alone.Match.Phase != protocol.MatchPhaseWaiting || alone.Match.MinPlayers != 2 {
		t.Fatalf("alone in the room: %+v, want waiting for 2 players", alone.Match)
	}

	b := s.join(code)
	b.next("welcome")
	a.snapshotUntil(func(s protocol.Snapshot) bool { return s.Match.Phase == protocol.MatchPhaseCountdown })
	live := a.snapshotUntil(func(s protocol.Snapshot) bool { return s.Match.Phase == protocol.MatchPhaseLive })
	if live.Match.Players != 2 || len(live.Scores) != 2 || live.Match.TimeLeft <= 0 {
		t.Fatalf("live match info = %+v, scores %+v", live.Match, live.Scores)
	}

	// The only opponent leaves: the match is over, and the leader (a) is shown as the winner or a draw.
	b.conn.Close(websocket.StatusNormalClosure, "bye")
	a.snapshotUntil(func(s protocol.Snapshot) bool { return s.Match.Phase == protocol.MatchPhaseEnded })

	// Asking for a rematch with nobody to play goes back to waiting instead of hanging on the results.
	a.send(map[string]any{"type": "rematch"})
	a.snapshotUntil(func(s protocol.Snapshot) bool { return s.Match.Phase == protocol.MatchPhaseWaiting })
}

func TestIgnoresGarbageAndKeepsRunning(t *testing.T) {
	s := startServer(t, testCfg{Match: practice()})
	c := s.join(s.createRoom())
	c.next("welcome")
	for _, junk := range []string{`not json`, `{"type":"nonsense"}`, `{"type":"input"}`, `{"type":"input","inputs":[{"seq":"x"}]}`} {
		if err := c.conn.Write(c.ctx, websocket.MessageText, []byte(junk)); err != nil {
			t.Fatal(err)
		}
	}
	c.send(map[string]any{"type": "ping", "t": 1})
	c.next("pong") // still alive and answering
}

func TestPracticeRoomHasTargetsAndNoMatchCycle(t *testing.T) {
	s := startServer(t, testCfg{Match: game.DefaultMatchConfig()}) // FFA rooms would be waiting for a second player
	c := s.join(s.createRoomMode("practice"))
	var w protocol.Welcome
	if err := json.Unmarshal(c.next("welcome"), &w); err != nil {
		t.Fatal(err)
	}
	if w.Mode != "practice" {
		t.Fatalf("welcome mode = %q", w.Mode)
	}
	snap := c.snapshotUntil(func(protocol.Snapshot) bool { return true })
	if snap.Match.Phase != protocol.MatchPhaseLive {
		t.Fatalf("a practice range is always live, phase = %d", snap.Match.Phase)
	}
	if len(snap.Entities) != 2 {
		t.Fatalf("snapshot has %d entities, want the 2 targets", len(snap.Entities))
	}
	for _, e := range snap.Entities {
		if e.Kind != protocol.EntityKindTarget {
			t.Fatalf("entity %+v should be a target", e)
		}
	}
	if snap.Health.ProtectedFor != 0 {
		t.Fatalf("no spawn protection in the range, got %v", snap.Health.ProtectedFor)
	}
}

func TestFFARoomHasNoTargets(t *testing.T) {
	s := startServer(t, testCfg{Match: practice()})
	c := s.join(s.createRoomMode("ffa"))
	c.next("welcome")
	snap := c.snapshotUntil(func(protocol.Snapshot) bool { return true })
	if len(snap.Entities) != 0 {
		t.Fatalf("an FFA room has %d entities for a lone player", len(snap.Entities))
	}
}

func TestUnknownModeIsRefused(t *testing.T) {
	s := startServer(t, testCfg{Match: practice()})
	resp, err := http.Post(s.http+"/api/rooms", "application/json", strings.NewReader(`{"mode":"capture-the-flag"}`))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("unknown mode: status %d, want 400", resp.StatusCode)
	}
	bad, _ := http.Post(s.http+"/api/rooms", "application/json", strings.NewReader(`not json`))
	bad.Body.Close()
	if bad.StatusCode != http.StatusBadRequest {
		t.Fatalf("garbage body: status %d, want 400", bad.StatusCode)
	}
	if s.rooms.Count() != 0 {
		t.Fatalf("a refused request still created %d rooms", s.rooms.Count())
	}
}

func TestRoomInfoReportsTheMode(t *testing.T) {
	s := startServer(t, testCfg{Match: practice()})
	code := s.createRoomMode("practice")
	resp, err := http.Get(s.http + "/api/rooms/" + code)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), `"mode":"practice"`) {
		t.Fatalf("room info = %s", body)
	}
}

func TestPracticeCommandsOverTheWire(t *testing.T) {
	s := startServer(t, testCfg{Match: practice()})
	c := s.join(s.createRoomMode("practice"))
	c.next("welcome")

	// Run forward away from the course start, then ask to go back.
	var window []map[string]any
	for seq := uint32(1); seq <= 15; seq++ {
		c.send(map[string]any{"type": "input", "inputs": inputWindow(seq, &window, map[string]any{"moveZ": 1.0})})
		time.Sleep(time.Second / 60)
	}
	c.snapshotUntil(func(s protocol.Snapshot) bool { return s.AckSeq == 15 && s.You.Z < -1 })
	c.send(map[string]any{"type": "practice", "action": "start"})
	c.snapshotUntil(func(s protocol.Snapshot) bool { return s.You.Z == 0 })

	// Unknown actions and the commands in a non-practice room are ignored without harm.
	c.send(map[string]any{"type": "practice", "action": "fly"})
	c.send(map[string]any{"type": "practice", "action": "reset"})
	c.send(map[string]any{"type": "ping", "t": 1})
	c.next("pong")

	ffa := s.join(s.createRoom())
	ffa.next("welcome")
	ffa.send(map[string]any{"type": "practice", "action": "start"})
	ffa.send(map[string]any{"type": "ping", "t": 2})
	ffa.next("pong")
}

func TestWelcomeNamesTheRoomsOwnMap(t *testing.T) {
	ts := startServer(t, testCfg{Match: practice(), MaxRooms: 4})
	// FFA rooms use the level that has no name of its own: they report the server's default.
	ffa := ts.join(ts.createRoomMode("ffa"))
	var w protocol.Welcome
	if err := json.Unmarshal(ffa.next("welcome"), &w); err != nil {
		t.Fatal(err)
	}
	if w.Level != "test" {
		t.Fatalf("ffa welcome level = %q, want the server default \"test\"", w.Level)
	}
	// A practice room runs a different map and must say so, or the client would predict on the wrong one.
	practice := ts.join(ts.createRoomMode("practice"))
	if err := json.Unmarshal(practice.next("welcome"), &w); err != nil {
		t.Fatal(err)
	}
	if w.Level != "range-test" {
		t.Fatalf("practice welcome level = %q, want range-test", w.Level)
	}
}

func TestOtherOriginsAreRefusedUnlessAllowed(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	rooms := NewRooms(ctx, RoomsConfig{Modes: map[string]ModeConfig{ModeFFA: {Level: game.FlatLevel(), Match: practice()}}})
	srv := &Server{
		Rooms: rooms, Codec: wire.JSON{}, LevelName: "test",
		AllowedOrigins: []string{"arena.example.com", "*.pages.example.com"},
	}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	preflight := func(origin string) *http.Response {
		req, _ := http.NewRequest(http.MethodOptions, ts.URL+"/api/rooms", nil)
		req.Header.Set("Origin", origin)
		req.Header.Set("Access-Control-Request-Method", "POST")
		req.Header.Set("Access-Control-Request-Headers", "content-type")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		return res
	}
	for _, origin := range []string{"https://arena.example.com", "https://preview.pages.example.com", "http://localhost:5173"} {
		res := preflight(origin)
		if res.StatusCode != http.StatusNoContent || res.Header.Get("Access-Control-Allow-Origin") != origin {
			t.Fatalf("%s should be allowed: status %d, allow-origin %q", origin, res.StatusCode, res.Header.Get("Access-Control-Allow-Origin"))
		}
	}
	if res := preflight("https://evil.example.org"); res.Header.Get("Access-Control-Allow-Origin") != "" {
		t.Fatalf("an unknown origin got CORS headers: %v", res.Header)
	}

	// The real request carries the header too, and a request with no Origin is left alone.
	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/rooms", nil)
	req.Header.Set("Origin", "https://arena.example.com")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusCreated || res.Header.Get("Access-Control-Allow-Origin") != "https://arena.example.com" {
		t.Fatalf("creating a room from the site: status %d, allow-origin %q", res.StatusCode, res.Header.Get("Access-Control-Allow-Origin"))
	}
	res, err = http.Get(ts.URL + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusOK || res.Header.Get("Access-Control-Allow-Origin") != "" {
		t.Fatalf("a plain request: status %d, allow-origin %q", res.StatusCode, res.Header.Get("Access-Control-Allow-Origin"))
	}
}
