package wire

import (
	"strings"
	"testing"

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
		`"entities":[{"id":2,"teamId":2,"x":4,"y":5,"z":6,"yaw":0.5,"pitch":0,"flags":16,"kind":0}]`,
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
