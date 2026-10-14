package wire

import (
	"strings"
	"testing"

	"github.com/vmihailenco/msgpack/v5"

	"arena/server/internal/protocol"
)

func TestDecodeInputMessage(t *testing.T) {
	var m protocol.ClientMessage
	data := `{"type":"input","inputs":[` +
		`{"seq":41,"moveX":-1,"moveZ":0.5,"yaw":1.25,"pitch":-0.3,"jump":false,"dash":false,"slide":false,"ads":false},` +
		`{"seq":42,"moveX":-1,"moveZ":0.5,"yaw":1.25,"pitch":-0.3,"jump":true,"dash":true,"slide":true,"ads":true}]}`
	if err := (JSON{}).DecodeClient([]byte(data), &m); err != nil {
		t.Fatal(err)
	}
	if m.Type != protocol.ClientTypeInput || len(m.Inputs) != 2 {
		t.Fatalf("decoded %+v", m)
	}
	want := protocol.Input{Seq: 42, MoveX: -1, MoveZ: 0.5, Yaw: 1.25, Pitch: -0.3, Jump: true, Dash: true, Slide: true, ADS: true}
	if m.Inputs[1] != want {
		t.Fatalf("second input = %+v, want %+v", m.Inputs[1], want)
	}
}

func TestDecodePingResetsPreviousMessage(t *testing.T) {
	var m protocol.ClientMessage
	_ = (JSON{}).DecodeClient([]byte(`{"type":"input","inputs":[{"seq":1}]}`), &m)
	if err := (JSON{}).DecodeClient([]byte(`{"type":"ping","t":1234.5}`), &m); err != nil {
		t.Fatal(err)
	}
	if m.Type != protocol.ClientTypePing || m.T != 1234.5 || len(m.Inputs) != 0 {
		t.Fatalf("stale fields leaked into the next message: %+v", m)
	}
}

func TestRejectsGarbage(t *testing.T) {
	var m protocol.ClientMessage
	if err := (JSON{}).DecodeClient([]byte(`not json`), &m); err == nil {
		t.Fatal("expected an error")
	}
}

func TestEncodeSnapshot(t *testing.T) {
	s := &protocol.Snapshot{
		Type: protocol.ServerTypeSnapshot, Tick: 12, AckSeq: 7, Queued: 1,
		You:      protocol.PlayerState{X: 1.5, Y: 2, Z: -3, OnGround: true, AirJumps: 1},
		Entities: []protocol.Entity{{ID: 2, TeamID: 2, X: 4, Y: 5, Z: 6, Yaw: 0.5, Flags: 16}},
	}
	b, err := (JSON{}).EncodeSnapshot(nil, s)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`"type":"snapshot"`, `"tick":12`, `"ackSeq":7`, `"queued":1`,
		`"you":{"x":1.5,"y":2,"z":-3`, `"onGround":true`, `"airJumps":1`,
		`"entities":[{"id":2,"teamId":2,"x":4,"y":5,"z":6,"yaw":0.5,"pitch":0,"flags":16,"kind":0,"hero":0}]`,
	} {
		if !strings.Contains(string(b), want) {
			t.Errorf("snapshot %s missing %s", b, want)
		}
	}
}

func TestEncodeWelcomeAndPong(t *testing.T) {
	w, _ := (JSON{}).EncodeWelcome(nil, &protocol.Welcome{Type: protocol.ServerTypeWelcome, PlayerID: 3, TickRate: 60, SnapshotRate: 30, Level: "greybox", Room: "K7QWM", MaxPlayers: 8, Mode: "practice"})
	if string(w) != `{"type":"welcome","playerId":3,"tickRate":60,"snapshotRate":30,"level":"greybox","room":"K7QWM","maxPlayers":8,"mode":"practice"}` {
		t.Errorf("welcome = %s", w)
	}
	p, _ := (JSON{}).EncodePong(nil, &protocol.Pong{Type: protocol.ServerTypePong, T: 99.5, Tick: 1000})
	if string(p) != `{"type":"pong","t":99.5,"tick":1000}` {
		t.Errorf("pong = %s", p)
	}
}

