// Command server runs the authoritative game server.
package main

import (
	"context"
	"errors"
	"flag"
	"log"
	"net/http"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"arena/server/internal/game"
	"arena/server/internal/gameserver"
	"arena/server/internal/level"
	"arena/server/internal/netsim"
	"arena/server/internal/wire"
)

func main() {
	addr := flag.String("addr", ":8080", "listen address")
	latency := flag.Duration("fake-latency", 0, "added one-way latency on every packet, both directions (e.g. 80ms)")
	loss := flag.String("loss", "0%", "random packet loss, both directions (e.g. 3%)")
	levelPath := flag.String("level", "../levels/ffa.json", "level JSON for FFA rooms (relative to the working directory)")
	practiceLevelPath := flag.String("practice-level", "../levels/greybox.json", "level JSON for practice ranges")
	noMatch := flag.Bool("no-match", false, "FFA rooms are always live: no waiting, countdown, timer or results")
	countdown := flag.Duration("countdown", time.Duration(game.MatchCountdownSeconds*float64(time.Second)), "countdown before a match")
	length := flag.Duration("match-length", time.Duration(game.MatchLengthSeconds*float64(time.Second)), "length of a match")
	results := flag.Duration("results", time.Duration(game.MatchResultsSeconds*float64(time.Second)), "how long the results show before the next match")
	roomIdle := flag.Duration("room-idle", time.Minute, "how long an empty room is kept")
	allowedOrigins := flag.String("allowed-origins", "", "comma-separated host names the client may be served from besides localhost (e.g. arena.example.com,*.example.com)")
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

	// Levels are read once, here: a changed level file takes effect only after a server restart.
	lv, err := level.Load(*levelPath)
	if err != nil {
		log.Fatalf("loading level %q: %v (pass --level=<path>)", *levelPath, err)
	}
	log.Printf("level %s: %d boxes, %d ramps, %d spawns", *levelPath, len(lv.Collision.Boxes), len(lv.Collision.Ramps), len(lv.Spawns))

	cfg := game.DefaultMatchConfig()
	cfg.Enabled = !*noMatch
	cfg.Countdown, cfg.Length, cfg.Results = countdown.Seconds(), length.Seconds(), results.Seconds()
	if cfg.Enabled {
		log.Printf("match: %v countdown, %v long, %v results, %d to %d players", *countdown, *length, *results, cfg.MinPlayers, cfg.Capacity)
	} else {
		log.Printf("no match cycle: FFA rooms are always live")
	}

	practiceLevel := lv
	if *practiceLevelPath != *levelPath {
		if practiceLevel, err = level.Load(*practiceLevelPath); err != nil {
			log.Fatalf("loading practice level %q: %v", *practiceLevelPath, err)
		}
	}
	rangeCfg := cfg // a practice range is always live, with the same room size
	rangeCfg.Enabled = false
	rooms := gameserver.NewRooms(ctx, gameserver.RoomsConfig{
		Modes: map[string]gameserver.ModeConfig{
			gameserver.ModeFFA:      {Level: lv, Match: cfg},
			gameserver.ModePractice: {Level: practiceLevel, Match: rangeCfg, Practice: true},
		},
		EmptyTimeout: *roomIdle,
	})
	srv := &gameserver.Server{
		Rooms:     rooms,
		Codec:     wire.MsgPack{},
		Link:      link,
		LevelName: strings.TrimSuffix(filepath.Base(*levelPath), ".json"),
	}
	for _, host := range strings.Split(*allowedOrigins, ",") {
		if host = strings.TrimSpace(host); host != "" {
			srv.AllowedOrigins = append(srv.AllowedOrigins, host)
		}
	}
	if len(srv.AllowedOrigins) > 0 {
		log.Printf("allowed origins: %s (and localhost)", strings.Join(srv.AllowedOrigins, ", "))
	}
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
