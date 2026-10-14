package gameserver

import (
	"bufio"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"io"
	"log"
	"math/big"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/quic-go/quic-go"
	"github.com/quic-go/quic-go/http3"
	"github.com/quic-go/webtransport-go"
)

// The WebTransport transport: QUIC over UDP, what browsers play over. One session per player,
// at https://<host>:<port>/wt?room=<code>. Inside it (client/src/net/webtransport.ts is the
// other half):
//
//   - One bidirectional stream, opened by the client, carries the messages that must arrive:
//     the welcome down; hero, respawn, rematch and practice requests up. Each is a 4-byte
//     big-endian length and then the message. The client's first frame is empty (a stream only
//     exists once something is written on it).
//   - Datagrams carry the messages that may be lost: snapshots and pongs down, inputs and pings
//     up. One message per datagram. A lost one is never waited for: the next snapshot carries
//     whatever was not acknowledged, and inputs are sent several times over.
//   - A message too big for a datagram goes on a one-way stream of its own, closed after it.
//     Streams do not block each other, so it still never holds anything else up.

const (
	// maxDatagram is the biggest message sent as a datagram: a QUIC packet carries about 1200
	// bytes, less its own headers.
	maxDatagram = 1100
	// maxMessage bounds a reliable frame or a one-message stream from a client.
	maxMessage = 64 << 10
)

type wtServer struct {
	server *webtransport.Server
	port   int
	// certHash is the base64 SHA-256 of the self-signed development certificate, which a browser
	// accepts by this hash; empty with a real certificate.
	certHash string
}

// DevCertificate makes a self-signed certificate for local development. Browsers accept one by
// its hash for WebTransport, if it is ECDSA and valid for less than two weeks: it is made anew
// at every start and its hash handed out by /api/transport.
func DevCertificate() (tls.Certificate, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 62))
	if err != nil {
		return tls.Certificate{}, err
	}
	now := time.Now()
	template := &x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: "arena dev"},
		NotBefore:    now.Add(-time.Hour),
		NotAfter:     now.Add(13 * 24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames:     []string{"localhost"},
		IPAddresses:  []net.IP{net.IPv4(127, 0, 0, 1), net.IPv6loopback},
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		return tls.Certificate{}, err
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}, nil
}

// ServeWebTransport serves the WebTransport transport on a UDP socket: it sets it up at once
// (so /api/transport can answer) and returns the function that runs it until ctx ends. With
// `selfSigned` the certificate is a development one and its hash is published for browsers;
// otherwise it must be a real certificate for the host name players connect to.
func (s *Server) ServeWebTransport(conn net.PacketConn, cert tls.Certificate, selfSigned bool) (run func(ctx context.Context) error) {
	// Everything the TCP side answers is answered here too. A browser that has learnt this host
	// speaks HTTP/3 (from this server, or from whatever stood on the port before) sends its
	// ordinary requests (the room API) over QUIC as well, to this same port.
	mux := http.NewServeMux()
	mux.Handle("/", s.Handler())
	mux.HandleFunc("/wt", s.handleWT)
	h3 := &http3.Server{
		Handler:   mux,
		TLSConfig: &tls.Config{Certificates: []tls.Certificate{cert}, NextProtos: []string{http3.NextProtoH3}},
		QUICConfig: &quic.Config{
			EnableDatagrams:                  true,
			EnableStreamResetPartialDelivery: true,
			MaxIdleTimeout:                   20 * time.Second,
			KeepAlivePeriod:                  5 * time.Second,
		},
	}
	webtransport.ConfigureHTTP3Server(h3)
	wt := &wtServer{
		server: &webtransport.Server{
			H3: h3,
			// A browser page must come from an allowed site; other programs send no Origin.
			CheckOrigin: func(r *http.Request) bool {
				origin := r.Header.Get("Origin")
				return origin == "" || s.originAllowed(origin)
			},
		},
	}
	if addr, ok := conn.LocalAddr().(*net.UDPAddr); ok {
		wt.port = addr.Port
	}
	if selfSigned {
		sum := sha256.Sum256(cert.Certificate[0])
		wt.certHash = base64.StdEncoding.EncodeToString(sum[:])
	}
	s.wt = wt
	return func(ctx context.Context) error {
		go func() {
			<-ctx.Done()
			_ = wt.server.Close()
		}()
		err := wt.server.Serve(conn)
		if ctx.Err() != nil {
			return nil
		}
		return err
	}
}

