package main

// Hyperliquid frontends harness, feed edition.
//
// One process feeds three benches:
//
//   - № 030 hyperliquid-frontends: per-builder fees, volume, wallets and
//     companions, from the public per-builder daily CSV feed
//     (stats-data.hyperliquid.xyz). No node, no key, no cloud account. Day D
//     is published early on D+1, so the "24h" gauges describe the last
//     complete UTC day and every builder is measured on the same day.
//   - № 035 hyperliquid-hip3-deployers: per-dex volume, markets and open
//     interest from the info API (perpDexs, metaAndAssetCtxs).
//   - № 036 perp-funding: the funding poller in funding.go.
//
// Run flags below; the Dockerfile builds a static binary that listens on
// :2112 and keeps its mirror and state under /data.

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/prometheus/client_golang/prometheus/promhttp"
)

func main() {
	installLogCapture()
	var (
		buildersF    = flag.String("builders", "builders.json", "builders registry")
		metricsAddr  = flag.String("addr", ":2112", "metrics listen addr")
		dataDir      = flag.String("data", "/data", "mirror and state root")
		stateF       = flag.String("state", "", "state file (default <data>/state.json)")
		windowDays   = flag.Int("window-days", 30, "complete UTC days behind the feed day the 30d gauges cover")
		graceDays    = flag.Int("grace-days", 3, "days a missing file is re-requested every pass before a 403 is final")
		minPublished = flag.Int("min-published", 5, "files needed on a day before it counts as published")
		settle       = flag.Duration("settle", 45*time.Minute, "newest file of a day must be older than this before the day is used")
		poll         = flag.Duration("poll", 30*time.Minute, "feed sync interval")
		workers      = flag.Int("workers", 6, "concurrent feed downloads")
		ledgerFrom   = flag.String("ledger-from", "2026-06-01", "oldest day the revenue ledger backfills to (YYYY-MM-DD)")
		hip3Every    = flag.Duration("hip3-every", 10*time.Minute, "HIP-3 info API poll interval (0 disables)")
		fundingEvery = flag.Duration("funding-every", 60*time.Second, "funding poll interval (0 disables)")
	)
	flag.Parse()

	builders, err := loadBuilders(*buildersF)
	if err != nil {
		log.Fatalf("load builders: %v", err)
	}
	log.Printf("loaded %d builders", len(builders))

	if *stateF == "" {
		*stateF = filepath.Join(*dataDir, "state.json")
	}
	mirror, err := newMirror(*dataDir)
	if err != nil {
		log.Fatalf("mirror: %v", err)
	}
	state, err := loadState(*stateF)
	if err != nil {
		log.Fatalf("state: %v", err)
	}
	from, err := time.Parse("2006-01-02", *ledgerFrom)
	if err != nil {
		log.Fatalf("ledger-from: %v", err)
	}

	agg := newAggregator(builders, mirror, state)
	agg.windowDays = *windowDays
	agg.graceDays = *graceDays
	agg.minPublished = *minPublished
	agg.workers = *workers
	agg.ledgerFrom = utcDay(from)
	agg.settle = *settle

	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.Handler())
	mux.Handle("/logs", logsHandler())
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) { fmt.Fprintln(w, "ok") })
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) { fmt.Fprintln(w, "ok") })
	// JSON views consumed by the site's /api/builder/<slug>/{daily-series,
	// top-users} proxies (same shapes the node harness served).
	mux.HandleFunc("/daily-series/", func(w http.ResponseWriter, r *http.Request) {
		slug := strings.TrimPrefix(r.URL.Path, "/daily-series/")
		snap := agg.snapshot(slug)
		if snap == nil {
			http.Error(w, `{"error":"unknown_builder_or_not_ready"}`, http.StatusNotFound)
			return
		}
		writeJSON(w, map[string]any{
			"builder": slug,
			"as_of":   snap.asOf,
			"days":    len(snap.points),
			"points":  snap.points,
		})
	})
	mux.HandleFunc("/top-users/", func(w http.ResponseWriter, r *http.Request) {
		slug := strings.TrimPrefix(r.URL.Path, "/top-users/")
		snap := agg.snapshot(slug)
		if snap == nil {
			http.Error(w, `{"error":"unknown_builder_or_not_ready"}`, http.StatusNotFound)
			return
		}
		writeJSON(w, map[string]any{
			"builder":     slug,
			"as_of":       snap.asOf,
			"total_users": snap.totalUsers,
			"window":      "30d",
			"users":       snap.top,
			"note":        "Wallets ranked by notional over the 30 complete UTC days ending on the feed day. PnL is realized closed_pnl on this frontend's fills only.",
		})
	})
	srv := &http.Server{Addr: *metricsAddr, Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	go func() {
		log.Printf("metrics listening on %s", *metricsAddr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("http: %v", err)
		}
	}()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	if *fundingEvery > 0 {
		go runFundingLoop(ctx, *fundingEvery)
	}
	if *hip3Every > 0 {
		go newHip3Poller(state).run(ctx, *hip3Every)
	}

	// Liveness heartbeat. The specs' success query wants the tick within a
	// short window; the publish loop only runs every -poll, so refresh the
	// tick each minute while the last feed pass was clean and a day is
	// published. A pass with transport failures stops the heartbeat until
	// the next clean one, which is what the success column should show.
	go func() {
		t := time.NewTicker(time.Minute)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				agg.mu.Lock()
				ok := agg.lastSyncOK && !agg.dataDay.IsZero() && agg.initialSyncDone
				agg.mu.Unlock()
				if ok {
					hlLastTickUnix.Set(float64(time.Now().Unix()))
				}
			}
		}
	}()

	go func() {
		// Publish from the on-disk mirror straight away so a restart does
		// not blank the gauges while the first sync runs.
		agg.mu.Lock()
		hasDay := !agg.dataDay.IsZero()
		agg.initialSyncDone = hasDay
		agg.lastSyncOK = hasDay
		agg.mu.Unlock()
		if hasDay {
			agg.publish()
		}
		for {
			agg.syncWindow(ctx)
			agg.publish()
			if ctx.Err() != nil {
				return
			}
			agg.backfillLedger(ctx)
			agg.publish()
			select {
			case <-ctx.Done():
				return
			case <-time.After(*poll):
			}
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop
	log.Printf("shutting down")
	cancel()
	shutCtx, shutCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer shutCancel()
	_ = srv.Shutdown(shutCtx)
	_ = state.save()
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "public, max-age=60")
	_ = json.NewEncoder(w).Encode(v)
}
