// Package wire defines how messages are encoded on the socket.
// The Codec interface keeps the game independent from the production binary format and the
// human-readable JSON test codec. The message shapes themselves are generated
// from /protocol/messages.json (package protocol).
package wire

import (
	"encoding/json"

	"arena/server/internal/protocol"
)

// Codec encodes server->client messages and decodes client->server ones.
// Encode methods append to dst so callers can reuse buffers.
type Codec interface {
	// Binary reports whether frames should be sent as binary WebSocket frames.
	Binary() bool
	EncodeWelcome(dst []byte, m *protocol.Welcome) ([]byte, error)
	EncodeSnapshot(dst []byte, m *protocol.Snapshot) ([]byte, error)
	EncodePong(dst []byte, m *protocol.Pong) ([]byte, error)
	// DecodeClient decodes any client message into m (m is reset first).
	DecodeClient(data []byte, m *protocol.ClientMessage) error
}

// JSON is the human-readable development codec.
type JSON struct{}

func (JSON) Binary() bool { return false }

func appendJSON(dst []byte, v any) ([]byte, error) {
	b, err := json.Marshal(v)
	return append(dst, b...), err
}

func (JSON) EncodeWelcome(dst []byte, m *protocol.Welcome) ([]byte, error) {
	return appendJSON(dst, m)
}

func (JSON) EncodeSnapshot(dst []byte, m *protocol.Snapshot) ([]byte, error) {
	return appendJSON(dst, m)
}

func (JSON) EncodePong(dst []byte, m *protocol.Pong) ([]byte, error) {
	return appendJSON(dst, m)
}

func (JSON) DecodeClient(data []byte, m *protocol.ClientMessage) error {
	*m = protocol.ClientMessage{}
	return json.Unmarshal(data, m)
}