// handleTransport tells a page how to reach the game transport: the UDP port for WebTransport,
// and the development certificate's hash when there is one. "webtransport" is null when it is off.
func (s *Server) handleTransport(w http.ResponseWriter, _ *http.Request) {
	if s.wt == nil {
		writeJSON(w, http.StatusOK, map[string]any{"webtransport": nil})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"webtransport": map[string]any{"port": s.wt.port, "certHash": s.wt.certHash},
	})
}

// wtLink is one WebTransport session.
type wtLink struct {
	session *webtransport.Session
	mu      sync.Mutex // one reliable frame at a time on the control stream
	control *webtransport.Stream
}

func (l *wtLink) sendReliable(frame []byte) {
	var head [4]byte
	binary.BigEndian.PutUint32(head[:], uint32(len(frame)))
	l.mu.Lock()
	defer l.mu.Unlock()
	_ = l.control.SetWriteDeadline(time.Now().Add(5 * time.Second))
	if _, err := l.control.Write(head[:]); err == nil {
		_, _ = l.control.Write(frame)
	}
}

func (l *wtLink) sendLossy(frame []byte) {
	// The caller reuses its buffer; the session keeps what it is given until it is sent.
	own := append([]byte(nil), frame...)
	if len(own) <= maxDatagram && l.session.SendDatagram(own) == nil {
		return
	}
	// Too big for one packet: a stream of its own. If one cannot be opened right now (too many
	// still on their way), this message is simply lost, as a datagram could have been.
	str, err := l.session.OpenUniStream()
	if err != nil {
		return
	}
	go func() {
		_ = str.SetWriteDeadline(time.Now().Add(time.Second))
		if _, err := str.Write(own); err != nil {
			str.CancelWrite(0)
			return
		}
		_ = str.Close()
	}()
}

func (s *Server) handleWT(w http.ResponseWriter, r *http.Request) {
	room := s.Rooms.Get(strings.ToUpper(r.URL.Query().Get("room")))
	session, err := s.wt.server.Upgrade(w, r)
	if err != nil {
		log.Printf("webtransport upgrade: %v", err)
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	// Refusals are session close codes, the same numbers the WebSocket uses.
	if room == nil {
		_ = session.CloseWithError(webtransport.SessionErrorCode(CloseRoomNotFound), "room not found")
		return
	}
	if !room.reserve() {
		_ = session.CloseWithError(webtransport.SessionErrorCode(CloseRoomFull), "room full")
		return
	}
	defer room.release()
	defer func() { _ = session.CloseWithError(0, "") }()

	ctx, cancel := context.WithCancel(session.Context())
	defer cancel()

	// The client opens the control stream; nothing happens until it has.
	openCtx, openCancel := context.WithTimeout(ctx, 10*time.Second)
	control, err := session.AcceptStream(openCtx)
	openCancel()
	if err != nil {
		return
	}
	onMessage, leave, err := s.play(ctx, room, &wtLink{session: session, control: control})
	if err != nil {
		log.Printf("encode welcome: %v", err)
		return
	}
	defer leave()

	// Datagrams: inputs and pings.
	go func() {
		for {
			data, err := session.ReceiveDatagram(ctx)
			if err != nil {
				return
			}
			onMessage(data)
		}
	}()
	// One-message streams: anything that was too big for a datagram.
	go func() {
		for {
			str, err := session.AcceptUniStream(ctx)
			if err != nil {
				return
			}
			go func() {
				_ = str.SetReadDeadline(time.Now().Add(5 * time.Second))
				data, err := io.ReadAll(io.LimitReader(str, maxMessage+1))
				if err == nil && len(data) > 0 && len(data) <= maxMessage {
					onMessage(data)
				}
			}()
		}
	}()
	// The control stream: reliable requests, until the session ends.
	in := bufio.NewReader(control)
	var head [4]byte
	for {
		if _, err := io.ReadFull(in, head[:]); err != nil {
			return
		}
		size := binary.BigEndian.Uint32(head[:])
		if size > maxMessage {
			_ = session.CloseWithError(1, "frame too big")
			return
		}
		if size == 0 {
			continue // the frame that opened the stream
		}
		data := make([]byte, size)
		if _, err := io.ReadFull(in, data); err != nil {
			if !errors.Is(err, io.EOF) {
				log.Printf("webtransport control stream: %v", err)
			}
			return
		}
		onMessage(data)
	}
}
