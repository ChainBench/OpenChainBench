package main

// main.go — process entrypoint: signal handling, the metrics HTTP server
// goroutine, and the tick loop that fans out per-venue-asset goroutines.

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"
)

// pairRuntime carries the cross-tick state of one venue+asset pair.
type pairRuntime struct {
	va      VenueAsset
	window  *SlidingWindow
	seen    *SeenSet
	sinceMs int64 // high-water mark for FetchLiquidationsSince
}

func main() {
	log.SetOutput(os.Stdout)
	log.SetFlags(log.LstdFlags | log.Lmicroseconds | log.LUTC)

	cfg, err := loadConfig()
	if err != nil {
		log.Fatalf("config: %v", err)
	}
	log.Printf("perp-liq-rate starting: %d venue/asset pairs, tick=%s, listen=%s",
		len(cfg.Pairs), cfg.TickInterval, cfg.ListenAddr)

	reg := registerMetrics()
	mux := http.NewServeMux()
	mux.Handle("/metrics", metricsHandler(reg))
	mux.HandleFunc("/health", func(rw http.ResponseWriter, _ *http.Request) {
		rw.WriteHeader(http.StatusOK)
		_, _ = rw.Write([]byte("ok\n"))
	})
	srv := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	go func() {
		log.Printf("metrics server listening on %s", cfg.ListenAddr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("metrics server: %v", err)
		}
	}()

	// Build per-pair runtime state. The initial since is now-24h so venues
	// with historical endpoints backfill the full window on the first tick.
	startBackfillMs := time.Now().Add(-windowSpan).UnixMilli()
	pairs := make([]*pairRuntime, 0, len(cfg.Pairs))
	venues := make(map[string]bool, 8)
	for _, va := range cfg.Pairs {
		pairs = append(pairs, &pairRuntime{
			va:      va,
			window:  NewSlidingWindow(windowSpan),
			seen:    NewSeenSet(),
			sinceMs: startBackfillMs,
		})
		venues[va.Venue] = true
	}

	// Before the first tick completes, every venue is warming up.
	for venue := range venues {
		setVenueWarming(venue, true)
	}

	runOnce := func() {
		tickStart := time.Now()
		tickStartMs := tickStart.UnixMilli()

		// Venue-level success aggregation across its asset goroutines.
		venueOK := make(map[string]bool, len(venues))
		var mu sync.Mutex
		var wg sync.WaitGroup

		for _, p := range pairs {
			wg.Add(1)
			go func(p *pairRuntime) {
				defer wg.Done()
				ok := runTick(p.va, p.window, p.seen, p.sinceMs)
				if ok {
					// Next tick fetches from the start of this one; the
					// overlap is harmless because of the SeenSet dedup.
					p.sinceMs = tickStartMs
				}
				mu.Lock()
				if prev, present := venueOK[p.va.Venue]; present {
					venueOK[p.va.Venue] = prev && ok
				} else {
					venueOK[p.va.Venue] = ok
				}
				mu.Unlock()
			}(p)
		}
		wg.Wait()

		now := time.Now()
		// Warm-up: a venue is warm once every one of its windows has seen a
		// full 24h since its first tick (they all start together, so this is
		// effectively "24h since the venue's first tick").
		venueWarm := make(map[string]bool, len(venues))
		for venue := range venues {
			venueWarm[venue] = true
		}
		for _, p := range pairs {
			if !p.window.IsWarm(now) {
				venueWarm[p.va.Venue] = false
			}
		}
		for venue, allOK := range venueOK {
			setVenueHealth(venue, allOK)
			if allOK {
				setVenueRefreshed(venue, now)
			}
			setVenueWarming(venue, !venueWarm[venue])
		}
		log.Printf("tick complete in %s", time.Since(tickStart).Round(time.Millisecond))
	}

	ticker := time.NewTicker(cfg.TickInterval)
	defer ticker.Stop()

	runOnce()
	for {
		select {
		case <-ctx.Done():
			log.Printf("shutdown signal received, stopping")
			shCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if err := srv.Shutdown(shCtx); err != nil {
				log.Printf("metrics server shutdown: %v", err)
			}
			return
		case <-ticker.C:
			runOnce()
		}
	}
}
