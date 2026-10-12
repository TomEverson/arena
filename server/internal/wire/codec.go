// Package wire defines how messages are encoded on the socket.
// The Codec interface lets us swap JSON for a binary format later without
// touching the game or server code. The future source of truth for message
// shapes is /protocol.
package wire

import (
	"encoding/json"

	"arena/server/internal/game"
)

// Codec encodes server->client messages and decodes client->server ones.
// Encode methods append to dst so callers can reuse buffers.
type Codec interface {
	// Binary reports whether frames should be sent as binary WebSocket frames.
	Binary() bool
	EncodeWelcome(dst []byte, playerID uint32) ([]byte, error)
	EncodeSnapshot(dst []byte, s *game.Snapshot) ([]byte, error)
	DecodeInput(data []byte, in *game.Input) error
}

// JSON is the human-readable development codec.
type JSON struct{}

func (JSON) Binary() bool { return false }

type welcomeMsg struct {
	Type         string `json:"type"`
	PlayerID     uint32 `json:"playerId"`
	TickRate     int    `json:"tickRate"`
	SnapshotRate int    `json:"snapshotRate"`
}

type snapshotMsg struct {
	Type     string        `json:"type"`
	Tick     uint64        `json:"tick"`
	AckSeq   uint32        `json:"ackSeq"`
	Entities []game.Entity `json:"entities"`
}

func (JSON) EncodeWelcome(dst []byte, playerID uint32) ([]byte, error) {
	b, err := json.Marshal(welcomeMsg{"welcome", playerID, game.TickRate, game.SnapshotRate})
	return append(dst, b...), err
}

func (JSON) EncodeSnapshot(dst []byte, s *game.Snapshot) ([]byte, error) {
	b, err := json.Marshal(snapshotMsg{"snapshot", s.Tick, s.AckSeq, s.Entities})
	return append(dst, b...), err
}

func (JSON) DecodeInput(data []byte, in *game.Input) error {
	return json.Unmarshal(data, in)
}