func TestMsgPackRoundTripAndCompactness(t *testing.T) {
	msg := &protocol.ClientMessage{Type: protocol.ClientTypeInput, Inputs: []protocol.Input{
		{Seq: 41, MoveX: -1, MoveZ: 0.5, Yaw: 1.25, Pitch: -0.3},
		{Seq: 42, MoveX: -1, MoveZ: 0.5, Yaw: 1.25, Pitch: -0.3, Jump: true, Dash: true},
	}}
	jsonBytes, err := appendJSON(nil, msg)
	if err != nil {
		t.Fatal(err)
	}
	packed, err := appendMsgPack(nil, msg)
	if err != nil {
		t.Fatal(err)
	}
	var got protocol.ClientMessage
	if err := (MsgPack{}).DecodeClient(packed, &got); err != nil {
		t.Fatal(err)
	}
	if got.Type != msg.Type || len(got.Inputs) != len(msg.Inputs) || got.Inputs[1] != msg.Inputs[1] {
		t.Fatalf("round trip = %+v, want %+v", got, *msg)
	}
	if len(packed) >= len(jsonBytes) {
		t.Fatalf("msgpack input was not compact: %d bytes vs JSON welcome %d bytes", len(packed), len(jsonBytes))
	}
}

// A binary frame is an array: the type, then the message's fields in the flat ClientMessage
// order, with empty values for the fields the message does not use.
func TestMsgPackDecodesClientArrays(t *testing.T) {
	enc := func(v any) []byte {
		t.Helper()
		b, err := msgpack.Marshal(v)
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	var m protocol.ClientMessage
	if err := (MsgPack{}).DecodeClient(enc([]any{"ping", []any{}, 0, 12.5, 0, ""}), &m); err != nil {
		t.Fatal(err)
	}
	if m.Type != protocol.ClientTypePing || m.T != 12.5 {
		t.Fatalf("ping decoded as %+v", m)
	}
	if err := (MsgPack{}).DecodeClient(enc([]any{"practice", []any{}, 0, 0, 0, "refill"}), &m); err != nil {
		t.Fatal(err)
	}
	if m.Type != protocol.ClientTypePractice || m.Action != "refill" || m.T != 0 {
		t.Fatalf("practice decoded as %+v", m)
	}
	// Always the whole array: the decoder refuses one of another length, so a client and a
	// server built from different versions of messages.json do not half-understand each other.
	if err := (MsgPack{}).DecodeClient(enc([]any{"respawn"}), &m); err == nil {
		t.Fatal("a short array should be refused")
	}
	if err := (MsgPack{}).DecodeClient(enc([]any{"respawn", []any{}, 0, 0, 0, ""}), &m); err != nil || m.Type != protocol.ClientTypeRespawn {
		t.Fatalf("respawn decoded as %+v (%v)", m, err)
	}
}

// Snapshots travel as datagrams when they fit, so their size matters: a quiet two-player
// snapshot must be well under one datagram.
func TestMsgPackSnapshotFitsADatagram(t *testing.T) {
	s := &protocol.Snapshot{
		Type: protocol.ServerTypeSnapshot, Tick: 123456, AckSeq: 98765, Queued: 2,
		You:      protocol.PlayerState{X: 1.2345, Y: 2.5, Z: -3.75, VX: 4.1, VZ: -2.2, OnGround: true},
		Entities: []protocol.Entity{{ID: 2, TeamID: 2, X: 4.5, Y: 5.25, Z: 6.125, Yaw: 0.5, Pitch: -0.1, Flags: 16}},
		Scores:   []protocol.Score{{ID: 1, Kills: 3, Deaths: 1}, {ID: 2, Kills: 1, Deaths: 3}},
	}
	b, err := (MsgPack{}).EncodeSnapshot(nil, s)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("a quiet two-player snapshot is %d bytes", len(b))
	if len(b) > 450 {
		t.Fatalf("a quiet two-player snapshot is %d bytes: too big to leave room in a datagram", len(b))
	}
}
