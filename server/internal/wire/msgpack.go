package wire

import (
	"bytes"

	"github.com/vmihailenco/msgpack/v5"

	"arena/server/internal/protocol"
)

// MsgPack is the production binary codec. It uses the generated JSON field names so the
// TypeScript client can decode the same protocol objects without a second schema.
type MsgPack struct{}

func (MsgPack) Binary() bool { return true }

func appendMsgPack(dst []byte, value any) ([]byte, error) {
	var buf bytes.Buffer
	enc := msgpack.NewEncoder(&buf)
	enc.SetCustomStructTag("json")
	if err := enc.Encode(value); err != nil {
		return dst, err
	}
	return append(dst, buf.Bytes()...), nil
}

func (MsgPack) EncodeWelcome(dst []byte, m *protocol.Welcome) ([]byte, error) {
	return appendMsgPack(dst, m)
}

func (MsgPack) EncodeSnapshot(dst []byte, m *protocol.Snapshot) ([]byte, error) {
	return appendMsgPack(dst, m)
}

func (MsgPack) EncodePong(dst []byte, m *protocol.Pong) ([]byte, error) {
	return appendMsgPack(dst, m)
}

func (MsgPack) DecodeClient(data []byte, m *protocol.ClientMessage) error {
	dec := msgpack.NewDecoder(bytes.NewReader(data))
	dec.SetCustomStructTag("json")
	*m = protocol.ClientMessage{}
	return dec.Decode(m)
}
