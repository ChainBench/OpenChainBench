package main

// main.go: process entrypoint: signal handling, the metrics HTTP server
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
	st      *pairState
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
	// The windows come back from disk if they were saved. Open interest is
	// the one input no source can backfill: a venue publishes the book it
	// holds now, never the one it held at four this morning. Without this a
	// redeploy divided a full 24h of liquidations by the peak of the minutes
	// since boot, which is how Gains ETH published 952% on 2026-09-28.
	state := newOIStateStore(cfg.StatePath)
	nowMs := time.Now().UnixMilli()
	restoredOI := make(map[string]int, len(cfg.Pairs))
	restoredLiq := make(map[string]int, len(cfg.Pairs))

	pairs := make([]*pairRuntime, 0, len(cfg.Pairs))
	venues := make(map[string]bool, 8)
	for _, va := range cfg.Pairs {
		st := newPairState()
		key := oiStateKey(va.Venue, va.Asset)
		restoredOI[key] = state.restore(va.Venue, va.Asset, st.oi, nowMs)
		restoredLiq[key] = state.restoreLiq(va.Venue, va.Asset, st, nowMs)
		pairs = append(pairs, &pairRuntime{
			va:      va,
			st:      st,
			sinceMs: startBackfillMs,
		})
		venues[va.Venue] = true
	}
	state.logRestore(pairs, restoredOI, restoredLiq)

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
				// The high-water mark only advances on success, so a pair
				// that has been failing asks for an ever-longer range. Rows
				// older than the window are dropped on arrival anyway, so
				// the fetch never needs to reach further back than the
				// window edge; without this floor a page-cap refusal on a
				// long-failing pair repeats on every tick until a restart.
				since := p.sinceMs
				if floor := tickStartMs - windowSpan.Milliseconds(); since < floor {
					since = floor
				}
				ok := runTick(p.va, p.st, since, cfg.TickInterval)
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
		// Warm-up: a venue is warming up while any of its rows holds fewer
		// open-interest readings than the rank gate divides by. Every
		// liquidation source backfills its full window on the first tick,
		// so the numerator is whole from the start; the denominator is what
		// fills, one reading per tick, and the rate is not published until
		// it has. The flag therefore reads 1 exactly while the venue's rate
		// is held, and 0 once it publishes.
		venueWarm := make(map[string]bool, len(venues))
		for venue := range venues {
			venueWarm[venue] = true
		}
		for _, p := range pairs {
			if p.st.oi.Len() < minOISamples {
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
		// Realized vol is asset-level (not venue-specific). Fetch once per asset.
		assetsPublished := make(map[string]bool)
		for _, p := range pairs {
			if assetsPublished[p.va.Asset] {
				continue
			}
			assetsPublished[p.va.Asset] = true
			go func(asset string) {
				vol, err := fetchRealizedVol24h(asset)
				if err != nil {
					log.Printf("[vol/%s] realized vol error: %v", asset, err)
					return
				}
				if vol > 0 {
					realizedVol.WithLabelValues(asset).Set(vol)
				}
			}(p.va.Asset)
		}

		// Save after the tick, so a restart resumes from at most one tick
		// ago rather than from nothing.
		state.save(pairs, now)

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
