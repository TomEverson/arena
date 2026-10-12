// Command server runs the authoritative game server.
package main

import (
	"context"
	"errors"
	"flag"
	"log"
	"net/http"
	"os/signal"
	"syscall"
	"time"

	"arena/server/internal/game"
	"arena/server/internal/gameserver"
	"arena/server/internal/netsim"
	"arena/server/internal/wire"
)

func main() {
	addr := flag.String("addr", ":8080", "listen address")
	latency := flag.Duration("fake-latency", 0, "added one-way latency on every packet, both directions (e.g. 80ms)")
	loss := flag.String("loss", "0%", "random packet loss, both directions (e.g. 3%)")
	flag.Parse()

	lossFrac, err := netsim.ParseLoss(*loss)
	if err != nil {
		log.Fatal(err)
	}
	link := netsim.Link{Latency: *latency, Loss: lossFrac}
	if link.Active() {
		log.Printf("fake network: latency=%v loss=%.1f%%", link.Latency, link.Loss*100)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	world := game.NewWorld()
	ticker := time.NewTicker(time.Second / game.TickRate)
	defer ticker.Stop()
	go world.Run(ctx, ticker.C)

	srv := &gameserver.Server{World: world, Codec: wire.JSON{}, Link: link}
	httpSrv := &http.Server{Addr: *addr, Handler: srv.Handler()}

	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = httpSrv.Shutdown(shutdownCtx)
	}()

	log.Printf("listening on %s (tick %d Hz, snapshots %d Hz)", *addr, game.TickRate, game.SnapshotRate)
	if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}
