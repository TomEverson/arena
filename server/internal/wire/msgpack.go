package wire

import (
	"bytes"

	"github.com/vmihailenco/msgpack/v5"

	"arena/server/internal/protocol"
)

// MsgPack is the production binary codec. Every struct is an array of its fields in declaration
// order, with no field names on the wire: a snapshot is about a third the size it was as a map,
// which is what lets most of them fit in one datagram. The TypeScript client has the same field
// order, generated from protocol/messages.json (LAYOUTS in protocol.gen.ts).
type MsgPack struct{}

func (MsgPack) Binary() bool { return true }

func appendMsgPack(dst []byte, value any) ([]byte, error) {
	var buf bytes.Buffer
	enc := msgpack.NewEncoder(&buf)
	enc.SetCustomStructTag("json")
	enc.UseArrayEncodedStructs(true)
	// The smallest form of every number: a zero or whole-valued float is one byte, not nine.
	enc.UseCompactInts(true)
	enc.UseCompactFloats(true)
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
